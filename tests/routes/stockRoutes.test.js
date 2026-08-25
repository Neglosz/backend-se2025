const request = require('supertest');
const { registerStockRoutes } = require('../../routes/stockRoutes');
const { createMockSupabase, filterArgs } = require('../helpers/mockSupabase');
const { createTestApp, allowAccess, denyAccess, STORE_ID, storeHeader } = require('../helpers/testApp');

// Pinned clock: 2025-03-12T03:00:00Z. The handlers shift by +7h before slicing the
// date, so "today" in Thai terms is 2025-03-12 and the +30d limit is 2025-04-11.
const FIXED_NOW = Date.UTC(2025, 2, 12, 3, 0, 0);
const TODAY_TH = '2025-03-12';
const LIMIT_30D = '2025-04-11';

describe('routes/stockRoutes', () => {
    let supabaseAdmin;
    let upsertNotificationGlobal;
    let errorSpy;
    let nowSpy;

    beforeEach(() => {
        supabaseAdmin = createMockSupabase();
        upsertNotificationGlobal = jest.fn(async () => true);
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        nowSpy = jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
        // Some handlers call `new Date()` rather than `Date.now()`, so the Date class
        // itself is faked too. Timers stay real - supertest needs them.
        jest.useFakeTimers({
            now: FIXED_NOW,
            doNotFake: [
                'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
                'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask',
                'performance', 'hrtime', 'requestAnimationFrame', 'cancelAnimationFrame',
                'requestIdleCallback', 'cancelIdleCallback'
            ]
        });
    });

    afterEach(() => {
        jest.useRealTimers();
        errorSpy.mockRestore();
        nowSpy.mockRestore();
    });

    const app = (checkStoreAccess = allowAccess) =>
        createTestApp(registerStockRoutes, { supabaseAdmin, checkStoreAccess, upsertNotificationGlobal });

    describe('GET /api/stock/stats', () => {
        function withStats({ total = 0, nearExpiry = [], expired = [], outOfStock = 0, products = [] } = {}) {
            let productReads = 0;
            let batchReads = 0;
            return supabaseAdmin
                .on('products', () => {
                    productReads += 1;
                    if (productReads === 1) return { count: total, data: null, error: null };
                    if (productReads === 2) return { data: products, error: null };      // low-stock probe
                    if (productReads === 3) return { count: outOfStock, data: null, error: null };
                    return { data: products, error: null };                              // JS-side filter set
                })
                .on('product_batches', () => {
                    batchReads += 1;
                    return { data: batchReads === 1 ? nearExpiry : expired, error: null };
                });
        }

        it('returns the five stock counters', async () => {
            withStats({
                total: 12,
                nearExpiry: [{ id: 'b1' }, { id: 'b2' }],
                expired: [{ id: 'b3' }],
                outOfStock: 4,
                products: [
                    { id: 'p1', stock_qty: '2', low_stock_threshold: '5' },   // low
                    { id: 'p2', stock_qty: '0', low_stock_threshold: '5' },   // out of stock, not "low"
                    { id: 'p3', stock_qty: '50', low_stock_threshold: '5' }   // healthy
                ]
            });

            const res = await request(app()).get('/api/stock/stats').set(storeHeader);

            expect(res.status).toBe(200);
            expect(res.body.data).toEqual({ total: 12, nearExpiry: 2, lowStock: 1, expired: 1, outOfStock: 4 });
        });

        it('excludes zero-stock products from the low-stock count', async () => {
            withStats({ products: [{ id: 'p1', stock_qty: '0', low_stock_threshold: '5' }] });

            const res = await request(app()).get('/api/stock/stats').set(storeHeader);

            expect(res.body.data.lowStock).toBe(0);
        });

        it('counts a product sitting exactly on its threshold as low stock', async () => {
            withStats({ products: [{ id: 'p1', stock_qty: '5', low_stock_threshold: '5' }] });

            const res = await request(app()).get('/api/stock/stats').set(storeHeader);

            expect(res.body.data.lowStock).toBe(1);
        });

        it('defaults every counter to zero when the queries return nothing', async () => {
            supabaseAdmin.on('products', { count: null, data: null, error: null }).on('product_batches', { data: null, error: null });

            const res = await request(app()).get('/api/stock/stats').set(storeHeader);

            expect(res.body.data).toEqual({ total: 0, nearExpiry: 0, lowStock: 0, expired: 0, outOfStock: 0 });
        });

        it('uses the Thai date for the expiry windows', async () => {
            withStats();

            await request(app()).get('/api/stock/stats').set(storeHeader);

            const [near, expired] = supabaseAdmin.callsFor('product_batches');
            expect(filterArgs(near, 'gte')).toContainEqual(['expire_date', TODAY_TH]);
            expect(filterArgs(near, 'lte')).toContainEqual(['expire_date', LIMIT_30D]);
            expect(filterArgs(near, 'gt')).toContainEqual(['remaining_qty', 0]);
            expect(filterArgs(expired, 'lt')).toContainEqual(['expire_date', TODAY_TH]);
        });

        it('scopes every query to the store and skips soft-deleted products', async () => {
            withStats();

            await request(app()).get('/api/stock/stats').set(storeHeader);

            for (const call of supabaseAdmin.callsFor('products')) {
                expect(filterArgs(call, 'eq')).toContainEqual(['store_id', STORE_ID]);
                expect(call.filters).toContainEqual({ name: 'is', args: ['deleted_at', null] });
            }
            for (const call of supabaseAdmin.callsFor('product_batches')) {
                expect(filterArgs(call, 'eq')).toContainEqual(['products.store_id', STORE_ID]);
            }
        });

        it('rejects a missing store header with a Thai message for unauthorized access', async () => {
            expect((await request(app()).get('/api/stock/stats')).status).toBe(400);

            const forbidden = await request(app(denyAccess)).get('/api/stock/stats').set(storeHeader);
            expect(forbidden.status).toBe(403);
            expect(forbidden.body.error).toBe('ไม่มีสิทธิ์เข้าถึงข้อมูลของร้าน');
        });

        it('returns 500 when a query throws', async () => {
            supabaseAdmin.on('products', () => { throw new Error('db down'); });

            const res = await request(app()).get('/api/stock/stats').set(storeHeader);

            expect(res.status).toBe(500);
            expect(res.body).toEqual({ success: false, error: 'db down' });
        });
    });

    describe('GET /api/stock/expired', () => {
        const batch = {
            id: 'b1',
            batch_no: 'LOT-0001',
            expire_date: '2025-03-01',
            remaining_qty: 5,
            products: { id: 'p1', name: 'นมสด', image_url: 'img.png', unit_type: 'ขวด' }
        };

        it('flattens each batch into a product-shaped row', async () => {
            supabaseAdmin.on('product_batches', { data: [batch], error: null });

            const res = await request(app()).get('/api/stock/expired').set(storeHeader);

            expect(res.status).toBe(200);
            expect(res.body.data[0]).toEqual({
                id: 'b1', productId: 'p1', name: 'นมสด', quantity: 5,
                expireDate: '2025-03-01', batchNo: 'LOT-0001', image: 'img.png', unit: 'ขวด'
            });
        });

        it('reads only past-dated batches that still hold stock, soonest first, capped at 20', async () => {
            supabaseAdmin.on('product_batches', { data: [], error: null });

            await request(app()).get('/api/stock/expired').set(storeHeader);

            const [call] = supabaseAdmin.callsFor('product_batches');
            expect(filterArgs(call, 'lt')).toContainEqual(['expire_date', TODAY_TH]);
            expect(filterArgs(call, 'gt')).toContainEqual(['remaining_qty', 0]);
            expect(call.filters).toContainEqual({ name: 'is', args: ['products.deleted_at', null] });
            expect(call.filters).toContainEqual({ name: 'order', args: ['expire_date', { ascending: true }] });
            expect(call.filters).toContainEqual({ name: 'limit', args: [20] });
        });

        it('returns an empty array when the query yields nothing', async () => {
            supabaseAdmin.on('product_batches', { data: null, error: null });

            const res = await request(app()).get('/api/stock/expired').set(storeHeader);

            expect(res.body).toEqual({ success: true, data: [] });
        });

        it('requires a store header and store access', async () => {
            expect((await request(app()).get('/api/stock/expired')).status).toBe(400);
            expect((await request(app(denyAccess)).get('/api/stock/expired').set(storeHeader)).status).toBe(403);
        });

        it('returns 500 when the query fails', async () => {
            supabaseAdmin.on('product_batches', { data: null, error: { message: 'join failed' } });

            expect((await request(app()).get('/api/stock/expired').set(storeHeader)).status).toBe(500);
        });
    });

    describe('GET /api/stock/out-of-stock', () => {
        it('returns zero-stock products sorted by name, capped at 20', async () => {
            supabaseAdmin.on('products', {
                data: [{ id: 'p1', name: 'นมสด', stock_qty: 0, image_url: 'i.png', unit_type: 'ขวด' }],
                error: null
            });

            const res = await request(app()).get('/api/stock/out-of-stock').set(storeHeader);

            expect(res.body.data[0]).toEqual({ id: 'p1', name: 'นมสด', quantity: 0, image: 'i.png', unit: 'ขวด' });

            const [call] = supabaseAdmin.callsFor('products');
            expect(filterArgs(call, 'eq')).toContainEqual(['stock_qty', 0]);
            expect(call.filters).toContainEqual({ name: 'is', args: ['deleted_at', null] });
            expect(call.filters).toContainEqual({ name: 'order', args: ['name', { ascending: true }] });
            expect(call.filters).toContainEqual({ name: 'limit', args: [20] });
        });

        it('returns an empty array when nothing is out of stock', async () => {
            supabaseAdmin.on('products', { data: null, error: null });

            expect((await request(app()).get('/api/stock/out-of-stock').set(storeHeader)).body.data).toEqual([]);
        });

        it('requires a store header and store access, and reports query failures', async () => {
            expect((await request(app()).get('/api/stock/out-of-stock')).status).toBe(400);
            expect((await request(app(denyAccess)).get('/api/stock/out-of-stock').set(storeHeader)).status).toBe(403);

            supabaseAdmin.on('products', { data: null, error: { message: 'down' } });
            expect((await request(app()).get('/api/stock/out-of-stock').set(storeHeader)).status).toBe(500);
        });
    });

    describe('GET /api/stock/near-expiry', () => {
        it('returns the next ten batches expiring within 30 days', async () => {
            supabaseAdmin.on('product_batches', {
                data: [{
                    id: 'b1', batch_no: 'LOT-9', expire_date: '2025-03-20', remaining_qty: 3,
                    products: { id: 'p1', name: 'โยเกิร์ต', image_url: 'y.png', unit_type: 'ถ้วย' }
                }],
                error: null
            });

            const res = await request(app()).get('/api/stock/near-expiry').set(storeHeader);

            expect(res.body.data[0]).toMatchObject({ id: 'b1', productId: 'p1', name: 'โยเกิร์ต', quantity: 3 });

            const [call] = supabaseAdmin.callsFor('product_batches');
            expect(filterArgs(call, 'gte')).toContainEqual(['expire_date', TODAY_TH]);
            expect(filterArgs(call, 'lte')).toContainEqual(['expire_date', LIMIT_30D]);
            expect(call.filters).toContainEqual({ name: 'limit', args: [10] });
        });

        it('returns an empty array when nothing is near expiry', async () => {
            supabaseAdmin.on('product_batches', { data: null, error: null });

            expect((await request(app()).get('/api/stock/near-expiry').set(storeHeader)).body.data).toEqual([]);
        });

        it('requires a store header and store access, and reports query failures', async () => {
            expect((await request(app()).get('/api/stock/near-expiry')).status).toBe(400);
            expect((await request(app(denyAccess)).get('/api/stock/near-expiry').set(storeHeader)).status).toBe(403);

            supabaseAdmin.on('product_batches', { data: null, error: { message: 'down' } });
            expect((await request(app()).get('/api/stock/near-expiry').set(storeHeader)).status).toBe(500);
        });
    });

    describe('GET /api/stock/low-stock', () => {
        it('keeps only products at or below their threshold but still in stock', async () => {
            supabaseAdmin.on('products', {
                data: [
                    { id: 'p1', name: 'A', stock_qty: '2', low_stock_threshold: '5', image_url: 'a.png', unit_type: 'ชิ้น' },
                    { id: 'p2', name: 'B', stock_qty: '5', low_stock_threshold: '5' },
                    { id: 'p3', name: 'C', stock_qty: '0', low_stock_threshold: '5' },
                    { id: 'p4', name: 'D', stock_qty: '99', low_stock_threshold: '5' }
                ],
                error: null
            });

            const res = await request(app()).get('/api/stock/low-stock').set(storeHeader);

            expect(res.body.data.map((p) => p.id)).toEqual(['p1', 'p2']);
            expect(res.body.data[0]).toEqual({
                id: 'p1', name: 'A', quantity: '2', threshold: '5', image: 'a.png', unit: 'ชิ้น'
            });
        });

        it('only queries products that have a threshold set, cheapest stock first', async () => {
            supabaseAdmin.on('products', { data: [], error: null });

            await request(app()).get('/api/stock/low-stock').set(storeHeader);

            const [call] = supabaseAdmin.callsFor('products');
            expect(filterArgs(call, 'gt')).toContainEqual(['low_stock_threshold', 0]);
            expect(call.filters).toContainEqual({ name: 'order', args: ['stock_qty', { ascending: true }] });
            expect(call.filters).toContainEqual({ name: 'limit', args: [20] });
        });

        it('requires a store header and store access, and reports query failures', async () => {
            expect((await request(app()).get('/api/stock/low-stock')).status).toBe(400);
            expect((await request(app(denyAccess)).get('/api/stock/low-stock').set(storeHeader)).status).toBe(403);

            supabaseAdmin.on('products', { data: null, error: { message: 'down' } });
            expect((await request(app()).get('/api/stock/low-stock').set(storeHeader)).status).toBe(500);
        });
    });

    describe('POST /api/stock/check-notifications', () => {
        /** Wire the store/member lookups plus the four stock scans. */
        function withScan({ expired = [], nearExpiry = [], outOfStock = [], lowStock = [] } = {}) {
            let batchReads = 0;
            let productReads = 0;
            return supabaseAdmin
                .on('stores', { data: { owner_id: 'owner-1' }, error: null })
                .on('store_members', { data: [{ user_id: 'member-1' }], error: null })
                .on('product_batches', () => {
                    batchReads += 1;
                    return { data: batchReads === 1 ? expired : nearExpiry, error: null };
                })
                .on('products', () => {
                    productReads += 1;
                    return { data: productReads === 1 ? outOfStock : lowStock, error: null };
                });
        }

        it('reports zero work when nothing needs attention', async () => {
            withScan();

            const res = await request(app()).post('/api/stock/check-notifications').set(storeHeader);

            expect(res.status).toBe(200);
            expect(res.body.data).toEqual({ checked: 0, inserted: 0, expired: 0, nearExpiry: 0, outOfStock: 0, lowStock: 0 });
            expect(upsertNotificationGlobal).not.toHaveBeenCalled();
        });

        it('raises a critical expired-stock notification keyed on the batch', async () => {
            withScan({
                expired: [{ id: 'batch-1', batch_no: 'LOT-0007', expire_date: '2025-03-11', remaining_qty: 4, products: { id: 'p1', name: 'นมสด' } }]
            });

            const res = await request(app()).post('/api/stock/check-notifications').set(storeHeader);

            expect(res.body.data).toMatchObject({ checked: 1, inserted: 1, expired: 1 });
            const [args] = upsertNotificationGlobal.mock.calls;
            expect(args[1]).toBe('stock_expired');
            expect(args[2]).toBe('สินค้าหมดอายุ');
            expect(args[3]).toContain('นมสด');
            expect(args[3]).toContain('Lot #0007');
            expect(args[3]).toContain('2 วันที่แล้ว');
            expect(args[5]).toBe('critical');
            expect(args[6]).toBe('batch-1');
            expect(args[7]).toBe('batch');
        });

        it('phrases how long ago a batch expired in days, weeks or months', async () => {
            withScan({
                expired: [
                    { id: 'b1', batch_no: 'LOT-1', expire_date: '2025-03-09', remaining_qty: 1, products: { id: 'p', name: 'A' } }, // 3 days
                    { id: 'b2', batch_no: 'LOT-2', expire_date: '2025-02-20', remaining_qty: 1, products: { id: 'p', name: 'B' } }, // ~3 weeks
                    { id: 'b3', batch_no: 'LOT-3', expire_date: '2024-12-01', remaining_qty: 1, products: { id: 'p', name: 'C' } }  // months
                ]
            });

            await request(app()).post('/api/stock/check-notifications').set(storeHeader);

            const messages = upsertNotificationGlobal.mock.calls.map((c) => c[3]);
            expect(messages[0]).toContain('วันที่แล้ว');
            expect(messages[1]).toContain('สัปดาห์ที่แล้ว');
            expect(messages[2]).toContain('เดือนที่แล้ว');
        });

        it('falls back to the batch id when a batch has no lot number', async () => {
            withScan({
                expired: [{ id: 'abcdefgh-1234', batch_no: null, expire_date: '2025-03-11', remaining_qty: 1, products: { id: 'p', name: 'A' } }]
            });

            await request(app()).post('/api/stock/check-notifications').set(storeHeader);

            expect(upsertNotificationGlobal.mock.calls[0][3]).toContain('Lot #abcdefgh');
        });

        it('raises a medium near-expiry notification with the days remaining', async () => {
            withScan({
                nearExpiry: [{ id: 'b1', batch_no: 'LOT-1', expire_date: '2025-03-14', remaining_qty: 6, products: { id: 'p1', name: 'ขนมปัง', low_stock_threshold: '0' } }]
            });

            await request(app()).post('/api/stock/check-notifications').set(storeHeader);

            const [args] = upsertNotificationGlobal.mock.calls;
            expect(args[1]).toBe('stock_near_expiry');
            expect(args[3]).toContain('หมดอายุใน 2 วัน');
            expect(args[5]).toBe('medium');
            expect(args[8]).toMatchObject({ days_left: 2, batch_id: 'b1' });
        });

        it('uses "today" and "tomorrow" wording at the boundaries', async () => {
            withScan({
                nearExpiry: [
                    { id: 'b1', batch_no: 'L', expire_date: '2025-03-12', remaining_qty: 1, products: { id: 'p', name: 'A' } },
                    { id: 'b2', batch_no: 'L', expire_date: '2025-03-13', remaining_qty: 1, products: { id: 'p', name: 'B' } }
                ]
            });

            await request(app()).post('/api/stock/check-notifications').set(storeHeader);

            const messages = upsertNotificationGlobal.mock.calls.map((c) => c[3]);
            expect(messages[0]).toContain('หมดอายุวันนี้!');
            expect(messages[1]).toContain('หมดอายุพรุ่งนี้');
        });

        it('flags a near-expiry batch that is also below its threshold', async () => {
            withScan({
                nearExpiry: [{ id: 'b1', batch_no: 'L', expire_date: '2025-03-14', remaining_qty: '2', products: { id: 'p', name: 'A', low_stock_threshold: '5' } }]
            });

            await request(app()).post('/api/stock/check-notifications').set(storeHeader);

            expect(upsertNotificationGlobal.mock.calls[0][3]).toContain('(ต่ำกว่าเกณฑ์)');
        });

        it('raises a critical out-of-stock notification keyed on the product', async () => {
            withScan({ outOfStock: [{ id: 'p1', name: 'น้ำปลา', stock_qty: 0 }] });

            await request(app()).post('/api/stock/check-notifications').set(storeHeader);

            const [args] = upsertNotificationGlobal.mock.calls;
            expect(args[1]).toBe('stock_out');
            expect(args[3]).toBe('น้ำปลา');
            expect(args[5]).toBe('critical');
            expect(args[6]).toBe('p1');
            expect(args[7]).toBe('product');
        });

        it('raises a low-stock notification only for products at or below the threshold', async () => {
            withScan({
                lowStock: [
                    { id: 'p1', name: 'A', stock_qty: '3', low_stock_threshold: '5' },
                    { id: 'p2', name: 'B', stock_qty: '9', low_stock_threshold: '5' }
                ]
            });

            const res = await request(app()).post('/api/stock/check-notifications').set(storeHeader);

            expect(upsertNotificationGlobal).toHaveBeenCalledTimes(1);
            expect(upsertNotificationGlobal.mock.calls[0][1]).toBe('stock_low');
            expect(res.body.data.lowStock).toBe(1);
        });

        it('counts only the notifications the upsert reported as changed', async () => {
            withScan({ outOfStock: [{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }] });
            upsertNotificationGlobal.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

            const res = await request(app()).post('/api/stock/check-notifications').set(storeHeader);

            expect(res.body.data).toMatchObject({ checked: 2, inserted: 1 });
        });

        it('scans all four categories in one pass', async () => {
            withScan({
                expired: [{ id: 'b1', batch_no: 'L', expire_date: '2025-03-01', remaining_qty: 1, products: { id: 'p', name: 'A' } }],
                nearExpiry: [{ id: 'b2', batch_no: 'L', expire_date: '2025-03-14', remaining_qty: 1, products: { id: 'p', name: 'B' } }],
                outOfStock: [{ id: 'p3', name: 'C' }],
                lowStock: [{ id: 'p4', name: 'D', stock_qty: '1', low_stock_threshold: '5' }]
            });

            const res = await request(app()).post('/api/stock/check-notifications').set(storeHeader);

            expect(res.body.data).toMatchObject({ checked: 4, expired: 1, nearExpiry: 1, outOfStock: 1, lowStock: 1 });
            expect(upsertNotificationGlobal.mock.calls.map((c) => c[1]))
                .toEqual(['stock_expired', 'stock_near_expiry', 'stock_out', 'stock_low']);
        });

        it('uses a 7-day window for near expiry (narrower than the 30-day dashboard view)', async () => {
            withScan();

            await request(app()).post('/api/stock/check-notifications').set(storeHeader);

            const [, near] = supabaseAdmin.callsFor('product_batches');
            expect(filterArgs(near, 'gte')).toContainEqual(['expire_date', TODAY_TH]);
            expect(filterArgs(near, 'lte')).toContainEqual(['expire_date', '2025-03-19']);
        });

        it('requires a store header and store access', async () => {
            expect((await request(app()).post('/api/stock/check-notifications')).status).toBe(400);
            expect((await request(app(denyAccess)).post('/api/stock/check-notifications').set(storeHeader)).status).toBe(403);
            expect(supabaseAdmin.from).not.toHaveBeenCalled();
        });

        it('returns 500 when the store or member lookup fails', async () => {
            supabaseAdmin.on('stores', { data: null, error: { message: 'store gone' } });
            expect((await request(app()).post('/api/stock/check-notifications').set(storeHeader)).status).toBe(500);

            supabaseAdmin.reset();
            supabaseAdmin.on('stores', { data: { owner_id: 'o' }, error: null })
                .on('store_members', { data: null, error: { message: 'members gone' } });
            const res = await request(app()).post('/api/stock/check-notifications').set(storeHeader);
            expect(res.body).toEqual({ success: false, error: 'members gone' });
        });
    });
});
