/**
 * The second half of the daily check: promotions that are ending or already over,
 * alerts that should disappear once the underlying problem is fixed, and the archival
 * sweeps. None of it is visible in the response beyond a `cleaned` count, so these
 * tests assert on the writes themselves.
 */
const request = require('supertest');
const { registerNotificationRoutes } = require('../../routes/notificationRoutes');
const { createMockSupabase, filterArgs } = require('../helpers/mockSupabase');
const { createTestApp, allowAccess, STORE_ID, storeHeader } = require('../helpers/testApp');

// Wed 12 Mar 2025, 10:00 Bangkok.
const FIXED_NOW = Date.UTC(2025, 2, 12, 3, 0, 0);
const TODAY = '2025-03-12';

describe('routes/notificationRoutes maintenance sweeps', () => {
    let supabaseAdmin;
    let upsertNotificationGlobal;
    let errorSpy;
    let logSpy;
    let nowSpy;

    beforeEach(() => {
        supabaseAdmin = createMockSupabase();
        upsertNotificationGlobal = jest.fn(async () => true);
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        nowSpy = jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
        jest.useFakeTimers({
            doNotFake: [
                'Date', 'setTimeout', 'clearTimeout', 'setImmediate', 'clearImmediate',
                'nextTick', 'queueMicrotask', 'performance', 'hrtime',
                'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback'
            ]
        });
    });

    afterEach(() => {
        jest.useRealTimers();
        errorSpy.mockRestore();
        logSpy.mockRestore();
        nowSpy.mockRestore();
    });

    const app = () => createTestApp(registerNotificationRoutes,
        { supabaseAdmin, checkStoreAccess: allowAccess, upsertNotificationGlobal });

    /**
     * Wire up the tables the daily check reads. `batches` serves the expired sweep on
     * the first read and the near-expiry sweep on the second, matching the route order.
     */
    function withScan({ expired = [], nearExpiry = [], debts = [], promos = [], notifs = [], products = [], oldProducts = [], oldBatches = [] } = {}) {
        let batchReads = 0;
        supabaseAdmin.onDefault(() => ({ data: [], error: null, count: 0 }));
        supabaseAdmin.on('product_batches', (state) => {
            if (state.op !== 'select') return { data: [], error: null };
            // The two-year purge is the only batch read asking for empty batches.
            const isPurgeSweep = filterArgs(state, 'eq').some(([col, v]) => col === 'remaining_qty' && v === 0);
            if (isPurgeSweep) return { data: oldBatches, error: null };
            batchReads += 1;
            return { data: batchReads === 1 ? expired : nearExpiry, error: null };
        });
        supabaseAdmin.on('credit_accounts', { data: debts, error: null });
        supabaseAdmin.on('promotions', { data: promos, error: null });
        supabaseAdmin.on('notifications', (state) => (state.op === 'select'
            ? { data: notifs, error: null }
            : { data: null, error: null, count: 0 }));
        supabaseAdmin.on('products', (state) => {
            if (state.op !== 'select') return { data: [], error: null };
            // The stale-alert check reads stock levels; the archive sweep asks for
            // rows whose deleted_at is set.
            const looksLikeArchiveSweep = state.filters.some((f) => f.name === 'not');
            return { data: looksLikeArchiveSweep ? oldProducts : products, error: null };
        });
    }

    const runCheck = () => request(app()).post('/api/notifications/daily-check').set(storeHeader);

    /**
     * The deletes that clear resolved alerts, told apart from the unrelated sweep of
     * notifications past their expires_at by the `in('id', ...)` filter.
     */
    const resolvedAlertDeletes = () => supabaseAdmin.callsForOp('notifications', 'delete')
        .filter((c) => c.filters.some((f) => f.name === 'in'));

    describe('promotions that are ending', () => {
        it('warns that a promotion ends today', async () => {
            withScan({ promos: [{ id: 'promo-1', name: 'ลดล้างสต็อก', end_date: TODAY }] });

            const res = await runCheck();

            expect(res.body.results.promoEnding).toBe(1);
            const [args] = upsertNotificationGlobal.mock.calls;
            expect(args[1]).toBe('promo_ending');
            expect(args[3]).toContain('หมดอายุวันนี้');
            expect(args[7]).toBe('promotion');
        });

        it('warns that a promotion ends tomorrow', async () => {
            withScan({ promos: [{ id: 'promo-1', name: 'ลด 20%', end_date: '2025-03-13' }] });

            await runCheck();

            expect(upsertNotificationGlobal.mock.calls[0][3]).toContain('หมดอายุพรุ่งนี้');
        });

        it('counts the days out for a promotion ending later', async () => {
            withScan({ promos: [{ id: 'promo-1', name: 'ลด 20%', end_date: '2025-03-14' }] });

            await runCheck();

            expect(upsertNotificationGlobal.mock.calls[0][3]).toContain('หมดอายุใน 2 วัน');
        });

        it('carries the promotion id and end date in the payload', async () => {
            withScan({ promos: [{ id: 'promo-9', name: 'x', end_date: '2025-03-13' }] });

            await runCheck();

            expect(upsertNotificationGlobal.mock.calls[0][8]).toMatchObject({
                promotion_id: 'promo-9', end_date: '2025-03-13', days_left: 1
            });
        });

        it('looks only two days ahead', async () => {
            withScan();

            await runCheck();

            const [read] = supabaseAdmin.callsForOp('promotions', 'select');
            expect(filterArgs(read, 'gte')).toContainEqual(['end_date', TODAY]);
            expect(filterArgs(read, 'lte')).toContainEqual(['end_date', '2025-03-14']);
        });

        it('does not count a warning the store has already seen', async () => {
            upsertNotificationGlobal.mockResolvedValue(false);
            withScan({ promos: [{ id: 'promo-1', name: 'x', end_date: TODAY }] });

            const res = await runCheck();

            expect(res.body.results.promoEnding).toBe(0);
        });
    });

    describe('promotions that are already over', () => {
        it('switches off a promotion whose end date has passed and counts it', async () => {
            supabaseAdmin.onDefault(() => ({ data: [], error: null, count: 0 }));
            supabaseAdmin.on('promotions', (state) => (state.op === 'update'
                ? { data: [{ id: 'promo-old' }, { id: 'promo-older' }], error: null }
                : { data: [], error: null }));

            const res = await runCheck();

            const [update] = supabaseAdmin.callsForOp('promotions', 'update');
            expect(update.payload).toEqual({ is_active: false });
            expect(filterArgs(update, 'eq')).toContainEqual(['is_active', true]);
            expect(filterArgs(update, 'lt')).toContainEqual(['end_date', TODAY]);
            expect(res.body.results.cleaned).toBe(2);
        });

        it('touches nothing when every promotion is still in date', async () => {
            withScan();

            const res = await runCheck();

            expect(res.body.results.cleaned).toBe(0);
        });
    });

    describe('alerts that no longer apply', () => {
        it('clears an expired-stock alert once the batch is gone', async () => {
            withScan({ notifs: [{ id: 'n1', type: 'stock_expired', reference_id: 'batch-gone' }] });

            const res = await runCheck();

            const [del] = resolvedAlertDeletes();
            expect(filterArgs(del, 'in')).toContainEqual(['id', ['n1']]);
            expect(res.body.results.cleaned).toBe(1);
        });

        it('keeps an expired-stock alert while the batch is still expired', async () => {
            withScan({
                expired: [{ id: 'b1', batch_no: 'L', expire_date: '2025-03-01', remaining_qty: 2, products: { id: 'p1', name: 'A', store_id: STORE_ID } }],
                notifs: [{ id: 'n1', type: 'stock_expired', reference_id: 'b1' }]
            });

            const res = await runCheck();

            expect(resolvedAlertDeletes()).toHaveLength(0);
            expect(res.body.results.cleaned).toBe(0);
        });

        it('keeps a near-expiry alert while the batch is still near expiry', async () => {
            withScan({
                nearExpiry: [{ id: 'b2', batch_no: 'L', expire_date: '2025-03-14', remaining_qty: 2, products: { id: 'p1', name: 'A', store_id: STORE_ID } }],
                notifs: [{ id: 'n1', type: 'stock_near_expiry', reference_id: 'b2' }]
            });

            const res = await runCheck();

            expect(res.body.results.cleaned).toBe(0);
        });

        it('keeps a near-expiry alert for a batch that has since expired', async () => {
            // The batch moved from one bucket to the other; the alert is still valid.
            withScan({
                expired: [{ id: 'b2', batch_no: 'L', expire_date: '2025-03-01', remaining_qty: 2, products: { id: 'p1', name: 'A', store_id: STORE_ID } }],
                notifs: [{ id: 'n1', type: 'stock_near_expiry', reference_id: 'b2' }]
            });

            const res = await runCheck();

            expect(res.body.results.cleaned).toBe(0);
        });

        it('clears a near-expiry alert once the batch is neither near expiry nor expired', async () => {
            withScan({ notifs: [{ id: 'n1', type: 'stock_near_expiry', reference_id: 'batch-sold-out' }] });

            const res = await runCheck();

            expect(filterArgs(resolvedAlertDeletes()[0], 'in')).toContainEqual(['id', ['n1']]);
            expect(res.body.results.cleaned).toBe(1);
        });

        it('clears a payment alert once the customer has paid up', async () => {
            withScan({ notifs: [{ id: 'n1', type: 'payment_overdue', reference_id: 'cust-paid' }] });

            const res = await runCheck();

            expect(res.body.results.cleaned).toBe(1);
        });

        it('keeps a payment alert while the customer still owes', async () => {
            withScan({
                debts: [{
                    id: 'a1', customer_id: 'cust-1', remaining_amount: 500,
                    customers_info: { id: 'cust-1', name: 'ป้าสมศรี', phone: '08', store_id: STORE_ID, due_date: '2025-03-01' }
                }],
                notifs: [{ id: 'n1', type: 'payment_overdue', reference_id: 'cust-1' }]
            });

            const res = await runCheck();

            expect(res.body.results.cleaned).toBe(0);
        });

        it('clears a low-stock alert once the shelf is refilled', async () => {
            withScan({
                products: [{ id: 'p1', stock_qty: 50, low_stock_threshold: 5 }],
                notifs: [{ id: 'n1', type: 'stock_low', reference_id: 'p1' }]
            });

            const res = await runCheck();

            expect(res.body.results.cleaned).toBe(1);
        });

        it('keeps a low-stock alert while the product is still at the threshold', async () => {
            withScan({
                products: [{ id: 'p1', stock_qty: 5, low_stock_threshold: 5 }],
                notifs: [{ id: 'n1', type: 'stock_low', reference_id: 'p1' }]
            });

            const res = await runCheck();

            expect(res.body.results.cleaned).toBe(0);
        });

        it('keeps an out-of-stock alert while the product is at zero', async () => {
            withScan({
                products: [{ id: 'p1', stock_qty: 0, low_stock_threshold: 0 }],
                notifs: [{ id: 'n1', type: 'stock_out', reference_id: 'p1' }]
            });

            const res = await runCheck();

            expect(res.body.results.cleaned).toBe(0);
        });

        it('does not treat a product without a threshold as low stock', async () => {
            withScan({
                products: [{ id: 'p1', stock_qty: 3, low_stock_threshold: 0 }],
                notifs: [{ id: 'n1', type: 'stock_low', reference_id: 'p1' }]
            });

            const res = await runCheck();

            expect(res.body.results.cleaned).toBe(1);
        });

        it('reads only this store\'s open alerts', async () => {
            withScan();

            await runCheck();

            const [read] = supabaseAdmin.callsForOp('notifications', 'select');
            expect(filterArgs(read, 'eq')).toContainEqual(['store_id', STORE_ID]);
            expect(filterArgs(read, 'in')[0][1]).toEqual([
                'stock_expired', 'stock_near_expiry', 'payment_overdue', 'payment_due_soon', 'stock_low', 'stock_out'
            ]);
        });
    });

    describe('archiving products deleted long ago', () => {
        it('removes a deleted product and everything that references it', async () => {
            withScan({ oldProducts: [{ id: 'p-old' }] });

            const res = await runCheck();

            for (const table of ['promotion_items', 'inventory_transactions', 'product_batches']) {
                const [del] = supabaseAdmin.callsForOp(table, 'delete');
                expect(filterArgs(del, 'in')).toContainEqual(['product_id', ['p-old']]);
            }
            const [productDelete] = supabaseAdmin.callsForOp('products', 'delete');
            expect(filterArgs(productDelete, 'in')).toContainEqual(['id', ['p-old']]);
            expect(res.body.results.cleaned).toBe(1);
        });

        it('only considers products deleted more than thirty days ago', async () => {
            withScan();

            await runCheck();

            const sweep = supabaseAdmin.callsForOp('products', 'select')
                .find((c) => c.filters.some((f) => f.name === 'not'));
            const [[, cutoff]] = filterArgs(sweep, 'lt');
            // The route builds this window with `new Date()`, which is left real here.
            const age = new Date().getTime() - new Date(cutoff).getTime();
            expect(age).toBeGreaterThan(29.9 * 86400000);
            expect(age).toBeLessThan(30.1 * 86400000);
        });

        it('deletes nothing when no product is old enough', async () => {
            withScan();

            await runCheck();

            expect(supabaseAdmin.callsForOp('products', 'delete')).toHaveLength(0);
        });
    });

    describe('a session with no user id', () => {
        // authMiddleware normally guarantees req.user.id; these guard the case where
        // it is present but empty rather than trusting the middleware absolutely.
        const anonApp = () => createTestApp(registerNotificationRoutes,
            { supabaseAdmin, checkStoreAccess: allowAccess, upsertNotificationGlobal },
            { user: {} });

        it("returns an empty notification list, not everyone's", async () => {
            supabaseAdmin.onDefault(() => ({ data: [{ id: 'someone-elses' }], error: null }));

            const res = await request(anonApp()).get('/api/notifications').set(storeHeader);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ success: true, data: [] });
            expect(supabaseAdmin.callsFor('notifications')).toHaveLength(0);
        });

        it("reports a zero unread count, not everyone's", async () => {
            supabaseAdmin.onDefault(() => ({ data: [], error: null, count: 99 }));

            const res = await request(anonApp()).get('/api/notifications/unread-count').set(storeHeader);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ success: true, count: 0 });
        });
    });

    describe('when a store cannot be scanned', () => {
        // processStoreNotifications catches its own failures and returns the counters
        // it managed to fill. That keeps the nightly scheduler running past one bad
        // store, at the cost of a manual check reporting success with zeroes.
        it('answers 200 with an empty result set rather than failing the request', async () => {
            supabaseAdmin.onDefault(() => { throw new Error('connection reset'); });

            const res = await runCheck();

            expect(res.status).toBe(200);
            expect(res.body.results).toMatchObject({
                expired: 0, nearExpiry: 0, paymentOverdue: 0, paymentDueSoon: 0, cleaned: 0
            });
        });

        it('names the store in the log so one bad store is traceable', async () => {
            supabaseAdmin.onDefault(() => { throw new Error('boom'); });

            await runCheck();

            expect(errorSpy).toHaveBeenCalledWith(
                expect.stringContaining(STORE_ID),
                expect.any(Error)
            );
        });

        it('still rejects a call with no store header', async () => {
            const res = await request(app()).post('/api/notifications/daily-check');

            expect(res.status).toBe(400);
            expect(res.body.error).toBe('x-store-id header required');
        });
    });

    describe('archiving batches that emptied years ago', () => {
        it('detaches the batch from history before deleting it', async () => {
            withScan({ oldBatches: [{ id: 'b-old', products: { store_id: STORE_ID } }] });

            const res = await runCheck();

            for (const table of ['order_items', 'inventory_transactions']) {
                const [update] = supabaseAdmin.callsForOp(table, 'update');
                expect(update.payload).toEqual({ batch_id: null });
                expect(filterArgs(update, 'in')).toContainEqual(['batch_id', ['b-old']]);
            }
            const [del] = supabaseAdmin.callsForOp('product_batches', 'delete');
            expect(filterArgs(del, 'in')).toContainEqual(['id', ['b-old']]);
            expect(res.body.results.cleaned).toBe(1);
        });

        it('only sweeps empty batches created more than two years ago, in chunks', async () => {
            withScan();

            await runCheck();

            const sweep = supabaseAdmin.callsForOp('product_batches', 'select')
                .find((c) => filterArgs(c, 'eq').some(([col, v]) => col === 'remaining_qty' && v === 0));
            expect(filterArgs(sweep, 'eq')).toContainEqual(['products.store_id', STORE_ID]);
            expect(filterArgs(sweep, 'limit')).toContainEqual([100]);

            // The route builds this window with `new Date()`, which is left real here.
            const [[, cutoff]] = filterArgs(sweep, 'lt');
            const years = (new Date().getTime() - new Date(cutoff).getTime()) / (365.25 * 86400000);
            expect(years).toBeGreaterThan(1.9);
            expect(years).toBeLessThan(2.1);
        });

        it('deletes nothing when no batch is old enough', async () => {
            withScan();

            await runCheck();

            expect(supabaseAdmin.callsForOp('product_batches', 'delete')).toHaveLength(0);
        });
    });

    describe('debts approaching their due date', () => {
        const debt = (dueDate) => ({
            id: 'a1', customer_id: 'cust-1', remaining_amount: 1200,
            customers_info: { id: 'cust-1', name: 'ป้าสมศรี', phone: '0812345678', store_id: STORE_ID, due_date: dueDate }
        });

        it('raises a high-priority alert on the day payment is due', async () => {
            withScan({ debts: [debt(TODAY)] });

            const res = await runCheck();

            expect(res.body.results.paymentDueSoon).toBe(1);
            const [args] = upsertNotificationGlobal.mock.calls;
            expect(args[1]).toBe('payment_due_soon');
            expect(args[2]).toBe('ครบกำหนดชำระวันนี้');
            expect(args[3]).toContain('ครบกำหนดวันนี้');
            expect(args[5]).toBe('high');
        });

        it('gives a gentler warning a few days out', async () => {
            withScan({ debts: [debt('2025-03-14')] });

            const res = await runCheck();

            expect(res.body.results.paymentDueSoon).toBe(1);
            expect(upsertNotificationGlobal.mock.calls[0][2]).toBe('ใกล้ครบกำหนดชำระ');
            expect(upsertNotificationGlobal.mock.calls[0][3]).toContain('อีก 2 วันครบกำหนด');
            expect(upsertNotificationGlobal.mock.calls[0][5]).toBe('medium');
        });

        it('stays quiet about a debt that is not due for a week', async () => {
            withScan({ debts: [debt('2025-03-20')] });

            const res = await runCheck();

            expect(res.body.results.paymentDueSoon).toBe(0);
            expect(upsertNotificationGlobal).not.toHaveBeenCalled();
        });

        it('adds up several bills belonging to one customer', async () => {
            withScan({
                debts: [
                    { ...debt('2025-03-01'), id: 'a1' },
                    { ...debt('2025-03-01'), id: 'a2', remaining_amount: 800 }
                ]
            });

            const res = await runCheck();

            expect(res.body.results.paymentOverdue).toBe(1);
            expect(upsertNotificationGlobal.mock.calls[0][3]).toContain('฿2,000');
        });
    });
});
