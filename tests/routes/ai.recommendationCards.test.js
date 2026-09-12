/**
 * Between the model's raw JSON and the card the shop owner sees, GET /api/ai/recommendations
 * rewrites almost everything that carries a number: which products a card is about,
 * what price to suggest, and the "expected_impact" line that states what the owner
 * stands to gain. The model is not trusted with any of it.
 *
 * These tests pin that rewriting layer. Each one feeds a single suggestion through and
 * asserts on the row handed to ai_recommendations.insert.
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

const { createMockSupabase } = require('../helpers/mockSupabase');
mockDb = createMockSupabase();

const aiRoutes = require('../../routes/ai');

const STORE_ID = 'store-1';
const USER = { id: 'user-1' };
const headers = { 'x-store-id': STORE_ID };
const FIXED_NOW = Date.UTC(2026, 7, 26, 5, 0, 0);
const TODAY = '2026-08-26';

const aiText = (text) => ({ response: { text: () => text } });

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = USER; next(); });
    app.use('/api/ai', aiRoutes);
    return app;
}

/**
 * Serve an empty recommendation table so a generation runs, plus whatever store data
 * the test needs. `tables.products` covers both the store-summary sweep and the
 * targeted lookup the pricing branch makes; `tables.pricingProducts` overrides the
 * latter, which is recognisable by its `or(name.ilike...)` filter.
 */
function scenario(tables = {}) {
    const catalogue = tables.products || [];
    mockDb.onDefault((state) => {
        switch (state.table) {
            case 'ai_recommendations':
                return state.op === 'select'
                    ? { data: [], error: null }
                    : { data: [{ id: 'new-1' }], error: null };
            case 'products': {
                const isTargetedLookup = state.filters.some((f) => f.name === 'or');
                if (isTargetedLookup) return { data: tables.pricingProducts || catalogue, error: null };
                return { data: catalogue, count: catalogue.length || 1, error: null };
            }
            case 'product_batches':
                return { data: tables.batches || [], error: null };
            case 'credit_accounts':
                return { data: tables.debts || [], error: null };
            case 'orders':
                return { data: tables.orders || [], error: null };
            default:
                return { data: [], error: null, count: 0 };
        }
    });
}

/** Run one suggestion through the pipeline and return the stored row. */
async function cardFor(app, suggestion) {
    mockGenerateContent.mockResolvedValue(aiText(JSON.stringify([suggestion])));
    const res = await request(app).get('/api/ai/recommendations').set(headers);
    expect(res.status).toBe(200);
    const inserts = mockDb.callsForOp('ai_recommendations', 'insert');
    expect(inserts.length).toBeGreaterThan(0);
    return inserts[0].payload[0];
}

/** A product row as the store-summary sweep reads it. */
const product = (over = {}) => ({
    id: 'p1', name: 'นมสด', stock_qty: 10, cost_price: 10, price: 20,
    low_stock_threshold: 5, unit_type: 'ชิ้น', ...over
});

const batch = (name, expireDate, over = {}) => ({
    remaining_qty: over.qty ?? 5,
    expire_date: expireDate,
    products: { name, store_id: STORE_ID, cost_price: over.cost ?? 10, price: over.price ?? 20, unit_type: over.unit ?? 'ชิ้น' }
});

const debt = (name, amount, phone = '0812345678') => ({
    remaining_amount: amount,
    customers_info: { store_id: STORE_ID, name, phone, due_date: null }
});

