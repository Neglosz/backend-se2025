/**
 * The branches the main ai.js suites do not reach: the seasonal label, the period
 * windows, the fuzzy product fallback the write endpoints use when the model
 * misspells a name, and the failure paths behind them.
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
const USER = { id: 'user-1' };
const headers = { 'x-store-id': STORE_ID };

const aiText = (text) => ({ response: { text: () => text } });

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = USER; next(); });
    app.use('/api/ai', aiRoutes);
    return app;
}

/** Freeze the clock, keeping timers real so supertest still works. */
function freezeAt(instant) {
    jest.spyOn(Date, 'now').mockReturnValue(instant);
    jest.useFakeTimers({
        now: instant,
        doNotFake: [
            'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
            'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask',
            'performance', 'hrtime', 'requestAnimationFrame', 'cancelAnimationFrame',
            'requestIdleCallback', 'cancelIdleCallback'
        ]
    });
}

describe('routes/ai remaining paths', () => {
    let app;
    let errorSpy;
    let logSpy;

    beforeEach(() => {
        mockDb.reset();
        mockDb.onDefault(() => ({ data: [], error: null, count: 0 }));
        mockGenerateContent.mockResolvedValue(aiText('[]'));
        global.fetch = jest.fn().mockResolvedValue({
            json: async () => ({ address: {}, current_weather: { temperature: 30, weathercode: 0 } })
        });
        app = buildApp();
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
        delete global.fetch;
    });

    describe('the seasonal label in the prompt', () => {
        const seasonAt = async (month) => {
            freezeAt(Date.UTC(2026, month - 1, 15, 5, 0, 0));
            const res = await request(app).get('/api/ai/context').set(headers);
            return res.body.context.match(/\[SEASON: ([^\]]+)\]/)[1];
        };

        it('calls May to October the rainy season', async () => {
            expect(await seasonAt(7)).toBe('Rainy');
        });

        it('calls November to February the cool season', async () => {
            expect(await seasonAt(12)).toBe('Winter (Cool)');
            jest.useRealTimers();
            jest.restoreAllMocks();
            errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
            expect(await seasonAt(1)).toBe('Winter (Cool)');
        });

        it('calls March and April summer', async () => {
            expect(await seasonAt(4)).toBe('Summer');
        });
    });

    describe('the period the recommendation list covers', () => {
        // Wednesday 26 Aug 2026, 12:00 Bangkok.
        const WEDNESDAY = Date.UTC(2026, 7, 26, 5, 0, 0);

        /** The created_at floor the existing-recommendation lookup used. */
        const cutoff = () => filterArgs(mockDb.callsFor('ai_recommendations')[0], 'gte')[0][1];

        it('starts today at Bangkok midnight', async () => {
            freezeAt(WEDNESDAY);

            await request(app).get('/api/ai/recommendations').set(headers);

            expect(cutoff()).toBe('2026-08-25T17:00:00.000Z'); // 26 Aug 00:00 +07:00
        });

        it('starts the month on the 1st when asked for the month', async () => {
            freezeAt(WEDNESDAY);

            await request(app).get('/api/ai/recommendations?period=month').set(headers);

            expect(new Date(cutoff()).getDate()).toBe(1);
        });

        it('winds back to Monday when asked for the week', async () => {
            freezeAt(WEDNESDAY);

            await request(app).get('/api/ai/recommendations?period=week').set(headers);

            expect(new Date(cutoff()).getDay()).toBe(1); // Monday
        });

        it('does not wind back when the week already starts today', async () => {
            freezeAt(Date.UTC(2026, 7, 24, 5, 0, 0)); // a Monday

            await request(app).get('/api/ai/recommendations?period=week').set(headers);

            expect(new Date(cutoff()).getDate()).toBe(24);
        });

        it('treats Sunday as the end of the week, not the start', async () => {
            freezeAt(Date.UTC(2026, 7, 30, 5, 0, 0)); // a Sunday

            await request(app).get('/api/ai/recommendations?period=week').set(headers);

            const start = new Date(cutoff());
            expect(start.getDay()).toBe(1);
            expect(start.getDate()).toBe(24); // the Monday before, not the day after
        });
    });

    describe('suggestions that duplicate a running promotion', () => {
        function withPromoOn(productName) {
            mockDb.onDefault((state) => {
                switch (state.table) {
                    case 'ai_recommendations':
                        return state.op === 'select' ? { data: [], error: null } : { data: [{ id: 'new-1' }], error: null };
                    case 'products':
                        return state.filters.some((f) => f.name === 'in')
                            ? { data: [{ id: 'p9', name: productName }], error: null }
                            : { data: [{ id: 'p9', name: productName, stock_qty: 10, cost_price: 10, price: 20, low_stock_threshold: 5, unit_type: 'ชิ้น' }], count: 1, error: null };
                    case 'promotion_items':
                        return {
                            data: [{ product_id: 'p9', promotions: { name: 'โปรเดิม', type: 'percentage', discount_value: 10, end_date: '2026-12-31' } }],
                            error: null
                        };
                    default:
                        return { data: [], error: null, count: 0 };
                }
            });
        }

        it('drops a promotion card for a product that is already on promotion', async () => {
            withPromoOn('นมสด');
            mockGenerateContent.mockResolvedValue(aiText(JSON.stringify([
                { type: 'promotion', title: 'จัดโปรนมสด', detail: 'ลดราคา', action_label: 'ลด 10%', target_products: ['นมสด'], recommended_discount: { percent: 10 } },
                { type: 'info', title: 'เรื่องอื่น', detail: 'ยังใช้ได้', action_label: 'ดู' }
            ])));

            await request(app).get('/api/ai/recommendations').set(headers);

            const rows = mockDb.callsForOp('ai_recommendations', 'insert')[0].payload;
            expect(rows.map((r) => r.title)).toEqual(['เรื่องอื่น']);
        });

        it('matches the running promotion regardless of letter case', async () => {
            withPromoOn('Milk');
            mockGenerateContent.mockResolvedValue(aiText(JSON.stringify([
                { type: 'promotion', title: 'จัดโปร', detail: 'x', action_label: 'ลด 10%', target_products: ['MILK'], recommended_discount: { percent: 10 } }
            ])));

            await request(app).get('/api/ai/recommendations').set(headers);

            expect(mockDb.callsForOp('ai_recommendations', 'insert')[0].payload).toEqual([]);
        });

        it('keeps a write-off for a product that is on promotion', async () => {
            // A running promotion is no reason to hide expired stock from the owner.
            withPromoOn('นมสด');
            mockGenerateContent.mockResolvedValue(aiText(JSON.stringify([
                { type: 'expiry', title: 'ตัดสต็อกนมสด', detail: 'หมดอายุ', action_label: 'ตัดสต็อก', target_products: ['นมสด'], recommended_discount: { action: 'dispose' } }
            ])));

            await request(app).get('/api/ai/recommendations').set(headers);

            expect(mockDb.callsForOp('ai_recommendations', 'insert')[0].payload).toHaveLength(1);
        });

        it('keeps a card that proposes no discount at all', async () => {
            withPromoOn('นมสด');
            mockGenerateContent.mockResolvedValue(aiText(JSON.stringify([
                { type: 'stock', title: 'เติมสต็อกนมสด', detail: 'x', action_label: 'เติมสต็อก', target_products: ['นมสด'] }
            ])));

            await request(app).get('/api/ai/recommendations').set(headers);

            expect(mockDb.callsForOp('ai_recommendations', 'insert')[0].payload).toHaveLength(1);
        });
    });

    describe('failures during generation', () => {
        it('returns 500 when the insert is rejected', async () => {
            mockDb.onDefault((state) => {
                if (state.table === 'ai_recommendations') {
                    return state.op === 'select'
                        ? { data: [], error: null }
                        : { data: null, error: { message: 'constraint violation' } };
                }
                if (state.table === 'products') {
                    return { data: [{ id: 'p1', name: 'นมสด', stock_qty: 5, cost_price: 10, price: 20, low_stock_threshold: 2, unit_type: 'ชิ้น' }], count: 1, error: null };
                }
                return { data: [], error: null, count: 0 };
            });
            mockGenerateContent.mockResolvedValue(aiText(JSON.stringify([
                { type: 'info', title: 'ก', detail: 'ข', action_label: 'ดู' }
            ])));

            const res = await request(app).get('/api/ai/recommendations').set(headers);

            expect(res.status).toBe(500);
            expect(res.body.error).toBe('constraint violation');
        });

        it('returns 500 when the model call itself throws', async () => {
            mockDb.onDefault((state) => {
                if (state.table === 'ai_recommendations') return { data: [], error: null };
                if (state.table === 'products') {
                    return { data: [{ id: 'p1', name: 'นมสด', stock_qty: 5, cost_price: 10, price: 20, low_stock_threshold: 2, unit_type: 'ชิ้น' }], count: 1, error: null };
                }
                return { data: [], error: null, count: 0 };
            });
            mockGenerateContent.mockRejectedValue(new Error('API key not valid'));

            const res = await request(app).get('/api/ai/recommendations').set(headers);

            expect(res.status).toBe(500);
            expect(res.body.error).toContain('API key not valid');
        }, 20000);
    });

    describe('GET /api/ai/suggestions (legacy alias)', () => {
        it('serves the same payload as /recommendations', async () => {
            mockDb.on('ai_recommendations', { data: [{ id: 'r1', status: 'pending' }], error: null });

            const res = await request(app).get('/api/ai/suggestions').set(headers);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ success: true, data: [{ id: 'r1', status: 'pending' }], cached: true });
        });

        it('rejects a call with no store id, like the endpoint it forwards to', async () => {
            const res = await request(app).get('/api/ai/suggestions');

            expect(res.status).toBe(400);
        });
    });

    describe('POST /api/ai/apply-promotion finds products the model misspelled', () => {
        /**
         * Serve nothing for the targeted ilike lookup and `catalogue` for the
         * whole-store sweep the fuzzy fallback makes.
         */
        function withFuzzyFallback(catalogue, ilikeRows = []) {
            mockDb.onDefault((state) => {
                if (state.table === 'products') {
                    return state.filters.some((f) => f.name === 'or')
                        ? { data: ilikeRows, error: null }
                        : { data: catalogue, error: null };
                }
                if (state.table === 'promotions') return { data: { id: 'promo-1' }, error: null };
                return { data: [], error: null, count: 0 };
            });
        }

        const body = { productNames: ['นมสค'], discountPercent: 10 };

        it('falls back to a fuzzy match when ilike finds nothing', async () => {
            withFuzzyFallback([{ id: 'p1', name: 'นมสด', price: 20, cost_price: 10, stock_qty: 8, unit_type: 'ขวด' }]);

            const res = await request(app).post('/api/ai/apply-promotion').set(headers).send(body);

            expect(res.status).toBe(200);
            const [insert] = mockDb.callsForOp('promotion_items', 'insert');
            expect(insert.payload[0]).toMatchObject({ product_id: 'p1' });
        });

        it('does not add a product ilike had already returned twice', async () => {
            const row = { id: 'p1', name: 'นมสด', price: 20, cost_price: 10, stock_qty: 8, unit_type: 'ขวด' };
            withFuzzyFallback([row], [row]);

            const res = await request(app).post('/api/ai/apply-promotion').set(headers)
                .send({ productNames: ['นมสด', 'ไม่มีจริง'], discountPercent: 10 });

            expect(res.status).toBe(200);
            expect(mockDb.callsForOp('promotion_items', 'insert')[0].payload).toHaveLength(1);
        });

        it('reports that nothing matched when even the fuzzy sweep comes back empty', async () => {
            withFuzzyFallback([]);

            const res = await request(app).post('/api/ai/apply-promotion').set(headers).send(body);

            expect(res.status).toBe(404);
            expect(res.body.error).toBe('ไม่พบสินค้าที่ตรงกับชื่อที่ระบุ');
        });

        it('refuses to promote a product with nothing on the shelf', async () => {
            withFuzzyFallback([{ id: 'p1', name: 'นมสด', price: 20, cost_price: 10, stock_qty: 0, unit_type: 'ขวด' }]);

            const res = await request(app).post('/api/ai/apply-promotion').set(headers).send(body);

            expect(res.status).toBe(400);
            expect(res.body.error).toContain('สินค้าหมดสต็อก');
            expect(res.body.error).toContain('นมสด (0 ขวด)');
        });

        it('returns 500 when the product lookup itself fails', async () => {
            mockDb.on('products', { data: null, error: { message: 'connection reset' } });

            const res = await request(app).post('/api/ai/apply-promotion').set(headers).send(body);

            expect(res.status).toBe(500);
        });
    });

    describe('POST /api/ai/dispose-product finds products the model misspelled', () => {
        function withFuzzyFallback(catalogue, ilikeRows = []) {
            mockDb.onDefault((state) => {
                if (state.table === 'products') {
                    return state.filters.some((f) => f.name === 'or')
                        ? { data: ilikeRows, error: null }
                        : { data: catalogue, error: null };
                }
                if (state.table === 'product_batches') {
                    return { data: [{ id: 'b1', product_id: 'p1', remaining_qty: 3, expire_date: '2026-08-01' }], error: null };
                }
                return { data: [], error: null, count: 0 };
            });
        }

        beforeEach(() => freezeAt(Date.UTC(2026, 7, 26, 5, 0, 0)));

        it('falls back to a fuzzy match when ilike finds nothing', async () => {
            withFuzzyFallback([{ id: 'p1', name: 'นมสด', stock_qty: 3, unit_type: 'ขวด' }]);

            const res = await request(app).post('/api/ai/dispose-product').set(headers)
                .send({ productNames: ['นมสค'] });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });

        it('marks the recommendation accepted and records what was written off', async () => {
            withFuzzyFallback([{ id: 'p1', name: 'นมสด', stock_qty: 3, unit_type: 'ขวด' }]);

            const res = await request(app).post('/api/ai/dispose-product').set(headers)
                .send({ productNames: ['นมสด'], recommendationId: 'rec-1' });

            expect(res.status).toBe(200);
            const [update] = mockDb.callsForOp('ai_recommendations', 'update');
            expect(update.payload).toMatchObject({ status: 'accepted' });
            expect(update.payload.payload.affected_product_ids).toEqual(['p1']);
            expect(update.payload.actual_outcome).toContain('ตัดสต็อก 3 ขวด');
        });

        it('still writes off the stock when the recommendation update fails', async () => {
            // The disposal already happened; failing to tick the card off must not
            // fail the request and leave the owner thinking nothing was written off.
            mockDb.onDefault((state) => {
                if (state.table === 'products') {
                    return state.filters.some((f) => f.name === 'or')
                        ? { data: [], error: null }
                        : { data: [{ id: 'p1', name: 'นมสด', stock_qty: 3, unit_type: 'ขวด' }], error: null };
                }
                if (state.table === 'product_batches') {
                    return { data: [{ id: 'b1', product_id: 'p1', remaining_qty: 3, expire_date: '2026-08-01' }], error: null };
                }
                if (state.table === 'ai_recommendations' && state.op === 'update') {
                    return { data: null, error: { message: 'row locked' } };
                }
                return { data: [], error: null, count: 0 };
            });

            const res = await request(app).post('/api/ai/dispose-product').set(headers)
                .send({ productNames: ['นมสด'], recommendationId: 'rec-1' });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(mockDb.callsForOp('products', 'update')).not.toHaveLength(0);
        });

        it('returns 500 when the product lookup fails', async () => {
            mockDb.on('products', { data: null, error: { message: 'down' } });

            const res = await request(app).post('/api/ai/dispose-product').set(headers)
                .send({ productNames: ['นมสด'] });

            expect(res.status).toBe(500);
        });

        it('requires a store and a user', async () => {
            const anon = express();
            anon.use(express.json());
            anon.use('/api/ai', aiRoutes);

            const res = await request(anon).post('/api/ai/dispose-product').set(headers)
                .send({ productNames: ['นมสด'] });

            expect(res.status).toBe(400);
        });
    });

    describe('POST /api/ai/recommendations/:id/schedule', () => {
        it('stores the trigger alongside the existing payload', async () => {
            mockDb.on('ai_recommendations', (state) => (state.op === 'select'
                ? { data: [{ payload: { target_products: ['นมสด'] } }], error: null }
                : { data: [{ id: 'r1', status: 'scheduled' }], error: null }));

            const res = await request(app).post('/api/ai/recommendations/r1/schedule').set(headers)
                .send({ trigger_type: 'promotion_ends', promotion_id: 'promo-9', scheduled_price: 25 });

            expect(res.status).toBe(200);
            const [update] = mockDb.callsForOp('ai_recommendations', 'update');
            expect(update.payload).toMatchObject({ status: 'scheduled' });
            expect(update.payload.payload).toEqual({
                target_products: ['นมสด'],
                schedule_trigger: 'promotion_ends',
                trigger_promotion_id: 'promo-9',
                scheduled_price: 25
            });
        });

        it('defaults the trigger to manual and the rest to null', async () => {
            mockDb.on('ai_recommendations', (state) => (state.op === 'select'
                ? { data: [{ payload: {} }], error: null }
                : { data: [{ id: 'r1' }], error: null }));

            await request(app).post('/api/ai/recommendations/r1/schedule').set(headers).send({});

            expect(mockDb.callsForOp('ai_recommendations', 'update')[0].payload.payload).toEqual({
                schedule_trigger: 'manual', trigger_promotion_id: null, scheduled_price: null
            });
        });

        it('requires a store id', async () => {
            const res = await request(app).post('/api/ai/recommendations/r1/schedule').send({});

            expect(res.status).toBe(400);
        });

        it('404s for a recommendation belonging to another store', async () => {
            mockDb.on('ai_recommendations', { data: [], error: null });

            const res = await request(app).post('/api/ai/recommendations/r1/schedule').set(headers).send({});

            expect(res.status).toBe(404);
            expect(res.body.error).toBe('ไม่พบคำแนะนำ');
        });

        it('scopes both the read and the write to the store', async () => {
            mockDb.on('ai_recommendations', (state) => (state.op === 'select'
                ? { data: [{ payload: {} }], error: null }
                : { data: [{ id: 'r1' }], error: null }));

            await request(app).post('/api/ai/recommendations/r1/schedule').set(headers).send({});

            for (const call of mockDb.callsFor('ai_recommendations')) {
                expect(filterArgs(call, 'eq')).toContainEqual(['store_id', STORE_ID]);
            }
        });

        it('returns 500 when the update fails', async () => {
            mockDb.on('ai_recommendations', (state) => (state.op === 'select'
                ? { data: [{ payload: {} }], error: null }
                : { data: null, error: { message: 'write failed' } }));

            const res = await request(app).post('/api/ai/recommendations/r1/schedule').set(headers).send({});

            expect(res.status).toBe(500);
            expect(res.body.error).toBe('write failed');
        });
    });
});
