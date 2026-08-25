const request = require('supertest');
const express = require('express');

// ai.js builds a Gemini client and an admin Supabase client at require time.
let mockDb;
const mockGenerateContent = jest.fn();
const mockSendMessage = jest.fn();
const mockStartChat = jest.fn(() => ({ sendMessage: mockSendMessage }));
const mockGetGenerativeModel = jest.fn(() => ({
    generateContent: mockGenerateContent,
    startChat: mockStartChat
}));

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn(() => mockDb) }));
jest.mock('@google/generative-ai', () => ({
    GoogleGenerativeAI: jest.fn(() => ({ getGenerativeModel: mockGetGenerativeModel }))
}));

const { createMockSupabase, filterArgs } = require('../helpers/mockSupabase');
mockDb = createMockSupabase();

const aiRoutes = require('../../routes/ai');

const STORE_ID = 'store-1';
const USER = { id: 'user-1', email: 'owner@test.dev' };
const headers = { 'x-store-id': STORE_ID };

/** Text response in the shape the Gemini SDK returns. */
const aiText = (text) => ({ response: { text: () => text } });

function buildApp(user = USER) {
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    if (user) app.use((req, _res, next) => { req.user = user; next(); });
    app.use('/api/ai', aiRoutes);
    app.use((req, res) => res.status(404).json({ success: false, error: 'Endpoint not found' }));
    return app;
}

