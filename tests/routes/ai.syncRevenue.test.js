/**
 * syncRealMoneyEarned is the money column of the recommendation history: it decides
 * what "เงินที่ได้เพิ่ม" says for every accepted recommendation. It is only reachable
 * through GET /api/ai/recommendations/history, so these tests drive it from there and
 * assert on both the response body and the writes it makes back to ai_recommendations.
 */
const request = require('supertest');
const express = require('express');

let mockDb;
const mockGenerateContent = jest.fn();
const mockGetGenerativeModel = jest.fn(() => ({
    generateContent: mockGenerateContent,
    startChat: jest.fn(() => ({ sendMessage: jest.fn() }))
}));

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn(() => mockDb) }));
jest.mock('@google/generative-ai', () => ({
    GoogleGenerativeAI: jest.fn(() => ({ getGenerativeModel: mockGetGenerativeModel }))
}));

const { createMockSupabase, filterArgs } = require('../helpers/mockSupabase');
mockDb = createMockSupabase();

const aiRoutes = require('../../routes/ai');

const STORE_ID = 'store-1';
const headers = { 'x-store-id': STORE_ID };
const ACTED_AT = '2026-08-20T03:00:00.000Z';

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { id: 'user-1' }; next(); });
    app.use('/api/ai', aiRoutes);
    return app;
}

/**
 * Serve `rows` for the history select and record every follow-up write.
 * Returns the array the route mutates in place, so tests can read the synced values.
 */
function serveHistory(rows) {
    mockDb.on('ai_recommendations', (state) => (state.op === 'select'
        ? { data: rows, error: null }
        : { data: null, error: null }));
    return rows;
}

/** An accepted recommendation with the fields syncRealMoneyEarned requires. */
const accepted = (overrides = {}) => ({
    id: 'rec-1',
    type: 'expiry',
    status: 'accepted',
    acted_at: ACTED_AT,
    created_at: ACTED_AT,
    actual_amount: null,
    actual_outcome: null,
    payload: { affected_product_ids: ['p1'] },
    ...overrides
});

/** Every recommendation returned by the endpoint, ignoring the day grouping. */
const flatten = (body) => Object.values(body.data).flat();

/** The ai_recommendations rows written back during the request. */
const writes = () => mockDb.callsForOp('ai_recommendations', 'update');

