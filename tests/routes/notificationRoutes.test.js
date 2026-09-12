const request = require('supertest');
const { registerNotificationRoutes } = require('../../routes/notificationRoutes');
const { createMockSupabase, filterArgs } = require('../helpers/mockSupabase');
const { createTestApp, allowAccess, denyAccess, STORE_ID, storeHeader } = require('../helpers/testApp');

// Pinned clock: 2025-03-12T03:00:00Z = Wed 12 Mar 2025, 10:00 in Bangkok.
const FIXED_NOW = Date.UTC(2025, 2, 12, 3, 0, 0);
const TODAY_TH = '2025-03-12';

describe('routes/notificationRoutes', () => {
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
        // Registering the routes also starts a 24h setInterval scheduler. Only the
        // interval timers are faked, so the handle never leaks past the test while
        // supertest keeps working on real setTimeout.
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

    const app = (checkStoreAccess = allowAccess, options = {}) =>
        createTestApp(registerNotificationRoutes, { supabaseAdmin, checkStoreAccess, upsertNotificationGlobal }, options);

    describe('scheduler startup', () => {
        it('starts the daily scheduler when the routes are registered', () => {
            app();

            expect(logSpy).toHaveBeenCalledWith('Starting Auto-Notification Scheduler...');
            expect(jest.getTimerCount()).toBeGreaterThan(0);
        });
    });

    describe('GET /api/notifications', () => {
        it('returns the caller notifications, newest first', async () => {
            const rows = [{ id: 'n1', title: 'สินค้าหมด' }];
            supabaseAdmin.on('notifications', { data: rows, error: null });

            const res = await request(app()).get('/api/notifications').set(storeHeader);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ success: true, data: rows });

            const [call] = supabaseAdmin.callsFor('notifications');
            expect(filterArgs(call, 'eq')).toContainEqual(['user_id', 'user-1']);
            expect(filterArgs(call, 'eq')).toContainEqual(['store_id', STORE_ID]);
            expect(call.filters).toContainEqual({ name: 'order', args: ['created_at', { ascending: false }] });
        });

        it('filters by category when asked', async () => {
            supabaseAdmin.on('notifications', { data: [], error: null });

            await request(app()).get('/api/notifications?category=payment').set(storeHeader);

            expect(filterArgs(supabaseAdmin.callsFor('notifications')[0], 'eq')).toContainEqual(['category', 'payment']);
        });

        it('returns notifications across every store when no store header is sent', async () => {
            supabaseAdmin.on('notifications', { data: [], error: null });

            await request(app()).get('/api/notifications');

            expect(filterArgs(supabaseAdmin.callsFor('notifications')[0], 'eq').some(([col]) => col === 'store_id')).toBe(false);
        });

        it('returns 500 when the query fails', async () => {
            supabaseAdmin.on('notifications', { data: null, error: { message: 'down' } });

            expect((await request(app()).get('/api/notifications').set(storeHeader)).status).toBe(500);
        });
    });

    describe('GET /api/notifications/unread-count', () => {
        it('counts only the unread notifications for this user and store', async () => {
            supabaseAdmin.on('notifications', { count: 3, data: null, error: null });

            const res = await request(app()).get('/api/notifications/unread-count').set(storeHeader);

            expect(res.body).toEqual({ success: true, count: 3 });

            const [call] = supabaseAdmin.callsFor('notifications');
            expect(filterArgs(call, 'eq')).toContainEqual(['user_id', 'user-1']);
            expect(filterArgs(call, 'eq')).toContainEqual(['is_read', false]);
            expect(filterArgs(call, 'eq')).toContainEqual(['store_id', STORE_ID]);
        });

        it('drops the store filter when no header is sent', async () => {
            supabaseAdmin.on('notifications', { count: 9, data: null, error: null });

            const res = await request(app()).get('/api/notifications/unread-count');

            expect(res.body.count).toBe(9);
            expect(filterArgs(supabaseAdmin.callsFor('notifications')[0], 'eq').some(([col]) => col === 'store_id')).toBe(false);
        });

        it('returns 500 when the count query fails', async () => {
            supabaseAdmin.on('notifications', { count: null, data: null, error: { message: 'down' } });

            expect((await request(app()).get('/api/notifications/unread-count').set(storeHeader)).status).toBe(500);
        });
    });

    describe('POST /api/check-due-notifications', () => {
        function withDebts(accounts) {
            return supabaseAdmin
                .on('stores', { data: { owner_id: 'owner-1' }, error: null })
                .on('store_members', { data: [{ user_id: 'member-1' }], error: null })
                .on('credit_accounts', { data: accounts, error: null });
        }

        it('reports zero when the store has no outstanding debt', async () => {
            withDebts([]);

            const res = await request(app()).post('/api/check-due-notifications').set(storeHeader);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ success: true, created: 0 });
            expect(supabaseAdmin.callsFor('notifications')).toHaveLength(0);
        });

        it('reads only unsettled debts belonging to this store', async () => {
            withDebts([]);

            await request(app()).post('/api/check-due-notifications').set(storeHeader);

            const [call] = supabaseAdmin.callsFor('credit_accounts');
            expect(call.filters).toContainEqual({ name: 'in', args: ['status', ['unpaid', 'partial']] });
            expect(filterArgs(call, 'eq')).toContainEqual(['customers_info.store_id', STORE_ID]);
        });

        it('creates one notification per store user for a customer that is due soon', async () => {
            withDebts([{
                customer_id: 'c1', remaining_amount: '500',
                customers_info: { name: 'สมชาย', phone: '0812345678', due_date: '2025-03-13', store_id: STORE_ID }
            }]);
            supabaseAdmin.on('notifications', (state) => (state.op === 'select' ? { data: [], error: null } : { data: null, error: null }));

            const res = await request(app()).post('/api/check-due-notifications').set(storeHeader);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ success: true, created: 2 }); // owner + one member

            const inserts = supabaseAdmin.callsForOp('notifications', 'insert');
            expect(inserts.map((i) => i.payload[0].user_id)).toEqual(['owner-1', 'member-1']);
            expect(inserts[0].payload[0]).toMatchObject({
                category: 'payment', store_id: STORE_ID, is_read: false,
                payload: { phone: '0812345678', customer_id: 'c1' }
            });
            expect(inserts[0].payload[0].title).toBe('ครบกำหนดชำระอีก 2 วัน');
            expect(inserts[0].payload[0].message).toContain('฿500.00');
        });

        it('labels an overdue customer with the number of days past due', async () => {
            withDebts([{
                customer_id: 'c1', remaining_amount: '500',
                customers_info: { name: 'สมชาย', phone: '08', due_date: '2025-03-09', store_id: STORE_ID }
            }]);
            supabaseAdmin.on('notifications', (state) => (state.op === 'select' ? { data: [], error: null } : { data: null, error: null }));

            const res = await request(app()).post('/api/check-due-notifications').set(storeHeader);

            expect(res.status).toBe(200);
            expect(supabaseAdmin.callsForOp('notifications', 'insert')[0].payload[0].title)
                .toBe('เกินกำหนดชำระ 2 วัน');
        });

        it('sums every outstanding bill of the same customer into one notification', async () => {
            withDebts([
                { customer_id: 'c1', remaining_amount: '300', customers_info: { name: 'สมชาย', phone: '08', due_date: '2025-03-13', store_id: STORE_ID } },
                { customer_id: 'c1', remaining_amount: '200.50', customers_info: { name: 'สมชาย', phone: '08', due_date: '2025-03-13', store_id: STORE_ID } }
            ]);
            supabaseAdmin.on('notifications', (state) => (state.op === 'select' ? { data: [], error: null } : { data: null, error: null }));

            const res = await request(app()).post('/api/check-due-notifications').set(storeHeader);

            expect(res.body.created).toBe(2); // one per user, not one per bill
            expect(supabaseAdmin.callsForOp('notifications', 'insert')[0].payload[0].message).toContain('฿500.50');
        });

        it('skips a user that already has a matching notification', async () => {
            withDebts([{
                customer_id: 'c1', remaining_amount: '500',
                customers_info: { name: 'สมชาย', phone: '08', due_date: '2025-03-13', store_id: STORE_ID }
            }]);
            supabaseAdmin.on('notifications', (state) => (state.op === 'select' ? { data: [{ id: 'n1' }], error: null } : { data: null, error: null }));

            const res = await request(app()).post('/api/check-due-notifications').set(storeHeader);

            expect(res.body).toEqual({ success: true, created: 0 });
            expect(supabaseAdmin.callsForOp('notifications', 'insert')).toHaveLength(0);
        });

        it('reports zero when debts exist but none are near their due date', async () => {
            withDebts([{
                customer_id: 'c1', remaining_amount: '500',
                customers_info: { name: 'สมชาย', phone: '08', due_date: '2099-01-01', store_id: STORE_ID }
            }]);

            const res = await request(app()).post('/api/check-due-notifications').set(storeHeader);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ success: true, created: 0 });
        });

        it('skips a customer with no due date set', async () => {
            withDebts([{
                customer_id: 'c1', remaining_amount: '500',
                customers_info: { name: 'สมชาย', phone: '08', due_date: null, store_id: STORE_ID }
            }]);

            const res = await request(app()).post('/api/check-due-notifications').set(storeHeader);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ success: true, created: 0 });
            expect(supabaseAdmin.callsFor('notifications')).toHaveLength(0);
        });

        it('requires a store header and store access', async () => {
            expect((await request(app()).post('/api/check-due-notifications')).status).toBe(400);
            expect((await request(app(denyAccess)).post('/api/check-due-notifications').set(storeHeader)).status).toBe(403);
        });

        it('returns 500 when the store or member lookup fails', async () => {
            supabaseAdmin.on('stores', { data: null, error: { message: 'store gone' } });
            expect((await request(app()).post('/api/check-due-notifications').set(storeHeader)).body)
                .toEqual({ success: false, error: 'store gone' });

            supabaseAdmin.reset();
            supabaseAdmin.on('stores', { data: { owner_id: 'o' }, error: null })
                .on('store_members', { data: null, error: { message: 'members gone' } });
            expect((await request(app()).post('/api/check-due-notifications').set(storeHeader)).status).toBe(500);
        });
    });

    describe('POST /api/notifications/daily-check', () => {
        function withScan({ expired = [], nearExpiry = [], debts = [] } = {}) {
            let batchReads = 0;
            return supabaseAdmin
                .onDefault(() => ({ data: [], error: null, count: 0 }))
                .on('product_batches', () => {
                    batchReads += 1;
                    return { data: batchReads === 1 ? expired : nearExpiry, error: null };
                })
                .on('credit_accounts', { data: debts, error: null });
        }

        it('reports a zero result set when nothing needs attention', async () => {
            withScan();

            const res = await request(app()).post('/api/notifications/daily-check').set(storeHeader);

            expect(res.status).toBe(200);
            expect(res.body.message).toBe('Manual check completed');
            expect(res.body.results).toMatchObject({ expired: 0, nearExpiry: 0, paymentOverdue: 0, paymentDueSoon: 0 });
        });

        it('raises a critical alert for each expired batch', async () => {
            withScan({
                expired: [{
                    id: 'b1', batch_no: 'LOT-0007', expire_date: '2025-03-10', remaining_qty: 4,
                    products: { id: 'p1', name: 'นมสด', store_id: STORE_ID }
                }]
            });

            const res = await request(app()).post('/api/notifications/daily-check').set(storeHeader);

            expect(res.body.results.expired).toBe(1);
            const [args] = upsertNotificationGlobal.mock.calls;
            expect(args[1]).toBe('stock_expired');
            expect(args[3]).toContain('Lot #0007');
            expect(args[5]).toBe('critical');
            expect(args[7]).toBe('batch');
        });

        it('raises a near-expiry alert, escalating to high priority inside two days', async () => {
            withScan({
                nearExpiry: [
                    { id: 'b1', batch_no: 'L', expire_date: '2025-03-13', remaining_qty: 2, products: { id: 'p1', name: 'A', store_id: STORE_ID } },
                    { id: 'b2', batch_no: 'L', expire_date: '2025-03-18', remaining_qty: 2, products: { id: 'p2', name: 'B', store_id: STORE_ID } }
                ]
            });

            const res = await request(app()).post('/api/notifications/daily-check').set(storeHeader);

            expect(res.body.results.nearExpiry).toBe(2);
            const priorities = upsertNotificationGlobal.mock.calls.map((c) => c[5]);
            expect(priorities).toEqual(['high', 'medium']);
            expect(upsertNotificationGlobal.mock.calls[0][3]).toContain('หมดอายุพรุ่งนี้');
        });

        it('reads the expiry windows against the Thai date', async () => {
            withScan();

            await request(app()).post('/api/notifications/daily-check').set(storeHeader);

            const [expired, near] = supabaseAdmin.callsFor('product_batches');
            expect(filterArgs(expired, 'lt')).toContainEqual(['expire_date', TODAY_TH]);
            expect(filterArgs(near, 'gte')).toContainEqual(['expire_date', TODAY_TH]);
            expect(filterArgs(near, 'lte')).toContainEqual(['expire_date', '2025-03-19']);
        });

        it('groups a customer debts and raises one overdue alert', async () => {
            withScan({
                debts: [
                    { id: 'ca1', customer_id: 'c1', remaining_amount: '300', customers_info: { id: 'c1', name: 'สมชาย', phone: '08', due_date: '2025-03-05', store_id: STORE_ID } },
                    { id: 'ca2', customer_id: 'c1', remaining_amount: '200', customers_info: { id: 'c1', name: 'สมชาย', phone: '08', due_date: '2025-03-05', store_id: STORE_ID } }
                ]
            });

            const res = await request(app()).post('/api/notifications/daily-check').set(storeHeader);

            expect(res.body.results.paymentOverdue).toBe(1);
            const [args] = upsertNotificationGlobal.mock.calls;
            expect(args[1]).toBe('payment_overdue');
            expect(args[3]).toContain('500');
            expect(args[3]).toContain('เกินกำหนด 7 วัน');
        });

        it('raises a due-soon alert for a debt inside the three day window', async () => {
            withScan({
                debts: [{ id: 'ca1', customer_id: 'c1', remaining_amount: '100', customers_info: { id: 'c1', name: 'สมชาย', phone: '08', due_date: '2025-03-14', store_id: STORE_ID } }]
            });

            const res = await request(app()).post('/api/notifications/daily-check').set(storeHeader);

            expect(res.body.results.paymentDueSoon).toBe(1);
            expect(upsertNotificationGlobal.mock.calls[0][1]).toBe('payment_due_soon');
        });

        it('ignores a debt that is not due for weeks', async () => {
            withScan({
                debts: [{ id: 'ca1', customer_id: 'c1', remaining_amount: '100', customers_info: { id: 'c1', name: 'สมชาย', phone: '08', due_date: '2025-05-01', store_id: STORE_ID } }]
            });

            const res = await request(app()).post('/api/notifications/daily-check').set(storeHeader);

            expect(res.body.results).toMatchObject({ paymentOverdue: 0, paymentDueSoon: 0 });
        });

        it('reads only debts with a positive balance for this store', async () => {
            withScan();

            await request(app()).post('/api/notifications/daily-check').set(storeHeader);

            const [call] = supabaseAdmin.callsFor('credit_accounts');
            expect(filterArgs(call, 'gt')).toContainEqual(['remaining_amount', 0]);
            expect(filterArgs(call, 'eq')).toContainEqual(['customers_info.store_id', STORE_ID]);
            expect(call.filters).toContainEqual({ name: 'in', args: ['status', ['unpaid', 'partial', 'overdue']] });
        });

        it('counts only the alerts the upsert reported as changed', async () => {
            withScan({
                expired: [
                    { id: 'b1', batch_no: 'L', expire_date: '2025-03-01', remaining_qty: 1, products: { id: 'p1', name: 'A', store_id: STORE_ID } },
                    { id: 'b2', batch_no: 'L', expire_date: '2025-03-01', remaining_qty: 1, products: { id: 'p2', name: 'B', store_id: STORE_ID } }
                ]
            });
            upsertNotificationGlobal.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

            const res = await request(app()).post('/api/notifications/daily-check').set(storeHeader);

            expect(res.body.results.expired).toBe(1);
        });

        it('requires a store header', async () => {
            const res = await request(app()).post('/api/notifications/daily-check');

            expect(res.status).toBe(400);
            expect(res.body.error).toBe('x-store-id header required');
        });
    });

    describe('PUT /api/notifications/mark-read', () => {
        it('marks the listed notifications read, scoped to the caller', async () => {
            supabaseAdmin.on('notifications', { data: null, error: null });

            const res = await request(app()).put('/api/notifications/mark-read').send({ ids: ['n1', 'n2'] });

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ success: true });

            const [update] = supabaseAdmin.callsForOp('notifications', 'update');
            expect(update.payload).toEqual({ is_read: true });
            expect(update.filters).toContainEqual({ name: 'in', args: ['id', ['n1', 'n2']] });
            expect(filterArgs(update, 'eq')).toContainEqual(['user_id', 'user-1']);
        });

        it('returns 500 when the update fails', async () => {
            supabaseAdmin.on('notifications', { data: null, error: { message: 'down' } });

            expect((await request(app()).put('/api/notifications/mark-read').send({ ids: ['n1'] })).status).toBe(500);
        });
    });

    describe('PUT /api/notifications/:id/read', () => {
        it('marks one notification read, scoped to the caller', async () => {
            supabaseAdmin.on('notifications', { data: null, error: null });

            const res = await request(app()).put('/api/notifications/n1/read');

            expect(res.status).toBe(200);
            const [update] = supabaseAdmin.callsForOp('notifications', 'update');
            expect(filterArgs(update, 'eq')).toContainEqual(['id', 'n1']);
            expect(filterArgs(update, 'eq')).toContainEqual(['user_id', 'user-1']);
        });

        it('returns 500 when the update fails', async () => {
            supabaseAdmin.on('notifications', { data: null, error: { message: 'down' } });

            expect((await request(app()).put('/api/notifications/n1/read')).status).toBe(500);
        });
    });

    describe('DELETE /api/notifications/:id', () => {
        it('deletes one notification, scoped to the caller', async () => {
            supabaseAdmin.on('notifications', { data: null, error: null });

            const res = await request(app()).delete('/api/notifications/n1');

            expect(res.status).toBe(200);
            const [del] = supabaseAdmin.callsForOp('notifications', 'delete');
            expect(filterArgs(del, 'eq')).toContainEqual(['id', 'n1']);
            expect(filterArgs(del, 'eq')).toContainEqual(['user_id', 'user-1']);
        });

        it('returns 500 when the delete fails', async () => {
            supabaseAdmin.on('notifications', { data: null, error: { message: 'down' } });

            expect((await request(app()).delete('/api/notifications/n1')).status).toBe(500);
        });
    });
});