describe('routes/ai endpoints', () => {
    let app;
    let errorSpy;
    let logSpy;

    beforeEach(() => {
        mockDb.reset();
        // getStoreSummary touches many tables; empty rows everywhere by default.
        mockDb.onDefault(() => ({ data: [], error: null, count: 0 }));
        mockGenerateContent.mockResolvedValue(aiText('[]'));
        mockSendMessage.mockResolvedValue(aiText('ok'));
        global.fetch = jest.fn().mockResolvedValue({ json: async () => ({ address: {}, current_weather: { temperature: 30, weathercode: 0 } }) });
        app = buildApp();
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        errorSpy.mockRestore();
        logSpy.mockRestore();
        delete global.fetch;
    });

    describe('GET /api/ai/context', () => {
        it('returns the assembled store context', async () => {
            const res = await request(app).get('/api/ai/context').set(headers);

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(typeof res.body.context).toBe('string');
            expect(res.body.raw).toHaveProperty('salesMonth');
        });

        it('requires a store header', async () => {
            const res = await request(app).get('/api/ai/context');

            expect(res.status).toBe(400);
            expect(res.body).toEqual({ success: false, error: 'Store ID required' });
        });

        it('passes the coordinates through to the weather and geocoding lookups', async () => {
            await request(app).get('/api/ai/context?lat=13.75&lon=100.5').set(headers);

            const urls = global.fetch.mock.calls.map(([url]) => url);
            expect(urls.some((u) => u.includes('open-meteo') && u.includes('latitude=13.75'))).toBe(true);
            expect(urls.some((u) => u.includes('nominatim') && u.includes('lat=13.75'))).toBe(true);
        });

        it('returns 500 when the summary build fails', async () => {
            mockDb.on('orders', () => { throw new Error('db down'); });

            const res = await request(app).get('/api/ai/context').set(headers);

            expect(res.status).toBe(500);
            expect(res.body).toEqual({ success: false, error: 'db down' });
        });
    });

    describe('POST /api/ai/chat', () => {
        it('answers with the model output', async () => {
            mockSendMessage.mockResolvedValue(aiText('วันนี้ขายดีนะ'));

            const res = await request(app).post('/api/ai/chat').set(headers).send({ message: 'สรุปยอดวันนี้' });

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ success: true, answer: 'วันนี้ขายดีนะ' });
            expect(mockSendMessage).toHaveBeenCalledWith('สรุปยอดวันนี้');
        });

        it('builds the model with a system instruction carrying the store context', async () => {
            await request(app).post('/api/ai/chat').set(headers).send({ message: 'hi' });

            const config = mockGetGenerativeModel.mock.calls.at(-1)[0];
            expect(config.systemInstruction).toContain('ผู้จัดการร้านมืออาชีพ');
            expect(config.model).toBe('gemini-3.5-flash-lite');
        });

        it('forwards the prior conversation history to the chat session', async () => {
            const history = [{ role: 'user', parts: [{ text: 'ก่อนหน้านี้' }] }];

            await request(app).post('/api/ai/chat').set(headers).send({ message: 'hi', history });

            expect(mockStartChat).toHaveBeenCalledWith(expect.objectContaining({ history }));
        });

        it('requires a store header', async () => {
            const res = await request(app).post('/api/ai/chat').send({ message: 'hi' });

            expect(res.status).toBe(400);
            expect(mockSendMessage).not.toHaveBeenCalled();
        });

        it('rate limits a user after 20 messages in the window', async () => {
            const userHeaders = { ...headers, 'x-user-id': 'chat-user-limit' };

            for (let i = 0; i < 20; i++) {
                // eslint-disable-next-line no-await-in-loop
                const ok = await request(app).post('/api/ai/chat').set(userHeaders).send({ message: 'hi' });
                expect(ok.status).toBe(200);
            }

            const blocked = await request(app).post('/api/ai/chat').set(userHeaders).send({ message: 'hi' });
            expect(blocked.status).toBe(429);
            expect(blocked.body.error).toContain('20 ข้อความ/5นาที');
        }, 30000);

        it('rewrites a promotion ACTION for an expired product into a dispose action', async () => {
            mockDb.onDefault((state) => {
                if (state.table === 'product_batches') {
                    return {
                        data: [{
                            id: 'b1', batch_no: 'LOT-1', expire_date: '2020-01-01', remaining_qty: 5,
                            products: { id: 'p1', name: 'นมสด', cost_price: 10, price: 20, stock_qty: 5, unit_type: 'ขวด', store_id: STORE_ID }
                        }],
                        error: null
                    };
                }
                return { data: [], error: null, count: 0 };
            });
            mockSendMessage.mockResolvedValue(aiText('จัดโปรเลย [ACTION:{"type":"promotion","promotionType":"discount_percent","percent":20,"products":["นมสด"],"days":3}]'));

            const res = await request(app).post('/api/ai/chat').set(headers).send({ message: 'จัดโปร' });

            expect(res.body.answer).toContain('"type":"dispose"');
            expect(res.body.answer).not.toContain('discount_percent');
        });

        it('strips a promotion ACTION for a zero-stock product', async () => {
            mockDb.onDefault((state) => {
                if (state.table === 'products') {
                    return { data: [{ id: 'p9', name: 'น้ำปลา', stock_qty: 0, cost_price: 5, price: 10, low_stock_threshold: 0, unit_type: 'ขวด' }], error: null, count: 1 };
                }
                return { data: [], error: null, count: 0 };
            });
            mockSendMessage.mockResolvedValue(aiText('ลองดู [ACTION:{"type":"promotion","products":["น้ำปลา"],"percent":10}] นะ'));

            const res = await request(app).post('/api/ai/chat').set(headers).send({ message: 'จัดโปร' });

            expect(res.body.answer).not.toContain('ACTION');
            expect(res.body.answer).toContain('ลองดู');
        });

        it('leaves a dispose action and an unrelated promotion untouched', async () => {
            const answer = 'a [ACTION:{"type":"dispose","products":["ของเก่า"]}] b [ACTION:{"type":"promotion","products":["ของใหม่"],"percent":5}]';
            mockSendMessage.mockResolvedValue(aiText(answer));

            const res = await request(app).post('/api/ai/chat').set(headers).send({ message: 'x' });

            expect(res.body.answer).toBe(answer);
        });

        it('repairs a loosely formatted ACTION block before inspecting it', async () => {
            mockSendMessage.mockResolvedValue(aiText("[ACTION:{type:'promotion',products:['ของใหม่'],percent:5,}]"));

            const res = await request(app).post('/api/ai/chat').set(headers).send({ message: 'x' });

            expect(res.status).toBe(200);
            expect(res.body.answer).toContain('ACTION');
        });

        it('leaves an unparseable ACTION block as-is', async () => {
            const answer = '[ACTION:{not json at all}]';
            mockSendMessage.mockResolvedValue(aiText(answer));

            const res = await request(app).post('/api/ai/chat').set(headers).send({ message: 'x' });

            expect(res.body.answer).toBe(answer);
        });

        it('returns 500 when the model call fails', async () => {
            mockSendMessage.mockRejectedValue(new Error('400 quota'));

            const res = await request(app).post('/api/ai/chat').set(headers).send({ message: 'hi' });

            expect(res.status).toBe(500);
            expect(res.body).toEqual({ success: false, error: '400 quota' });
        });
    });

    describe('GET /api/ai/recommendations', () => {
        it('requires both a store and a user id', async () => {
            const anonApp = buildApp(null);

            const noStore = await request(app).get('/api/ai/recommendations');
            expect(noStore.status).toBe(400);

            const noUser = await request(anonApp).get('/api/ai/recommendations').set(headers);
            expect(noUser.status).toBe(400);
            expect(noUser.body.error).toBe('Store and User ID required');
        });

        it('returns only the pending items when recommendations already exist for the period', async () => {
            const existing = [
                { id: 'r1', status: 'pending', created_at: '2025-03-12T01:00:00Z' },
                { id: 'r2', status: 'accepted', created_at: '2025-03-12T02:00:00Z' }
            ];
            mockDb.on('ai_recommendations', { data: existing, error: null });

            const res = await request(app).get('/api/ai/recommendations').set(headers);

            expect(res.body).toEqual({ success: true, data: [existing[0]], cached: true });
            expect(mockGenerateContent).not.toHaveBeenCalled();
        });

        it('reports an empty store instead of calling the model', async () => {
            mockDb.on('ai_recommendations', { data: [], error: null })
                .on('products', { count: 0, data: [], error: null });

            const res = await request(app).get('/api/ai/recommendations').set(headers);

            expect(res.body).toEqual({ success: true, data: [], emptyStore: true });
            expect(mockGenerateContent).not.toHaveBeenCalled();
        });

        it('scopes the existing-recommendation lookup to the store and user', async () => {
            mockDb.on('ai_recommendations', { data: [{ id: 'r1', status: 'pending' }], error: null });

            await request(app).get('/api/ai/recommendations').set(headers);

            const [call] = mockDb.callsFor('ai_recommendations');
            expect(filterArgs(call, 'eq')).toContainEqual(['store_id', STORE_ID]);
            expect(filterArgs(call, 'eq')).toContainEqual(['user_id', USER.id]);
        });

        it('prefers the x-user-id header over the authenticated user', async () => {
            mockDb.on('ai_recommendations', { data: [{ id: 'r1', status: 'pending' }], error: null });

            await request(app).get('/api/ai/recommendations').set({ ...headers, 'x-user-id': 'header-user' });

            expect(filterArgs(mockDb.callsFor('ai_recommendations')[0], 'eq')).toContainEqual(['user_id', 'header-user']);
        });

        it('generates and stores new recommendations when none exist yet', async () => {
            let recReads = 0;
            mockDb.onDefault((state) => {
                if (state.table === 'ai_recommendations') {
                    if (state.op === 'select') { recReads += 1; return { data: [], error: null }; }
                    return { data: [{ id: 'new-1' }], error: null };
                }
                if (state.table === 'products') return { data: [{ id: 'p1', name: 'นมสด', stock_qty: 5, cost_price: 10, price: 20, low_stock_threshold: 2, unit_type: 'ขวด' }], count: 1, error: null };
                return { data: [], error: null, count: 0 };
            });
            mockGenerateContent.mockResolvedValue(aiText(JSON.stringify([
                { type: 'info', title: 'ลองจัดโปร', detail: 'รายละเอียด', expected_impact: 'ขายดีขึ้น', action_label: 'จัดโปร' }
            ])));

            const res = await request(app).get('/api/ai/recommendations').set(headers);

            expect(res.status).toBe(200);
            expect(res.body.data).toEqual([{ id: 'new-1' }]);

            const [insert] = mockDb.callsForOp('ai_recommendations', 'insert');
            expect(insert.payload[0]).toMatchObject({
                store_id: STORE_ID, user_id: USER.id, type: 'info', title: 'ลองจัดโปร', status: 'pending'
            });
            expect(recReads).toBeGreaterThan(0);
        });

        /** Serve an empty recommendation table, one product, and capture the insert. */
        function withGeneration(products = [{ id: 'p1', name: 'นมสด', stock_qty: 5, price: 14, cost_price: 12, low_stock_threshold: 2, unit_type: 'ชิ้น' }]) {
            return mockDb.onDefault((state) => {
                if (state.table === 'ai_recommendations') {
                    return state.op === 'select' ? { data: [], error: null } : { data: [{ id: 'new-1' }], error: null };
                }
                if (state.table === 'products') return { data: products, count: products.length, error: null };
                return { data: [], error: null, count: 0 };
            });
        }

        it('strips the chain-of-thought member instead of storing it as advice', async () => {
            withGeneration();
            mockGenerateContent.mockResolvedValue(aiText(JSON.stringify([
                { _thinking: '1) รายชื่อสินค้า... 2) จับคู่...' },
                { type: 'stock', title: 'เติมสต็อกนมสด', detail: 'ขายดี', action_label: 'เติมสต็อก', target_products: ['นมสด'] }
            ])));

            const res = await request(app).get('/api/ai/recommendations').set(headers);

            expect(res.status).toBe(200);
            const rows = mockDb.callsForOp('ai_recommendations', 'insert')[0].payload;
            expect(rows).toHaveLength(1);
            expect(rows[0].title).toBe('เติมสต็อกนมสด');
            expect(JSON.stringify(rows)).not.toContain('_thinking');
        });

        it('never lets the same product headline two recommendations', async () => {
            withGeneration();
            mockGenerateContent.mockResolvedValue(aiText(JSON.stringify([
                { type: 'pricing', title: 'ปรับราคานมสด', detail: 'x', action_label: 'ปรับราคา', target_products: ['นมสด'] },
                { type: 'promotion', title: 'จัดโปรนมสดอีกที', detail: 'y', action_label: 'ลด 10%', target_products: ['นมสด'] },
                { type: 'debt', title: 'ทวงหนี้', detail: 'z', action_label: 'ทวงถาม', target_customers: ['ป้าสมศรี'] }
            ])));

            const res = await request(app).get('/api/ai/recommendations').set(headers);

            expect(res.status).toBe(200);
            const rows = mockDb.callsForOp('ai_recommendations', 'insert')[0].payload;
            expect(rows).toHaveLength(2); // the repeat is dropped, the debt card survives
            expect(rows.map((r) => r.title)).toEqual(['ปรับราคานมสด', 'ทวงหนี้']);
        });

        it('keeps a card that only partly overlaps, minus the repeated product', async () => {
            withGeneration([
                { id: 'p1', name: 'นมสด', stock_qty: 5, price: 14, cost_price: 12, low_stock_threshold: 2, unit_type: 'ชิ้น' },
                { id: 'p2', name: 'ขนมปัง', stock_qty: 5, price: 28, cost_price: 20, low_stock_threshold: 2, unit_type: 'ถุง' }
            ]);
            mockGenerateContent.mockResolvedValue(aiText(JSON.stringify([
                { type: 'stock', title: 'a', detail: 'x', action_label: 'เติมสต็อก', target_products: ['นมสด'] },
                { type: 'promotion', title: 'b', detail: 'y', action_label: 'ลด 10%', target_products: ['นมสด', 'ขนมปัง'] }
            ])));

            await request(app).get('/api/ai/recommendations').set(headers);

            const rows = mockDb.callsForOp('ai_recommendations', 'insert')[0].payload;
            expect(rows).toHaveLength(2);
            expect(rows[1].payload.target_products).toEqual(['ขนมปัง']);
        });

        it('marks a 100% discount as a dispose action, whatever the model called it', async () => {
            withGeneration();
            mockGenerateContent.mockResolvedValue(aiText(JSON.stringify([
                {
                    type: 'expiry', title: 'ตัดสต็อกนมสด', detail: 'หมดอายุแล้ว', action_label: 'ตัดสต็อกทิ้ง',
                    target_products: ['นมสด'],
                    recommended_discount: { promotion_type: 'discount_percent', percent: 100, reason: 'หมดอายุ' }
                }
            ])));

            await request(app).get('/api/ai/recommendations').set(headers);

            const row = mockDb.callsForOp('ai_recommendations', 'insert')[0].payload[0];
            expect(row.payload.recommended_discount).toMatchObject({ percent: 100, action: 'dispose' });
        });

        it('leaves an ordinary discount untouched', async () => {
            withGeneration();
            mockGenerateContent.mockResolvedValue(aiText(JSON.stringify([
                {
                    type: 'promotion', title: 'ลดราคานมสด', detail: 'ระบายสต็อก', action_label: 'ลด 30%',
                    target_products: ['นมสด'],
                    recommended_discount: { promotion_type: 'discount_percent', percent: 30 }
                }
            ])));

            await request(app).get('/api/ai/recommendations').set(headers);

            const row = mockDb.callsForOp('ai_recommendations', 'insert')[0].payload[0];
            expect(row.payload.recommended_discount).toEqual({ promotion_type: 'discount_percent', percent: 30 });
        });

        it('rounds a suggested price the model did not round', async () => {
            withGeneration();
            mockGenerateContent.mockResolvedValue(aiText(JSON.stringify([
                {
                    type: 'pricing', title: 'ขึ้นราคานมสด', detail: 'กำไรบาง', action_label: 'ปรับราคา',
                    target_products: ['นมสด'], current_price: 14, suggested_price: 16, recommended_discount: null
                }
            ])));

            await request(app).get('/api/ai/recommendations').set(headers);

            const row = mockDb.callsForOp('ai_recommendations', 'insert')[0].payload[0];
            expect(row.payload.suggested_price).toBe(15);
            expect(row.payload.suggested_price % 5).toBe(0);
        });

        it('rejects an unparseable model response with a Thai error', async () => {
            mockDb.onDefault((state) => {
                if (state.table === 'products') return { data: [{ id: 'p1', name: 'x', stock_qty: 1 }], count: 1, error: null };
                return { data: [], error: null, count: 0 };
            });
            mockGenerateContent.mockResolvedValue(aiText('sorry, I cannot do that'));

            const res = await request(app).get('/api/ai/recommendations').set(headers);

            expect(res.status).toBe(500);
            expect(res.body.error).toBe('AI ตอบกลับผิดรูปแบบ กรุณาลองใหม่อีกครั้ง');
        });

        it('strips markdown fences from the model response before parsing', async () => {
            mockDb.onDefault((state) => {
                if (state.table === 'ai_recommendations') {
                    return state.op === 'select' ? { data: [], error: null } : { data: [{ id: 'new-1' }], error: null };
                }
                if (state.table === 'products') return { data: [{ id: 'p1', name: 'x', stock_qty: 1, price: 10, cost_price: 5 }], count: 1, error: null };
                return { data: [], error: null, count: 0 };
            });
            mockGenerateContent.mockResolvedValue(aiText('```json\n[{"type":"info","title":"t","detail":"d"}]\n```'));

            const res = await request(app).get('/api/ai/recommendations').set(headers);

            expect(res.status).toBe(200);
            expect(mockDb.callsForOp('ai_recommendations', 'insert')).toHaveLength(1);
        });
    });

    describe('POST /api/ai/recommendations/:id/action', () => {
        it('records an accepted action with a timestamp', async () => {
            mockDb.on('ai_recommendations', (state) =>
                state.op === 'select' ? { data: { payload: null }, error: null } : { data: { id: 'r1' }, error: null });

            const res = await request(app).post('/api/ai/recommendations/r1/action').set(headers).send({ action: 'accepted' });

            expect(res.status).toBe(200);
            const [update] = mockDb.callsForOp('ai_recommendations', 'update');
            expect(update.payload).toMatchObject({ status: 'accepted' });
            expect(update.payload.acted_at).toEqual(expect.any(String));
            expect(filterArgs(update, 'eq')).toContainEqual(['id', 'r1']);
            expect(filterArgs(update, 'eq')).toContainEqual(['store_id', STORE_ID]);
        });

        it('records a skipped action without enriching the payload', async () => {
            mockDb.on('ai_recommendations', { data: { id: 'r1' }, error: null });

            const res = await request(app).post('/api/ai/recommendations/r1/action').set(headers).send({ action: 'skipped' });

            expect(res.status).toBe(200);
            expect(mockDb.callsForOp('ai_recommendations', 'update')[0].payload).not.toHaveProperty('payload');
            expect(mockDb.callsFor('products')).toHaveLength(0);
        });

        it('stores the reported outcome and amount when supplied', async () => {
            mockDb.on('ai_recommendations', { data: { id: 'r1' }, error: null });

            await request(app).post('/api/ai/recommendations/r1/action').set(headers)
                .send({ action: 'skipped', actual_outcome: 'ไม่ได้ทำ', actual_amount: 0 });

            expect(mockDb.callsForOp('ai_recommendations', 'update')[0].payload)
                .toMatchObject({ actual_outcome: 'ไม่ได้ทำ', actual_amount: 0 });
        });

        it('tags the affected product ids when accepting a product recommendation', async () => {
            mockDb
                .on('ai_recommendations', (state) => state.op === 'select'
                    ? { data: { payload: { target_products: ['นมสด'] } }, error: null }
                    : { data: { id: 'r1' }, error: null })
                .on('products', { data: [{ id: 'p1', name: 'นมสดพาสเจอร์ไรส์' }], error: null });

            await request(app).post('/api/ai/recommendations/r1/action').set(headers).send({ action: 'accepted' });

            expect(mockDb.callsForOp('ai_recommendations', 'update')[0].payload.payload)
                .toMatchObject({ affected_product_ids: ['p1'] });
        });

        it('falls back to fuzzy matching when the ilike lookup misses', async () => {
            let productReads = 0;
            mockDb
                .on('ai_recommendations', (state) => state.op === 'select'
                    ? { data: { payload: { target_products: ['นมสด'] } }, error: null }
                    : { data: { id: 'r1' }, error: null })
                .on('products', () => {
                    productReads += 1;
                    return productReads === 1
                        ? { data: [], error: null }
                        : { data: [{ id: 'p9', name: 'นมสดพาสเจอร์ไรส์' }], error: null };
                });

            await request(app).post('/api/ai/recommendations/r1/action').set(headers).send({ action: 'accepted' });

            expect(productReads).toBe(2);
            expect(mockDb.callsForOp('ai_recommendations', 'update')[0].payload.payload)
                .toMatchObject({ affected_product_ids: ['p9'] });
        });

        it('tags affected customers when the recommendation targets them', async () => {
            mockDb
                .on('ai_recommendations', (state) => state.op === 'select'
                    ? { data: { payload: { target_customers: ['สมชาย'] } }, error: null }
                    : { data: { id: 'r1' }, error: null })
                .on('customers', { data: [{ id: 'c1' }], error: null });

            await request(app).post('/api/ai/recommendations/r1/action').set(headers).send({ action: 'accepted' });

            expect(mockDb.callsForOp('ai_recommendations', 'update')[0].payload.payload)
                .toMatchObject({ affected_customer_ids: ['c1'] });
        });

        it('rejects an unknown action', async () => {
            const res = await request(app).post('/api/ai/recommendations/r1/action').set(headers).send({ action: 'maybe' });

            expect(res.status).toBe(400);
            expect(res.body).toEqual({ success: false, error: 'Invalid action' });
            expect(mockDb.from).not.toHaveBeenCalled();
        });

        it('requires a store and a user id', async () => {
            const res = await request(app).post('/api/ai/recommendations/r1/action').send({ action: 'accepted' });

            expect(res.status).toBe(400);
            expect(res.body.error).toBe('Store and User ID required');
        });

        it('returns 500 when the update fails', async () => {
            mockDb.on('ai_recommendations', { data: null, error: { message: 'row locked' } });

            const res = await request(app).post('/api/ai/recommendations/r1/action').set(headers).send({ action: 'skipped' });

            expect(res.status).toBe(500);
            expect(res.body).toEqual({ success: false, error: 'row locked' });
        });
    });

    describe('GET /api/ai/recommendations/history', () => {
        it('groups actioned recommendations by Thai-relative day labels', async () => {
            const now = Date.now();
            const iso = (offsetDays) => new Date(now - offsetDays * 86400000).toISOString();
            mockDb.on('ai_recommendations', {
                data: [
                    { id: 'a', status: 'skipped', acted_at: iso(0), created_at: iso(0) },
                    { id: 'b', status: 'skipped', acted_at: iso(1), created_at: iso(1) }
                ],
                error: null
            });

            const res = await request(app).get('/api/ai/recommendations/history').set(headers);

            expect(res.status).toBe(200);
            expect(Object.keys(res.body.data)).toEqual(expect.arrayContaining(['วันนี้', 'เมื่อวาน']));
        });

        it('reads only actioned rows within the requested window', async () => {
            mockDb.on('ai_recommendations', { data: [], error: null });

            await request(app).get('/api/ai/recommendations/history?days=7').set(headers);

            const [call] = mockDb.callsFor('ai_recommendations');
            expect(filterArgs(call, 'neq')).toContainEqual(['status', 'pending']);
            const [[, cutoff]] = filterArgs(call, 'gte');
            const age = Date.now() - new Date(cutoff).getTime();
            expect(age).toBeGreaterThan(6.9 * 86400000);
            expect(age).toBeLessThan(7.1 * 86400000);
        });

        it('defaults the window to 30 days', async () => {
            mockDb.on('ai_recommendations', { data: [], error: null });

            await request(app).get('/api/ai/recommendations/history').set(headers);

            const [[, cutoff]] = filterArgs(mockDb.callsFor('ai_recommendations')[0], 'gte');
            const age = Date.now() - new Date(cutoff).getTime();
            expect(age).toBeGreaterThan(29.9 * 86400000);
        });

        it('requires a store and a user id', async () => {
            expect((await request(app).get('/api/ai/recommendations/history')).status).toBe(400);
        });

        it('returns 500 when the query fails', async () => {
            mockDb.on('ai_recommendations', { data: null, error: { message: 'down' } });

            expect((await request(app).get('/api/ai/recommendations/history').set(headers)).status).toBe(500);
        });
    });

    describe('GET /api/ai/recommendations/stats', () => {
        it('summarises acceptance rate, money earned and the type breakdown', async () => {
            mockDb.on('ai_recommendations', {
                data: [
                    { id: 'a', status: 'accepted', type: 'expiry', actual_amount: '100' },
                    { id: 'b', status: 'accepted', type: 'debt', actual_amount: '50' },
                    { id: 'c', status: 'skipped', type: 'stock', actual_amount: null },
                    { id: 'd', status: 'skipped', type: 'stock', actual_amount: null }
                ],
                error: null
            });

            const res = await request(app).get('/api/ai/recommendations/stats').set(headers);

            expect(res.status).toBe(200);
            expect(res.body.data).toMatchObject({
                totalRecommendations: 4,
                followedCount: 2,
                followedPercent: 50,
                moneyEarned: 150,
                byType: { expiry: 1, debt: 1, stock: 0 }
            });
        });

        it('labels the period', async () => {
            mockDb.on('ai_recommendations', { data: [], error: null });

            const today = await request(app).get('/api/ai/recommendations/stats?period=today').set(headers);
            const month = await request(app).get('/api/ai/recommendations/stats?period=month').set(headers);
            const week = await request(app).get('/api/ai/recommendations/stats').set(headers);

            expect(today.body.data.label).toBe('วันนี้');
            expect(month.body.data.label).toBe('เดือนนี้');
            expect(week.body.data.label).toMatch(/^สัปดาห์ที่ \d$/);
        });

        it('reports zero percent instead of dividing by zero', async () => {
            mockDb.on('ai_recommendations', { data: [], error: null });

            const res = await request(app).get('/api/ai/recommendations/stats').set(headers);

            expect(res.body.data).toMatchObject({ totalRecommendations: 0, followedPercent: 0, moneyEarned: 0 });
        });

        it('keeps weekOfMonth local - nothing leaks onto globalThis', async () => {
            delete globalThis.weekOfMonth;
            mockDb.on('ai_recommendations', { data: [], error: null });

            const res = await request(app).get('/api/ai/recommendations/stats').set(headers);

            expect(res.body.data.label).toMatch(/^สัปดาห์ที่ \d$/);
            expect(globalThis.weekOfMonth).toBeUndefined();
        });

        it('requires a store and a user id, and reports query failures', async () => {
            expect((await request(app).get('/api/ai/recommendations/stats')).status).toBe(400);

            mockDb.on('ai_recommendations', { data: null, error: { message: 'down' } });
            expect((await request(app).get('/api/ai/recommendations/stats').set(headers)).status).toBe(500);
        });
    });

    describe('GET /api/ai/active-promotions', () => {
        it('returns the store promotions that are live today', async () => {
            const promos = [{ id: 'promo-1', name: 'AI แนะนำ: ลด 20%' }];
            mockDb.on('promotions', (state) => (state.op === 'select' ? { data: promos, error: null } : { data: null, error: null }));

            const res = await request(app).get('/api/ai/active-promotions').set(headers);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ success: true, data: promos });
        });

        it('deactivates promotions whose end date has passed before listing', async () => {
            mockDb.on('promotions', (state) => (state.op === 'select' ? { data: [], error: null } : { data: null, error: null }));

            await request(app).get('/api/ai/active-promotions').set(headers);

            const [cleanup] = mockDb.callsForOp('promotions', 'update');
            expect(cleanup.payload).toEqual({ is_active: false });
            expect(filterArgs(cleanup, 'eq')).toContainEqual(['is_active', true]);
            expect(filterArgs(cleanup, 'lt')[0][0]).toBe('end_date');
        });

        it('returns an empty array when the listing yields nothing', async () => {
            mockDb.on('promotions', { data: null, error: null });

            expect((await request(app).get('/api/ai/active-promotions').set(headers)).body.data).toEqual([]);
        });
    });

    describe('PATCH /api/ai/promotions/:id/deactivate', () => {
        it('deactivates one promotion scoped to the store', async () => {
            mockDb.on('promotions', { data: { id: 'promo-1', is_active: false }, error: null });

            const res = await request(app).patch('/api/ai/promotions/promo-1/deactivate').set(headers);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ success: true, data: { id: 'promo-1', is_active: false } });

            const [update] = mockDb.callsForOp('promotions', 'update');
            expect(update.payload).toEqual({ is_active: false });
            expect(filterArgs(update, 'eq')).toContainEqual(['id', 'promo-1']);
            expect(filterArgs(update, 'eq')).toContainEqual(['store_id', STORE_ID]);
        });
    });

    describe('POST /api/ai/apply-promotion', () => {
        const body = { productNames: ['นมสด'], discountPercent: 20 };
        const userHeaders = { ...headers, 'x-user-id': USER.id };

        function withProducts(products) {
            return mockDb.onDefault((state) => {
                if (state.table === 'products') return { data: products, error: null };
                if (state.table === 'promotion_items') return { data: [], error: null };
                if (state.table === 'promotions') return { data: { id: 'promo-1' }, error: null };
                return { data: [], error: null, count: 0 };
            });
        }

        it('creates a percentage promotion and links the products', async () => {
            withProducts([{ id: 'p1', name: 'นมสด', price: 20, cost_price: 10, stock_qty: 5, unit_type: 'ขวด' }]);

            const res = await request(app).post('/api/ai/apply-promotion').set(userHeaders).send(body);

            expect(res.status).toBe(200);
            const [promo] = mockDb.callsForOp('promotions', 'insert');
            expect(promo.payload[0]).toMatchObject({
                type: 'discount_percent', discount_value: 20, store_id: STORE_ID, is_active: true, created_by: USER.id
            });
            expect(promo.payload[0].name).toContain('ลด 20%');

            expect(mockDb.callsForOp('promotion_items', 'insert')[0].payload)
                .toEqual([{ promotion_id: 'promo-1', product_id: 'p1' }]);
        });

        it('reports the discounted price for each affected product', async () => {
            withProducts([{ id: 'p1', name: 'นมสด', price: 20, stock_qty: 5 }]);

            const res = await request(app).post('/api/ai/apply-promotion').set(userHeaders).send(body);

            expect(res.body.data.affectedProducts[0]).toMatchObject({ id: 'p1', originalPrice: 20, discountedPrice: 16 });
        });

        it('supports buy-x-get-y promotions', async () => {
            withProducts([{ id: 'p1', name: 'นมสด', price: 20, stock_qty: 5 }]);

            const res = await request(app).post('/api/ai/apply-promotion').set(userHeaders)
                .send({ productNames: ['นมสด'], promotionType: 'buy_x_get_y', minQtyRequired: 2, freeQtyAmount: 1 });

            expect(res.status).toBe(200);
            expect(mockDb.callsForOp('promotions', 'insert')[0].payload[0]).toMatchObject({
                type: 'buy_x_get_y', min_qty_required: 2, free_qty: 1, discount_value: 0
            });
        });

        it('supports fixed-amount and bundle promotions', async () => {
            withProducts([{ id: 'p1', name: 'นมสด', price: 20, stock_qty: 5 }]);

            const amount = await request(app).post('/api/ai/apply-promotion').set(userHeaders)
                .send({ productNames: ['นมสด'], promotionType: 'discount_amount', discountAmount: 7 });
            expect(amount.body.data.affectedProducts[0].discountedPrice).toBe(13);

            const bundle = await request(app).post('/api/ai/apply-promotion').set(userHeaders)
                .send({ productNames: ['นมสด'], promotionType: 'bundle', minSpend: 100 });
            expect(bundle.status).toBe(200);
            expect(mockDb.callsForOp('promotions', 'insert').at(-1).payload[0]).toMatchObject({ type: 'bundle', min_spend: 100 });
        });

        it('refuses a 100% discount and points at the dispose endpoint', async () => {
            withProducts([{ id: 'p1', name: 'นมสด', price: 20, stock_qty: 5 }]);

            const res = await request(app).post('/api/ai/apply-promotion').set(userHeaders)
                .send({ productNames: ['นมสด'], discountPercent: 100 });

            expect(res.status).toBe(400);
            expect(res.body.error).toContain('dispose');
            expect(mockDb.callsForOp('promotions', 'insert')).toHaveLength(0);
        });

        it('refuses when a matched product is out of stock', async () => {
            withProducts([{ id: 'p1', name: 'นมสด', price: 20, stock_qty: 0, unit_type: 'ขวด' }]);

            const res = await request(app).post('/api/ai/apply-promotion').set(userHeaders).send(body);

            expect(res.status).toBe(400);
            expect(res.body.error).toContain('หมดสต็อก');
        });

        it('returns 404 when no product matches the requested names', async () => {
            withProducts([]);

            const res = await request(app).post('/api/ai/apply-promotion').set(userHeaders)
                .send({ productNames: ['ไม่มีสินค้านี้'], discountPercent: 10 });

            expect(res.status).toBe(404);
            expect(res.body.error).toContain('ไม่พบสินค้า');
        });

        it('refuses when every matched product already has an active promotion', async () => {
            mockDb.onDefault((state) => {
                if (state.table === 'products') return { data: [{ id: 'p1', name: 'นมสด', price: 20, stock_qty: 5 }], error: null };
                if (state.table === 'promotion_items') return { data: [{ product_id: 'p1' }], error: null };
                return { data: [], error: null, count: 0 };
            });

            const res = await request(app).post('/api/ai/apply-promotion').set(userHeaders).send(body);

            expect(res.status).toBe(400);
            expect(res.body.error).toContain('มีโปรโมชั่นอยู่แล้ว');
        });

        it('skips conflicting products and warns, when at least one is eligible', async () => {
            mockDb.onDefault((state) => {
                if (state.table === 'products') {
                    return {
                        data: [
                            { id: 'p1', name: 'นมสด', price: 20, stock_qty: 5 },
                            { id: 'p2', name: 'ขนมปัง', price: 30, stock_qty: 5 }
                        ],
                        error: null
                    };
                }
                if (state.table === 'promotion_items' && state.op === 'select') return { data: [{ product_id: 'p1' }], error: null };
                if (state.table === 'promotions') return { data: { id: 'promo-1' }, error: null };
                return { data: [], error: null, count: 0 };
            });

            const res = await request(app).post('/api/ai/apply-promotion').set(userHeaders)
                .send({ productNames: ['นมสด', 'ขนมปัง'], discountPercent: 15 });

            expect(res.status).toBe(200);
            expect(res.body.skippedWarning).toContain('นมสด');
            expect(mockDb.callsForOp('promotion_items', 'insert')[0].payload)
                .toEqual([{ promotion_id: 'promo-1', product_id: 'p2' }]);
        });

        it('marks the source recommendation as accepted when one is supplied', async () => {
            mockDb.onDefault((state) => {
                if (state.table === 'products') return { data: [{ id: 'p1', name: 'นมสด', price: 20, stock_qty: 5 }], error: null };
                if (state.table === 'promotions') return { data: { id: 'promo-1' }, error: null };
                if (state.table === 'ai_recommendations') return { data: { detail: 'เหตุผลจาก AI', payload: {} }, error: null };
                return { data: [], error: null, count: 0 };
            });

            await request(app).post('/api/ai/apply-promotion').set(userHeaders).send({ ...body, recommendationId: 'r1' });

            const [update] = mockDb.callsForOp('ai_recommendations', 'update');
            expect(update.payload).toMatchObject({ status: 'accepted' });
            expect(update.payload.payload.affected_product_ids).toEqual(['p1']);
            expect(mockDb.callsForOp('promotions', 'insert')[0].payload[0].description).toBe('เหตุผลจาก AI');
        });

        it('requires a store and a user id', async () => {
            const anonApp = buildApp(null);

            const res = await request(anonApp).post('/api/ai/apply-promotion').set(headers).send(body);

            expect(res.status).toBe(400);
            expect(res.body.error).toBe('Store and User ID required');
        });

        it('reports a usable error when the promotion row comes back empty', async () => {
            // Previously this dereferenced null and surfaced
            // "Cannot read properties of null (reading 'id')" to the app.
            mockDb.onDefault((state) => {
                if (state.table === 'products') return { data: [{ id: 'p1', name: 'นมสด', price: 20, stock_qty: 5 }], error: null };
                if (state.table === 'promotions') return { data: null, error: null };
                return { data: [], error: null, count: 0 };
            });

            const res = await request(app).post('/api/ai/apply-promotion').set(userHeaders).send(body);

            expect(res.status).toBe(500);
            expect(res.body.error).toBe('ไม่สามารถสร้างโปรโมชั่นได้ กรุณาลองใหม่อีกครั้ง');
            expect(mockDb.callsFor('promotion_items').filter((c) => c.op === 'insert')).toHaveLength(0);
        });

        it('returns 500 when the promotion insert fails', async () => {
            mockDb.onDefault((state) => {
                if (state.table === 'products') return { data: [{ id: 'p1', name: 'นมสด', price: 20, stock_qty: 5 }], error: null };
                if (state.table === 'promotions') return { data: null, error: { message: 'insert failed' } };
                return { data: [], error: null, count: 0 };
            });

            const res = await request(app).post('/api/ai/apply-promotion').set(userHeaders).send(body);

            expect(res.status).toBe(500);
            expect(res.body).toEqual({ success: false, error: 'insert failed' });
        });
    });

    describe('POST /api/ai/dispose-product', () => {
        const userHeaders = { ...headers, 'x-user-id': USER.id };

        it('zeroes the expired batches, logs the movement and lowers the stock', async () => {
            mockDb.onDefault((state) => {
                if (state.table === 'products' && state.op === 'select') {
                    return { data: [{ id: 'p1', name: 'นมสด', stock_qty: '10', unit_type: 'ขวด' }], error: null };
                }
                if (state.table === 'product_batches' && state.op === 'select') {
                    return { data: [{ id: 'b1', batch_no: 'LOT-1', remaining_qty: '4', expire_date: '2020-01-01' }], error: null };
                }
                return { data: [], error: null, count: 0 };
            });

            const res = await request(app).post('/api/ai/dispose-product').set(userHeaders).send({ productNames: ['นมสด'] });

            expect(res.status).toBe(200);
            expect(res.body.data).toMatchObject({ totalDisposed: 4 });
            expect(res.body.data.disposedItems[0]).toMatchObject({ productName: 'นมสด', batchNo: 'LOT-1', qty: 4 });

            expect(mockDb.callsForOp('product_batches', 'update')[0].payload).toEqual({ remaining_qty: 0 });
            expect(mockDb.callsForOp('inventory_transactions', 'insert')[0].payload[0]).toMatchObject({
                product_id: 'p1', batch_id: 'b1', trans_type: 'out', qty: 4, reference_type: 'dispose', store_id: STORE_ID
            });
            expect(mockDb.callsForOp('products', 'update')[0].payload).toEqual({ stock_qty: 6 });
        });

        it('never soft-deletes the product, even when stock reaches zero', async () => {
            mockDb.onDefault((state) => {
                if (state.table === 'products' && state.op === 'select') {
                    return { data: [{ id: 'p1', name: 'นมสด', stock_qty: '4' }], error: null };
                }
                if (state.table === 'product_batches' && state.op === 'select') {
                    return { data: [{ id: 'b1', batch_no: 'L', remaining_qty: '4', expire_date: '2020-01-01' }], error: null };
                }
                return { data: [], error: null, count: 0 };
            });

            await request(app).post('/api/ai/dispose-product').set(userHeaders).send({ productNames: ['นมสด'] });

            const [update] = mockDb.callsForOp('products', 'update');
            expect(update.payload).toEqual({ stock_qty: 0 });
            expect(update.payload).not.toHaveProperty('deleted_at');
        });

        it('falls back to the raw stock quantity when the product has no batches', async () => {
            mockDb.onDefault((state) => {
                if (state.table === 'products' && state.op === 'select') {
                    return { data: [{ id: 'p1', name: 'นมสด', stock_qty: '7' }], error: null };
                }
                return { data: [], error: null, count: 0 };
            });

            const res = await request(app).post('/api/ai/dispose-product').set(userHeaders).send({ productNames: ['นมสด'] });

            expect(res.body.data.totalDisposed).toBe(7);
            expect(res.body.data.disposedItems[0]).toMatchObject({ batchNo: null, qty: 7 });
            expect(mockDb.callsForOp('products', 'update')[0].payload).toEqual({ stock_qty: 0 });
        });

        it('reports nothing disposed when no product matches', async () => {
            mockDb.onDefault(() => ({ data: [], error: null, count: 0 }));

            const res = await request(app).post('/api/ai/dispose-product').set(userHeaders).send({ productNames: ['ไม่มี'] });

            expect(res.status).toBe(200);
            expect(res.body.data).toEqual({ totalDisposed: 0, disposedItems: [] });
        });

        it('accepts the recommendation id under either "recommendationId" or "id"', async () => {
            mockDb.onDefault((state) => {
                if (state.table === 'products' && state.op === 'select') return { data: [{ id: 'p1', name: 'x', stock_qty: '1' }], error: null };
                if (state.table === 'ai_recommendations') return { data: { payload: {} }, error: null };
                return { data: [], error: null, count: 0 };
            });

            await request(app).post('/api/ai/dispose-product').set(userHeaders).send({ productNames: ['x'], id: 'rec-9' });

            const [update] = mockDb.callsForOp('ai_recommendations', 'update');
            expect(filterArgs(update, 'eq')).toContainEqual(['id', 'rec-9']);
            expect(update.payload).toMatchObject({ status: 'accepted' });
            expect(update.payload.actual_outcome).toContain('ตัดสต็อก');
        });

        it('records a "nothing to dispose" outcome when the stock was already gone', async () => {
            mockDb.onDefault((state) => {
                if (state.table === 'ai_recommendations') return { data: { payload: {} }, error: null };
                return { data: [], error: null, count: 0 };
            });

            await request(app).post('/api/ai/dispose-product').set(userHeaders).send({ productNames: ['x'], recommendationId: 'r1' });

            expect(mockDb.callsForOp('ai_recommendations', 'update')[0].payload.actual_outcome)
                .toBe('ไม่พบสต็อกที่ต้องตัด (อาจถูกตัดไปแล้ว)');
        });

        it('requires a store and a user id', async () => {
            const anonApp = buildApp(null);

            const res = await request(anonApp).post('/api/ai/dispose-product').set(headers).send({ productNames: ['x'] });

            expect(res.status).toBe(400);
        });

        it('returns 500 when the product lookup fails', async () => {
            mockDb.onDefault((state) => (state.table === 'products'
                ? { data: null, error: { message: 'lookup failed' } }
                : { data: [], error: null, count: 0 }));

            const res = await request(app).post('/api/ai/dispose-product').set(userHeaders).send({ productNames: ['x'] });

            expect(res.status).toBe(500);
            expect(res.body).toEqual({ success: false, error: 'lookup failed' });
        });
    });

    describe('POST /api/ai/recommendations/:id/schedule', () => {
        it('marks the recommendation scheduled and stores the trigger', async () => {
            mockDb.on('ai_recommendations', (state) =>
                state.op === 'select'
                    ? { data: { payload: { existing: true } }, error: null }
                    : { data: { id: 'r1', status: 'scheduled' }, error: null });

            const res = await request(app).post('/api/ai/recommendations/r1/schedule').set(headers)
                .send({ trigger_type: 'after_promo', promotion_id: 'promo-1', scheduled_price: 25 });

            expect(res.status).toBe(200);
            const [update] = mockDb.callsForOp('ai_recommendations', 'update');
            expect(update.payload).toMatchObject({ status: 'scheduled' });
            expect(update.payload.payload).toEqual({
                existing: true, schedule_trigger: 'after_promo', trigger_promotion_id: 'promo-1', scheduled_price: 25
            });
        });

        it('defaults the trigger to manual with empty trigger fields', async () => {
            mockDb.on('ai_recommendations', (state) =>
                state.op === 'select' ? { data: { payload: {} }, error: null } : { data: { id: 'r1' }, error: null });

            await request(app).post('/api/ai/recommendations/r1/schedule').set(headers).send({});

            expect(mockDb.callsForOp('ai_recommendations', 'update')[0].payload.payload).toEqual({
                schedule_trigger: 'manual', trigger_promotion_id: null, scheduled_price: null
            });
        });

        it('returns 404 when the recommendation is not in this store', async () => {
            mockDb.on('ai_recommendations', { data: null, error: { message: 'no rows' } });

            const res = await request(app).post('/api/ai/recommendations/r1/schedule').set(headers).send({});

            expect(res.status).toBe(404);
            expect(res.body).toEqual({ success: false, error: 'ไม่พบคำแนะนำ' });
        });

        it('requires a store header', async () => {
            expect((await request(app).post('/api/ai/recommendations/r1/schedule').send({})).status).toBe(400);
        });
    });

    describe('GET /api/ai/scheduled-reminders', () => {
        it('returns manual-trigger reminders as ready', async () => {
            mockDb.on('ai_recommendations', {
                data: [{ id: 'r1', payload: { schedule_trigger: 'manual' } }],
                error: null
            });

            const res = await request(app).get('/api/ai/scheduled-reminders').set(headers);

            expect(res.status).toBe(200);
            expect(res.body.data).toEqual([{ id: 'r1', payload: { schedule_trigger: 'manual' } }]);
            expect(res.body.data[0]).not.toHaveProperty('trigger_ready');
        });

        it('holds an after_promo reminder until its promotion is deactivated', async () => {
            mockDb
                .on('ai_recommendations', { data: [{ id: 'r1', payload: { schedule_trigger: 'after_promo', trigger_promotion_id: 'promo-1' } }], error: null })
                .on('promotions', { data: { is_active: true }, error: null });

            const held = await request(app).get('/api/ai/scheduled-reminders').set(headers);
            expect(held.body.data).toEqual([]);

            mockDb.on('promotions', { data: { is_active: false }, error: null });
            const ready = await request(app).get('/api/ai/scheduled-reminders').set(headers);
            expect(ready.body.data).toHaveLength(1);
        });

        it('treats an after_promo reminder with no promotion id as ready', async () => {
            mockDb.on('ai_recommendations', { data: [{ id: 'r1', payload: { schedule_trigger: 'after_promo' } }], error: null });

            const res = await request(app).get('/api/ai/scheduled-reminders').set(headers);

            expect(res.body.data).toHaveLength(1);
        });

        it('reads only scheduled pricing recommendations for the store', async () => {
            mockDb.on('ai_recommendations', { data: [], error: null });

            await request(app).get('/api/ai/scheduled-reminders').set(headers);

            const [call] = mockDb.callsFor('ai_recommendations');
            expect(filterArgs(call, 'eq')).toContainEqual(['store_id', STORE_ID]);
            expect(filterArgs(call, 'eq')).toContainEqual(['status', 'scheduled']);
            expect(filterArgs(call, 'eq')).toContainEqual(['type', 'pricing']);
        });

        it('requires a store header and reports query failures', async () => {
            expect((await request(app).get('/api/ai/scheduled-reminders')).status).toBe(400);

            mockDb.on('ai_recommendations', { data: null, error: { message: 'down' } });
            expect((await request(app).get('/api/ai/scheduled-reminders').set(headers)).status).toBe(500);
        });
    });

    describe('POST /api/ai/ocr-expiry', () => {
        it('returns the ISO date the vision model extracted', async () => {
            mockGenerateContent.mockResolvedValue(aiText('2026-05-31'));

            const res = await request(app).post('/api/ai/ocr-expiry').set(headers).send({ imageBase64: 'AAAA' });

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ success: true, date: '2026-05-31' });
        });

        it('sends the image inline as JPEG alongside the prompt', async () => {
            mockGenerateContent.mockResolvedValue(aiText('2026-05-31'));

            await request(app).post('/api/ai/ocr-expiry').set(headers).send({ imageBase64: 'AAAA' });

            const [[prompt, imagePart]] = mockGenerateContent.mock.calls.at(-1);
            expect(prompt).toContain('OCR');
            expect(imagePart).toEqual({ inlineData: { data: 'AAAA', mimeType: 'image/jpeg' } });
        });

        it('requires an image', async () => {
            const res = await request(app).post('/api/ai/ocr-expiry').set(headers).send({});

            expect(res.status).toBe(400);
            expect(res.body).toEqual({ success: false, error: 'Image base64 is required' });
            expect(mockGenerateContent).not.toHaveBeenCalled();
        });

        it('reports a soft failure (HTTP 200, success:false) when nothing was found', async () => {
            mockGenerateContent.mockResolvedValue(aiText('NOT_FOUND'));

            const res = await request(app).post('/api/ai/ocr-expiry').set(headers).send({ imageBase64: 'AAAA' });

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ success: false, error: 'ไม่พบวันหมดอายุในรูปภาพ หรือภาพไม่ชัดเจน' });
        });

        it('rejects any model output that is not an ISO date', async () => {
            for (const text of ['31/05/2026', '2026-5-1', 'sometime next year']) {
                mockGenerateContent.mockResolvedValue(aiText(text));
                // eslint-disable-next-line no-await-in-loop
                const res = await request(app).post('/api/ai/ocr-expiry').set(headers).send({ imageBase64: 'AAAA' });
                expect(res.body.success).toBe(false);
            }
        });

        it('returns a generic 500 when the vision call throws, leaking no internals', async () => {
            mockGenerateContent.mockRejectedValue(new Error('quota exceeded for project 12345'));

            const res = await request(app).post('/api/ai/ocr-expiry').set(headers).send({ imageBase64: 'AAAA' });

            expect(res.status).toBe(500);
            expect(res.body).toEqual({ success: false, error: 'เกิดข้อผิดพลาดในการวิเคราะห์รูปภาพ' });
            expect(JSON.stringify(res.body)).not.toContain('12345');
        });
    });
});