describe('syncRealMoneyEarned (via GET /api/ai/recommendations/history)', () => {
    let app;
    let errorSpy;

    beforeEach(() => {
        mockDb.reset();
        mockDb.onDefault(() => ({ data: [], error: null, count: 0 }));
        app = buildApp();
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        app = buildApp();
    });

    afterEach(() => errorSpy.mockRestore());

    describe('rows it refuses to touch', () => {
        it('ignores a recommendation that was skipped rather than accepted', async () => {
            serveHistory([accepted({ status: 'skipped' })]);

            await request(app).get('/api/ai/recommendations/history').set(headers);

            expect(mockDb.callsFor('order_items')).toHaveLength(0);
            expect(writes()).toHaveLength(0);
        });

        it('ignores an accepted row that has no acted_at to measure from', async () => {
            serveHistory([accepted({ acted_at: null })]);

            await request(app).get('/api/ai/recommendations/history').set(headers);

            expect(mockDb.callsFor('order_items')).toHaveLength(0);
        });

        it('ignores an accepted row with no payload', async () => {
            serveHistory([accepted({ payload: null })]);

            await request(app).get('/api/ai/recommendations/history').set(headers);

            expect(mockDb.callsFor('order_items')).toHaveLength(0);
        });

        it('handles a history with no rows at all', async () => {
            serveHistory([]);

            const res = await request(app).get('/api/ai/recommendations/history').set(headers);

            expect(res.status).toBe(200);
            expect(res.body.data).toEqual({});
        });
    });

    describe('disposal earns nothing', () => {
        // Throwing away expired stock is a loss. Counting it as revenue would tell the
        // owner the AI made them money every time they binned something.
        it('reports zero for a dispose-type recommendation', async () => {
            const rows = serveHistory([accepted({ type: 'dispose', actual_amount: null })]);

            await request(app).get('/api/ai/recommendations/history').set(headers);

            expect(rows[0].actual_amount).toBeNull();
            expect(writes()).toHaveLength(0);
            expect(mockDb.callsFor('order_items')).toHaveLength(0);
        });

        it('reports zero when the payload action is dispose', async () => {
            serveHistory([accepted({
                payload: { affected_product_ids: ['p1'], recommended_discount: { action: 'dispose' } }
            })]);

            await request(app).get('/api/ai/recommendations/history').set(headers);

            expect(writes()).toHaveLength(0);
        });

        it('reports zero for a 100% discount, which is a disposal in disguise', async () => {
            serveHistory([accepted({
                payload: { affected_product_ids: ['p1'], recommended_discount: { percent: 100 } }
            })]);

            await request(app).get('/api/ai/recommendations/history').set(headers);

            expect(writes()).toHaveLength(0);
        });

        it('does not wipe an amount already recorded against a disposal', async () => {
            const rows = serveHistory([accepted({ type: 'dispose', actual_amount: '250' })]);

            await request(app).get('/api/ai/recommendations/history').set(headers);

            expect(rows[0].actual_amount).toBe('250');
            expect(writes()).toHaveLength(0);
        });
    });

    describe('product sales generated after the action', () => {
        it('sums the subtotals of the affected products and saves the total', async () => {
            const rows = serveHistory([accepted()]);
            mockDb.on('order_items', {
                data: [{ subtotal: '120.50' }, { subtotal: '79.50' }, { subtotal: 100 }],
                error: null
            });

            const res = await request(app).get('/api/ai/recommendations/history').set(headers);

            expect(rows[0].actual_amount).toBe(300);
            expect(flatten(res.body)[0].actual_amount).toBe(300);

            const [write] = writes();
            expect(write.payload).toEqual({ actual_amount: 300 });
            expect(filterArgs(write, 'eq')).toContainEqual(['id', 'rec-1']);
        });

        it('counts only paid and partially paid orders from this store, after acted_at', async () => {
            serveHistory([accepted()]);
            mockDb.on('order_items', { data: [{ subtotal: '10' }], error: null });

            await request(app).get('/api/ai/recommendations/history').set(headers);

            const [query] = mockDb.callsFor('order_items');
            expect(filterArgs(query, 'in')).toContainEqual(['product_id', ['p1']]);
            expect(filterArgs(query, 'in')).toContainEqual(['orders.payment_status', ['paid', 'partial']]);
            expect(filterArgs(query, 'eq')).toContainEqual(['orders.store_id', STORE_ID]);
            expect(filterArgs(query, 'gte')).toContainEqual(['orders.created_at', ACTED_AT]);
        });

        it('treats a malformed subtotal as zero rather than producing NaN', async () => {
            const rows = serveHistory([accepted()]);
            mockDb.on('order_items', { data: [{ subtotal: null }, { subtotal: 'n/a' }, { subtotal: '25' }], error: null });

            await request(app).get('/api/ai/recommendations/history').set(headers);

            expect(rows[0].actual_amount).toBe(25);
        });

        it('leaves the stored amount alone when the sales query fails', async () => {
            const rows = serveHistory([accepted({ actual_amount: '40' })]);
            mockDb.on('order_items', { data: null, error: { message: 'timeout' } });

            await request(app).get('/api/ai/recommendations/history').set(headers);

            expect(rows[0].actual_amount).toBe('40');
            expect(writes()).toHaveLength(0);
        });

        it('skips the sales lookup when no products are attached', async () => {
            serveHistory([accepted({ payload: { affected_product_ids: [] } })]);

            await request(app).get('/api/ai/recommendations/history').set(headers);

            expect(mockDb.callsFor('order_items')).toHaveLength(0);
            expect(writes()).toHaveLength(0);
        });
    });

    describe('debt recovered after the action', () => {
        const debtRow = accepted({
            type: 'debt',
            payload: { affected_customer_ids: ['c1', 'c2'] }
        });

        it('sums payments made against the customers\' credit orders', async () => {
            const rows = serveHistory([{ ...debtRow }]);
            mockDb.on('credit_accounts', { data: [{ order_id: 'o1' }, { order_id: 'o2' }], error: null });
            mockDb.on('payments', { data: [{ amount: '500' }, { amount: 250 }], error: null });

            await request(app).get('/api/ai/recommendations/history').set(headers);

            expect(rows[0].actual_amount).toBe(750);
            expect(writes()[0].payload).toEqual({ actual_amount: 750 });
        });

        it('looks up payments by the order ids behind those customers, after acted_at', async () => {
            serveHistory([{ ...debtRow }]);
            mockDb.on('credit_accounts', { data: [{ order_id: 'o1' }], error: null });
            mockDb.on('payments', { data: [{ amount: '1' }], error: null });

            await request(app).get('/api/ai/recommendations/history').set(headers);

            expect(filterArgs(mockDb.callsFor('credit_accounts')[0], 'in'))
                .toContainEqual(['customer_id', ['c1', 'c2']]);

            const [payQuery] = mockDb.callsFor('payments');
            expect(filterArgs(payQuery, 'in')).toContainEqual(['order_id', ['o1']]);
            expect(filterArgs(payQuery, 'gte')).toContainEqual(['paid_at', ACTED_AT]);
        });

        it('does not query payments when the customers have no credit orders', async () => {
            serveHistory([{ ...debtRow }]);
            mockDb.on('credit_accounts', { data: [], error: null });

            await request(app).get('/api/ai/recommendations/history').set(headers);

            expect(mockDb.callsFor('payments')).toHaveLength(0);
            expect(writes()).toHaveLength(0);
        });

        it('leaves the amount alone when the payments query fails', async () => {
            const rows = serveHistory([{ ...debtRow, actual_amount: '90' }]);
            mockDb.on('credit_accounts', { data: [{ order_id: 'o1' }], error: null });
            mockDb.on('payments', { data: null, error: { message: 'down' } });

            await request(app).get('/api/ai/recommendations/history').set(headers);

            expect(rows[0].actual_amount).toBe('90');
        });

        it('adds sales and recovered debt together when a payload carries both', async () => {
            const rows = serveHistory([accepted({
                payload: { affected_product_ids: ['p1'], affected_customer_ids: ['c1'] }
            })]);
            mockDb.on('order_items', { data: [{ subtotal: '200' }], error: null });
            mockDb.on('credit_accounts', { data: [{ order_id: 'o1' }], error: null });
            mockDb.on('payments', { data: [{ amount: '55' }], error: null });

            await request(app).get('/api/ai/recommendations/history').set(headers);

            expect(rows[0].actual_amount).toBe(255);
        });
    });

    describe('stock recommendations report spoilage alongside sales', () => {
        const stockRow = () => accepted({ type: 'stock' });

        it('records what sold when nothing was thrown away', async () => {
            const rows = serveHistory([stockRow()]);
            mockDb.on('order_items', { data: [{ subtotal: '1234' }], error: null });

            await request(app).get('/api/ai/recommendations/history').set(headers);

            expect(rows[0].actual_outcome).toBe('ขายไปได้แล้ว ฿1,234');
            expect(writes().map((w) => w.payload)).toContainEqual({ actual_outcome: 'ขายไปได้แล้ว ฿1,234' });
        });

        it('appends the cost of spoiled stock, valued at cost price', async () => {
            const rows = serveHistory([stockRow()]);
            mockDb.on('order_items', { data: [{ subtotal: '1000' }], error: null });
            mockDb.on('inventory_transactions', {
                data: [
                    { qty: '3', products: { cost_price: '20' } },
                    { qty: 2, products: { cost_price: 15 } }
                ],
                error: null
            });

            await request(app).get('/api/ai/recommendations/history').set(headers);

            expect(rows[0].actual_outcome).toBe('ขายไปได้แล้ว ฿1,000 (ของเสีย/ทิ้ง ฿90)');
        });

        it('reads only disposals of the affected products since the action', async () => {
            serveHistory([stockRow()]);
            mockDb.on('order_items', { data: [{ subtotal: '10' }], error: null });
            mockDb.on('inventory_transactions', { data: [], error: null });

            await request(app).get('/api/ai/recommendations/history').set(headers);

            const [query] = mockDb.callsFor('inventory_transactions');
            expect(filterArgs(query, 'in')).toContainEqual(['product_id', ['p1']]);
            expect(filterArgs(query, 'eq')).toContainEqual(['store_id', STORE_ID]);
            expect(filterArgs(query, 'eq')).toContainEqual(['trans_type', 'out']);
            expect(filterArgs(query, 'eq')).toContainEqual(['reference_type', 'dispose']);
            expect(filterArgs(query, 'gte')).toContainEqual(['created_at', ACTED_AT]);
        });

        it('reports spoilage even when nothing sold', async () => {
            const rows = serveHistory([stockRow()]);
            mockDb.on('order_items', { data: [], error: null });
            mockDb.on('inventory_transactions', { data: [{ qty: '1', products: { cost_price: '45' } }], error: null });

            await request(app).get('/api/ai/recommendations/history').set(headers);

            expect(rows[0].actual_outcome).toBe('ขายไปได้แล้ว ฿0 (ของเสีย/ทิ้ง ฿45)');
        });

        it('says the restock is waiting when there is neither a sale nor a disposal', async () => {
            const rows = serveHistory([stockRow()]);

            await request(app).get('/api/ai/recommendations/history').set(headers);

            expect(rows[0].actual_outcome).toBe('เติมสต็อกเรียบร้อย (รอการขาย)');
            expect(writes()[0].payload).toEqual({ actual_outcome: 'เติมสต็อกเรียบร้อย (รอการขาย)' });
        });

        it('keeps an outcome the owner already has when nothing has happened since', async () => {
            const rows = serveHistory([accepted({ type: 'stock', actual_outcome: 'ปิดเคสแล้ว' })]);

            await request(app).get('/api/ai/recommendations/history').set(headers);

            expect(rows[0].actual_outcome).toBe('ปิดเคสแล้ว');
            expect(writes()).toHaveLength(0);
        });

        it('does not rewrite an outcome that is already correct', async () => {
            serveHistory([accepted({ type: 'stock', actual_outcome: 'ขายไปได้แล้ว ฿500', actual_amount: 500 })]);
            mockDb.on('order_items', { data: [{ subtotal: '500' }], error: null });

            await request(app).get('/api/ai/recommendations/history').set(headers);

            expect(writes()).toHaveLength(0);
        });

        it('treats a missing cost price as zero loss', async () => {
            const rows = serveHistory([stockRow()]);
            mockDb.on('order_items', { data: [{ subtotal: '10' }], error: null });
            mockDb.on('inventory_transactions', { data: [{ qty: '5', products: null }], error: null });

            await request(app).get('/api/ai/recommendations/history').set(headers);

            expect(rows[0].actual_outcome).toBe('ขายไปได้แล้ว ฿10');
        });

        it('skips the spoilage lookup for non-stock recommendations', async () => {
            serveHistory([accepted({ type: 'expiry' })]);
            mockDb.on('order_items', { data: [{ subtotal: '10' }], error: null });

            await request(app).get('/api/ai/recommendations/history').set(headers);

            expect(mockDb.callsFor('inventory_transactions')).toHaveLength(0);
        });
    });

    describe('when the amount is written back', () => {
        it('does not write when the new total matches what is already stored', async () => {
            serveHistory([accepted({ actual_amount: '300' })]);
            mockDb.on('order_items', { data: [{ subtotal: '300' }], error: null });

            await request(app).get('/api/ai/recommendations/history').set(headers);

            expect(writes()).toHaveLength(0);
        });

        it('ignores a difference below one satang', async () => {
            serveHistory([accepted({ actual_amount: '300.005' })]);
            mockDb.on('order_items', { data: [{ subtotal: '300' }], error: null });

            await request(app).get('/api/ai/recommendations/history').set(headers);

            expect(writes()).toHaveLength(0);
        });

        it('writes when the total has grown since the last check', async () => {
            const rows = serveHistory([accepted({ actual_amount: '300' })]);
            mockDb.on('order_items', { data: [{ subtotal: '450' }], error: null });

            await request(app).get('/api/ai/recommendations/history').set(headers);

            expect(rows[0].actual_amount).toBe(450);
            expect(writes()[0].payload).toEqual({ actual_amount: 450 });
        });

        it('writes when the total has shrunk, so a refunded order is reflected', async () => {
            const rows = serveHistory([accepted({ actual_amount: '900' })]);
            mockDb.on('order_items', { data: [{ subtotal: '450' }], error: null });

            await request(app).get('/api/ai/recommendations/history').set(headers);

            expect(rows[0].actual_amount).toBe(450);
        });

        it('does not clear a stored amount when the products no longer sell', async () => {
            // newAmount 0 is not written: the guard requires newAmount > 0.
            const rows = serveHistory([accepted({ actual_amount: '900' })]);
            mockDb.on('order_items', { data: [], error: null });

            await request(app).get('/api/ai/recommendations/history').set(headers);

            expect(rows[0].actual_amount).toBe('900');
            expect(writes()).toHaveLength(0);
        });
    });

    describe('several recommendations at once', () => {
        it('syncs each accepted row independently and groups the response', async () => {
            const rows = serveHistory([
                accepted({ id: 'rec-a', payload: { affected_product_ids: ['p1'] } }),
                accepted({ id: 'rec-b', type: 'dispose' }),
                accepted({ id: 'rec-c', status: 'skipped' })
            ]);
            mockDb.on('order_items', { data: [{ subtotal: '75' }], error: null });

            const res = await request(app).get('/api/ai/recommendations/history').set(headers);

            expect(res.status).toBe(200);
            expect(rows[0].actual_amount).toBe(75);
            expect(rows[1].actual_amount).toBeNull();
            expect(rows[2].actual_amount).toBeNull();

            const updated = writes().map((w) => filterArgs(w, 'eq').find(([c]) => c === 'id')[1]);
            expect(updated).toEqual(['rec-a']);
        });

        it('still returns 200 with the synced rows in the grouped payload', async () => {
            serveHistory([accepted()]);
            mockDb.on('order_items', { data: [{ subtotal: '60' }], error: null });

            const res = await request(app).get('/api/ai/recommendations/history').set(headers);

            expect(flatten(res.body).map((r) => r.actual_amount)).toEqual([60]);
        });
    });
});