describe('recommendation card post-processing', () => {
    let app;
    let errorSpy;
    let logSpy;
    let nowSpy;

    beforeEach(() => {
        mockDb.reset();
        global.fetch = jest.fn().mockResolvedValue({
            json: async () => ({ address: {}, current_weather: { temperature: 30, weathercode: 0 } })
        });
        app = buildApp();
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        nowSpy = jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
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
        nowSpy.mockRestore();
        errorSpy.mockRestore();
        logSpy.mockRestore();
        delete global.fetch;
    });

    describe('stock cards', () => {
        it('quotes the revenue a restock could bring, using the real reorder quantity', async () => {
            scenario({
                products: [product({ id: 'egg', name: 'ไข่ไก่', stock_qty: 2, low_stock_threshold: 5, price: 5, cost_price: 3 })],
                orders: [{
                    id: 'o1', total_amount: 150, payment_type: 'cash', created_at: `${TODAY}T05:00:00.000Z`,
                    order_items: [{ qty: 30, price_per_unit: 5, cost_price_at_sale: 3, subtotal: 150, products: { id: 'egg', name: 'ไข่ไก่', unit_type: 'ชิ้น' } }]
                }]
            });

            const card = await cardFor(app, {
                type: 'stock', title: 'สั่งไข่เพิ่ม', detail: 'ขายดี', action_label: 'เติมสต็อก', target_products: ['ไข่ไก่']
            });

            // 30 sold in 30 days is 1/day; 14 days needs 14, minus 2 on hand = 12 at ฿5.
            expect(card.payload.products[0]).toMatchObject({ name: 'ไข่ไก่', suggestedOrder: 12 });
            expect(card.expected_impact).toBe('สั่งเข้ามา 12 ชิ้น ขายได้อีก ฿60');
        });

        it('pulls dead stock rather than the reorder list when the label is not เติมสต็อก', async () => {
            scenario({ products: [product({ name: 'ของค้าง', stock_qty: 40 })] });

            const card = await cardFor(app, {
                type: 'stock', title: 'ระบายของค้าง', detail: 'ไม่ขยับ', action_label: 'ลดราคา', target_products: ['ของค้าง']
            });

            expect(card.payload.products[0]).toMatchObject({ name: 'ของค้าง', qty: 40 });
        });

        it('falls back to the expiry lists when the named product is not a stock case', async () => {
            scenario({
                products: [product({ name: 'โยเกิร์ต' })],
                batches: [batch('โยเกิร์ต', '2026-08-30')]
            });

            const card = await cardFor(app, {
                type: 'stock', title: 'โยเกิร์ตใกล้หมด', detail: 'x', action_label: 'เติมสต็อก', target_products: ['โยเกิร์ต']
            });

            expect(card.payload.products[0]).toMatchObject({ name: 'โยเกิร์ต', daysUntilExpiry: 4 });
        });

        it('says the goods can sell immediately when the shelf is empty', async () => {
            // A seller with nothing on hand and no sale price to quote: there is no
            // revenue figure to promise, only the fact that stock unblocks sales.
            scenario({
                products: [product({ id: 'rice', name: 'ข้าวสาร', stock_qty: 0, price: 0, cost_price: 80 })],
                orders: [{
                    id: 'o1', total_amount: 0, payment_type: 'cash', created_at: `${TODAY}T05:00:00.000Z`,
                    order_items: [{ qty: 30, price_per_unit: 0, cost_price_at_sale: 80, subtotal: 0, products: { id: 'rice', name: 'ข้าวสาร', unit_type: 'ถุง' } }]
                }]
            });

            const card = await cardFor(app, {
                type: 'stock', title: 'สั่งข้าวสาร', detail: 'หมดแล้ว', action_label: 'เติมสต็อก', target_products: ['ข้าวสาร']
            });

            expect(card.payload.products[0].qty).toBe(0);
            expect(card.expected_impact).toBe('สั่งของเข้ามาแล้วขายได้ทันที');
        });

        it('rewrites a promotion for an out-of-stock product into a restock order', async () => {
            // Promoting something with nothing on the shelf is the model's most common
            // wrong answer; the server converts the card rather than shipping it.
            scenario({ products: [product({ name: 'น้ำปลา', stock_qty: 0 })] });

            const card = await cardFor(app, {
                type: 'promotion', title: 'จัดโปรน้ำปลา', detail: 'ลดราคา', action_label: 'ลด 20%',
                target_products: ['น้ำปลา'], recommended_discount: { percent: 20 }
            });

            expect(card.type).toBe('stock');
            expect(card.action_label).toBe('เติมสต็อก');
            expect(card.title).toContain('สั่งสินค้าเพิ่มด่วน');
            expect(card.payload.recommended_discount).toBeNull();
        });

        it('keeps the model\'s own impact line when no stock rule applies', async () => {
            scenario({ products: [product()] });

            const card = await cardFor(app, {
                type: 'info', title: 'ข้อมูลทั่วไป', detail: 'อธิบาย', expected_impact: 'ของโมเดล', action_label: 'ดูเพิ่ม'
            });

            expect(card.expected_impact).toBe('ของโมเดล');
        });
    });

    describe('expiry and promotion cards', () => {
        it('states the loss and tells the owner to write it off when the goods have expired', async () => {
            scenario({
                products: [product({ name: 'นมบูด' })],
                batches: [batch('นมบูด', '2026-08-20', { qty: 4, cost: 25 })]
            });

            const card = await cardFor(app, {
                type: 'expiry', title: 'ตัดสต็อกนมบูด', detail: 'หมดอายุแล้ว', action_label: 'ตัดสต็อก',
                target_products: ['นมบูด'], recommended_discount: { action: 'dispose' }
            });

            expect(card.expected_impact).toBe('ของหมดอายุแล้ว เสียทุนไป ฿100 ตัดออกจากระบบให้เรียบร้อย');
        });

        it('still says to write off when the cost price is unknown', async () => {
            scenario({
                products: [product({ name: 'ของหมดอายุ' })],
                batches: [batch('ของหมดอายุ', '2026-08-20', { cost: 0 })]
            });

            const card = await cardFor(app, {
                type: 'expiry', title: 'ตัดสต็อก', detail: 'หมดอายุ', action_label: 'ตัดสต็อก',
                target_products: ['ของหมดอายุ'], recommended_discount: { action: 'dispose' }
            });

            expect(card.expected_impact).toBe('ของหมดอายุแล้ว ตัดออกจากระบบให้เรียบร้อย');
        });

        it('treats a 100% discount as a write-off, not a promotion', async () => {
            scenario({
                products: [product({ name: 'ขนม' })],
                batches: [batch('ขนม', '2026-08-20', { qty: 2, cost: 30 })]
            });

            const card = await cardFor(app, {
                type: 'expiry', title: 'ลดขนม', detail: 'หมดอายุ', action_label: 'ลดราคา',
                target_products: ['ขนม'], recommended_discount: { percent: 100 }
            });

            expect(card.payload.recommended_discount).toMatchObject({ percent: 100, action: 'dispose' });
            expect(card.expected_impact).toContain('เสียทุนไป ฿60');
        });

        it('urges a same-day sale for goods expiring today', async () => {
            scenario({
                products: [product({ name: 'ขนมปัง' })],
                batches: [batch('ขนมปัง', TODAY, { qty: 10, price: 20 })]
            });

            const card = await cardFor(app, {
                type: 'expiry', title: 'ลดขนมปัง', detail: 'หมดวันนี้', action_label: 'ลด 50%',
                target_products: ['ขนมปัง'], recommended_discount: { percent: 50 }
            });

            expect(card.expected_impact).toBe('รีบขายวันนี้! ถ้าขายออกได้เงิน ฿100');
        });

        it('quotes the discounted take for goods that still have days left', async () => {
            scenario({
                products: [product({ name: 'โยเกิร์ต' })],
                batches: [batch('โยเกิร์ต', '2026-08-30', { qty: 10, price: 20 })]
            });

            const card = await cardFor(app, {
                type: 'expiry', title: 'ลดโยเกิร์ต', detail: 'ใกล้หมด', action_label: 'ลด 20%',
                target_products: ['โยเกิร์ต'], recommended_discount: { percent: 20 }
            });

            expect(card.expected_impact).toBe('จัดโปรแล้วขายออกได้เงิน ฿160');
        });

        it('falls back to a plain speed-up line when no discount was proposed', async () => {
            scenario({
                products: [product({ name: 'ชาเขียว' })],
                batches: [batch('ชาเขียว', '2026-09-01', { qty: 6, price: 25 })]
            });

            const card = await cardFor(app, {
                type: 'expiry', title: 'ดันชาเขียว', detail: 'ใกล้หมด', action_label: 'จัดวางหน้าร้าน',
                target_products: ['ชาเขียว']
            });

            expect(card.expected_impact).toBe('จัดโปรแล้วขายออกได้เร็วขึ้น');
        });

        it('takes the first expiring item when the model named no product', async () => {
            scenario({
                products: [product({ name: 'ก' })],
                batches: [batch('ก', '2026-08-28'), batch('ข', '2026-08-29')]
            });

            const card = await cardFor(app, {
                type: 'expiry', title: 'ของใกล้หมด', detail: 'ควรจัดโปร', action_label: 'ลดราคา'
            });

            expect(card.payload.products).toHaveLength(1);
            expect(card.payload.products[0].name).toBe('ก');
        });
    });

    describe('pricing cards', () => {
        const pricingScenario = (rows) => scenario({
            products: [product({ name: 'นมสด', cost_price: 12, price: 14, stock_qty: 20 })],
            pricingProducts: rows
        });

        it('quotes the current price from the database, never from the model', async () => {
            pricingScenario([{ id: 'p1', name: 'นมสด', price: 14, cost_price: 12, stock_qty: 20, unit_type: 'ขวด' }]);

            const card = await cardFor(app, {
                type: 'pricing', title: 'ปรับราคานมสด', detail: 'กำไรบาง', action_label: 'ปรับราคา',
                target_products: ['นมสด'], current_price: 99, suggested_price: 20
            });

            expect(card.payload.current_price).toBe(14);
        });

        it('rounds the suggested price to a multiple of five', async () => {
            pricingScenario([{ id: 'p1', name: 'นมสด', price: 14, cost_price: 12, stock_qty: 20, unit_type: 'ขวด' }]);

            const card = await cardFor(app, {
                type: 'pricing', title: 'ปรับราคา', detail: 'x', action_label: 'ปรับราคา',
                target_products: ['นมสด'], suggested_price: 17
            });

            expect(card.payload.suggested_price % 5).toBe(0);
        });

        it('prefers the exact name when ilike also matched a longer one', async () => {
            pricingScenario([
                { id: 'p2', name: 'นมสดรสหวาน', price: 25, cost_price: 20, stock_qty: 5, unit_type: 'ขวด' },
                { id: 'p1', name: 'นมสด', price: 14, cost_price: 12, stock_qty: 20, unit_type: 'ขวด' }
            ]);

            const card = await cardFor(app, {
                type: 'pricing', title: 'ปรับราคานมสด', detail: 'x', action_label: 'ปรับราคา',
                target_products: ['นมสด'], suggested_price: 20
            });

            expect(card.payload.products[0].name).toBe('นมสด');
            expect(card.payload.current_price).toBe(14);
        });

        it('computes a price itself when the model proposed no change', async () => {
            scenario({
                products: [product({ name: 'นมสด', cost_price: 14, price: 15, stock_qty: 20 })],
                pricingProducts: [{ id: 'p1', name: 'นมสด', price: 15, cost_price: 14, stock_qty: 20, unit_type: 'ขวด' }]
            });

            const card = await cardFor(app, {
                type: 'pricing', title: 'ปรับราคานมสด', detail: 'กำไรบาง', action_label: 'ปรับราคา',
                target_products: ['นมสด'], current_price: 15, suggested_price: 15
            });

            // cost 14 at a 20% target margin is 17.50, rounded up to the nearest five.
            expect(card.payload.suggested_price).toBe(20);
            expect(card.payload.price_change_reason).toBe('ขึ้นราคาให้ได้กำไร 30% (ทุน ฿14, กำไรเดิม 7%)');
        });

        it('aims for a wider margin when the product is already close to the target', async () => {
            scenario({
                products: [product({ name: 'ข้าวสาร', cost_price: 83, price: 100, stock_qty: 10 })],
                pricingProducts: [{ id: 'p1', name: 'ข้าวสาร', price: 100, cost_price: 83, stock_qty: 10, unit_type: 'ถุง' }]
            });

            const card = await cardFor(app, {
                type: 'pricing', title: 'ปรับราคาข้าวสาร', detail: 'x', action_label: 'ปรับราคา',
                target_products: ['ข้าวสาร'], suggested_price: 100
            });

            // margin is 17%, inside the 15-20 band, so the target rate is 22%: 83/0.78 = 106.4 -> 105.
            expect(card.payload.suggested_price).toBe(105);
        });

        it('drops ปรับราคา from the label when the price ends up unchanged', async () => {
            scenario({
                products: [product({ name: 'สบู่', cost_price: 0, price: 20, stock_qty: 10 })],
                pricingProducts: [{ id: 'p1', name: 'สบู่', price: 20, cost_price: 0, stock_qty: 10, unit_type: 'ก้อน' }]
            });

            const card = await cardFor(app, {
                type: 'pricing', title: 'ทบทวนราคาสบู่', detail: 'x', action_label: 'ปรับราคา/จัดโปร',
                target_products: ['สบู่'], suggested_price: 20
            });

            expect(card.action_label).toBe('จัดโปร');
        });

        it('states the extra profit a price rise would earn across the stock on hand', async () => {
            pricingScenario([{ id: 'p1', name: 'นมสด', price: 15, cost_price: 12, stock_qty: 20, unit_type: 'ขวด' }]);

            const card = await cardFor(app, {
                type: 'pricing', title: 'ขึ้นราคานมสด', detail: 'x', action_label: 'ปรับราคา',
                target_products: ['นมสด'], suggested_price: 20
            });

            expect(card.expected_impact).toBe('ขึ้นราคา ฿15→฿20 (กำไร 40%) กำไรเพิ่ม ฿100 จาก 20 ขวด');
        });

        it('frames a price cut as clearing the shelf', async () => {
            pricingScenario([{ id: 'p1', name: 'นมสด', price: 30, cost_price: 12, stock_qty: 10, unit_type: 'ขวด' }]);

            const card = await cardFor(app, {
                type: 'pricing', title: 'ลดราคานมสด', detail: 'x', action_label: 'ปรับราคา',
                target_products: ['นมสด'], suggested_price: 20
            });

            expect(card.expected_impact).toBe('ลดราคา ฿30→฿20 (กำไร 40%) เพื่อระบาย 10 ขวด ออก');
        });

        it('omits the margin when the cost price is missing', async () => {
            pricingScenario([{ id: 'p1', name: 'นมสด', price: 15, cost_price: 0, stock_qty: 4, unit_type: 'ขวด' }]);

            const card = await cardFor(app, {
                type: 'pricing', title: 'ขึ้นราคา', detail: 'x', action_label: 'ปรับราคา',
                target_products: ['นมสด'], suggested_price: 25
            });

            expect(card.expected_impact).toContain('฿15→฿25');
            expect(card.expected_impact).not.toContain('กำไร ');
        });

        it('leaves the impact line alone when nothing is in stock to reprice', async () => {
            pricingScenario([{ id: 'p1', name: 'นมสด', price: 15, cost_price: 12, stock_qty: 0, unit_type: 'ขวด' }]);

            const card = await cardFor(app, {
                type: 'pricing', title: 'ปรับราคา', detail: 'x', action_label: 'ปรับราคา',
                expected_impact: 'ของโมเดล', target_products: ['นมสด'], suggested_price: 25
            });

            expect(card.expected_impact).toBe('ของโมเดล');
        });

        it('falls back to the raw ilike rows when no name matches well', async () => {
            pricingScenario([{ id: 'p9', name: 'อย่างอื่นไปเลย', price: 40, cost_price: 30, stock_qty: 3, unit_type: 'ชิ้น' }]);

            const card = await cardFor(app, {
                type: 'pricing', title: 'ปรับราคา', detail: 'x', action_label: 'ปรับราคา',
                target_products: ['นมสด'], suggested_price: 50
            });

            expect(card.payload.current_price).toBe(40);
        });
    });

    describe('debt cards', () => {
        it('attaches only the customers the model actually named', async () => {
            scenario({
                products: [product()],
                debts: [debt('ป้าสมศรี', '500'), debt('ลุงสมชาย', '300')]
            });

            const card = await cardFor(app, {
                type: 'debt', title: 'ทวงหนี้ป้าสมศรี', detail: 'ค้างนาน', action_label: 'โทรทวง',
                target_customers: ['ป้าสมศรี']
            });

            expect(card.payload.customers.map((c) => c.name)).toEqual(['ป้าสมศรี']);
        });

        it('adds the phone number when exactly one debtor is on the card', async () => {
            scenario({ products: [product()], debts: [debt('ป้าสมศรี', '500', '0891112222')] });

            const card = await cardFor(app, {
                type: 'debt', title: 'ทวงหนี้', detail: 'x', action_label: 'โทรทวง', target_customers: ['ป้าสมศรี']
            });

            expect(card.payload.phone).toBe('0891112222');
        });

        it('leaves the phone off a card covering several debtors', async () => {
            scenario({
                products: [product()],
                debts: [debt('สมศรี', '500'), debt('สมชาย', '300')]
            });

            const card = await cardFor(app, {
                type: 'debt', title: 'ทวงหนี้', detail: 'x', action_label: 'โทรทวง',
                target_customers: ['สมศรี', 'สมชาย']
            });

            expect(card.payload.customers).toHaveLength(2);
            expect(card.payload.phone).toBeUndefined();
        });

        it('matches a customer the model referred to by part of their name', async () => {
            scenario({ products: [product()], debts: [debt('ป้าสมศรี ร้านข้าวแกง', '500')] });

            const card = await cardFor(app, {
                type: 'debt', title: 'ทวงหนี้', detail: 'x', action_label: 'โทรทวง', target_customers: ['ป้าสมศรี']
            });

            expect(card.payload.customers).toHaveLength(1);
        });

        it('falls back to the largest debtor when the model named nobody', async () => {
            scenario({
                products: [product()],
                debts: [debt('รายเล็ก', '100'), debt('รายใหญ่', '9000')]
            });

            const card = await cardFor(app, {
                type: 'debt', title: 'ทวงหนี้', detail: 'x', action_label: 'โทรทวง'
            });

            expect(card.payload.customers.map((c) => c.name)).toEqual(['รายใหญ่']);
        });

        it('states how much the owner would recover', async () => {
            scenario({ products: [product()], debts: [debt('ป้าสมศรี', '1500')] });

            const card = await cardFor(app, {
                type: 'debt', title: 'ทวงหนี้', detail: 'x', action_label: 'โทรทวง',
                target_customers: ['ป้าสมศรี'], amount: 1500
            });

            expect(card.expected_impact).toBe('ทวงคืนมาได้ ฿1,500');
        });

        it('leaves a debt card alone when the store has no debtors', async () => {
            scenario({ products: [product()] });

            const card = await cardFor(app, {
                type: 'debt', title: 'ทวงหนี้', detail: 'x', expected_impact: 'ของโมเดล', action_label: 'โทรทวง'
            });

            expect(card.payload.customers).toBeUndefined();
            expect(card.expected_impact).toBe('ของโมเดล');
        });
    });

    describe('rows that never reach the owner', () => {
        it('drops a card the model left without a title', async () => {
            scenario({ products: [product()] });
            mockGenerateContent.mockResolvedValue(aiText(JSON.stringify([
                { type: 'info', title: null, detail: 'มีแต่รายละเอียด', action_label: 'ดู' },
                { type: 'info', title: 'ใช้ได้', detail: 'ครบ', action_label: 'ดู' }
            ])));

            await request(app).get('/api/ai/recommendations').set(headers);

            const rows = mockDb.callsForOp('ai_recommendations', 'insert')[0].payload;
            expect(rows.map((r) => r.title)).toEqual(['ใช้ได้']);
        });

        it('drops a card whose detail is only whitespace', async () => {
            scenario({ products: [product()] });
            mockGenerateContent.mockResolvedValue(aiText(JSON.stringify([
                { type: 'info', title: 'มีหัวข้อ', detail: '   ', action_label: 'ดู' }
            ])));

            await request(app).get('/api/ai/recommendations').set(headers);

            expect(mockDb.callsForOp('ai_recommendations', 'insert')[0].payload).toEqual([]);
        });

        it('defaults an untyped suggestion to info rather than storing null', async () => {
            scenario({ products: [product()] });

            const card = await cardFor(app, { title: 'ไม่ระบุประเภท', detail: 'x', action_label: 'ดู' });

            expect(card.type).toBe('info');
            expect(card.status).toBe('pending');
            expect(card.reference_type).toBeNull();
        });
    });
});
