/**
 * getStoreSummary builds the entire factual picture the AI reasons over: revenue,
 * profit, expiry buckets, debt aging, dead stock, reorder points and pricing
 * candidates. Every number the assistant quotes originates here, so a mistake in this
 * function becomes wrong advice rather than a visible crash.
 *
 * It is reached through GET /api/ai/context, which exposes both the prompt text and
 * the structured `raw` block. Time is pinned so the Bangkok-day arithmetic is
 * deterministic.
 */
const request = require('supertest');
const express = require('express');

let mockDb;
const mockGetGenerativeModel = jest.fn(() => ({
    generateContent: jest.fn(),
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

// Wednesday 26 Aug 2026, 12:00 Bangkok (05:00 UTC).
const FIXED_NOW = Date.UTC(2026, 7, 26, 5, 0, 0);
const TODAY = '2026-08-26';

/** An ISO timestamp that lands on the given Bangkok date at midday. */
const atBangkok = (dateStr) => `${dateStr}T05:00:00.000Z`;

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { id: 'user-1' }; next(); });
    app.use('/api/ai', aiRoutes);
    return app;
}

/** A paid order 30-day window row, with the join shape getStoreSummary selects. */
const order = (createdAt, totalAmount, items = []) => ({
    id: `o-${createdAt}-${totalAmount}`,
    total_amount: totalAmount,
    payment_type: 'cash',
    created_at: createdAt,
    order_items: items
});

const item = (name, qty, pricePerUnit, costPrice, extra = {}) => ({
    qty,
    price_per_unit: pricePerUnit,
    cost_price_at_sale: costPrice,
    subtotal: qty * pricePerUnit,
    unit: extra.unit,
    products: { id: extra.id || `p-${name}`, name, unit_type: extra.unitType || 'ชิ้น' }
});

const product = (over = {}) => ({
    id: 'p1',
    name: 'สินค้า',
    stock_qty: 10,
    cost_price: 10,
    price: 20,
    low_stock_threshold: 5,
    unit_type: 'ชิ้น',
    ...over
});

const batch = (name, expireDate, over = {}) => ({
    remaining_qty: over.qty ?? 3,
    expire_date: expireDate,
    products: {
        name,
        store_id: STORE_ID,
        cost_price: over.cost ?? 10,
        price: over.price ?? 25,
        unit_type: over.unit ?? 'ชิ้น'
    }
});

/**
 * Fetch the context, serving the given tables and empty rows for everything else.
 * Coordinates are always sent — without them the weather and geocoding lookups return
 * early and the surrounding context is never built.
 */
async function context(app, tables = {}) {
    for (const [table, result] of Object.entries(tables)) mockDb.on(table, result);
    const res = await request(app).get('/api/ai/context?lat=13.75&lon=100.5').set(headers);
    expect(res.status).toBe(200);
    return res.body;
}

describe('getStoreSummary (via GET /api/ai/context)', () => {
    let app;
    let errorSpy;
    let nowSpy;

    beforeEach(() => {
        mockDb.reset();
        mockDb.onDefault(() => ({ data: [], error: null, count: 0 }));
        global.fetch = jest.fn().mockResolvedValue({
            json: async () => ({
                address: { suburb: 'บางรัก', city: 'กรุงเทพมหานคร' },
                current_weather: { temperature: 32, weathercode: 0 }
            })
        });
        app = buildApp();
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        nowSpy = jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
        // Handlers use `new Date()` as well as `Date.now()`. Timers stay real for supertest.
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
        delete global.fetch;
    });

    describe('the query window', () => {
        it('reads only this store\'s paid orders from the last 30 Bangkok days', async () => {
            await context(app);

            const [orders] = mockDb.callsFor('orders');
            expect(filterArgs(orders, 'eq')).toContainEqual(['store_id', STORE_ID]);
            expect(filterArgs(orders, 'eq')).toContainEqual(['payment_status', 'paid']);

            const [[, since]] = filterArgs(orders, 'gte');
            // 30 Bangkok days back from 26 Aug is 27 Jul, whose Bangkok midnight is 26 Jul 17:00Z.
            expect(since).toBe('2026-07-26T17:00:00.000Z');
        });

        it('excludes soft-deleted products from the stock picture', async () => {
            await context(app);

            const [products] = mockDb.callsFor('products');
            expect(filterArgs(products, 'is')).toContainEqual(['deleted_at', null]);
        });

        it('reads expiry batches from 30 days back to 14 days ahead, still in stock', async () => {
            await context(app);

            const [batches] = mockDb.callsFor('product_batches');
            expect(filterArgs(batches, 'gt')).toContainEqual(['remaining_qty', 0]);
            expect(filterArgs(batches, 'gte')).toContainEqual(['expire_date', '2026-07-27']);
            expect(filterArgs(batches, 'lte')).toContainEqual(['expire_date', '2026-09-09']);
        });

        it('counts only expense transactions towards the store\'s outgoings', async () => {
            await context(app);

            const [expenses] = mockDb.callsFor('account_transactions');
            expect(filterArgs(expenses, 'eq')).toContainEqual(['trans_type', 'expense']);
            expect(filterArgs(expenses, 'eq')).toContainEqual(['store_id', STORE_ID]);
        });

        it('reads only debts that still owe money, biggest first', async () => {
            await context(app);

            const [debts] = mockDb.callsFor('credit_accounts');
            expect(filterArgs(debts, 'gt')).toContainEqual(['remaining_amount', 0]);
            expect(filterArgs(debts, 'order')).toContainEqual(['remaining_amount', { ascending: false }]);
        });
    });

    describe('revenue and profit', () => {
        it('counts this month\'s orders and ignores last month\'s', async () => {
            const body = await context(app, {
                orders: {
                    data: [
                        order(atBangkok(TODAY), 1000),
                        order(atBangkok('2026-08-05'), 500),
                        order(atBangkok('2026-07-28'), 9999) // previous month, inside 30 days
                    ],
                    error: null
                }
            });

            expect(body.raw.salesMonth).toBe(1500);
        });

        it('derives gross profit from the cost captured at the time of sale', async () => {
            const body = await context(app, {
                orders: {
                    data: [order(atBangkok(TODAY), 300, [item('ข้าวสาร', 3, 100, 60)])],
                    error: null
                }
            });

            expect(body.raw.profitMonth).toBe(120); // 300 revenue - (60 x 3) cost
        });

        it('reports net profit after subtracting store expenses', async () => {
            const body = await context(app, {
                orders: { data: [order(atBangkok(TODAY), 1000, [item('ก', 1, 1000, 400)])], error: null },
                account_transactions: { data: [{ amount: '200' }, { amount: 100 }], error: null }
            });

            expect(body.context).toContain('Store Expenses: ฿300');
            expect(body.context).toContain('NET PROFIT: ฿300'); // 600 gross - 300 expenses
        });

        it('warns in the prompt that a negative net profit means a loss', async () => {
            const body = await context(app, {
                account_transactions: { data: [{ amount: '5000' }], error: null }
            });

            expect(body.context).toContain('NET PROFIT: ฿-5,000');
            expect(body.context).toContain('ถ้าติดลบแปลว่าร้านกำลังขาดทุน');
        });

        it('splits cash against credit sales as a percentage of the month', async () => {
            const body = await context(app, {
                orders: {
                    data: [
                        { ...order(atBangkok(TODAY), 750), payment_type: 'cash' },
                        { ...order(atBangkok(TODAY), 250), payment_type: 'credit_sale' }
                    ],
                    error: null
                }
            });

            expect(body.context).toContain('Cash Flow: 75% Cash / 25% Debt');
        });

        it('does not divide by zero when the month has no sales', async () => {
            const body = await context(app);

            expect(body.context).toContain('Cash Flow: 0% Cash / 0% Debt');
            expect(body.raw.salesMonth).toBe(0);
        });

        it('treats a non-numeric total as zero instead of producing NaN', async () => {
            const body = await context(app, {
                orders: { data: [order(atBangkok(TODAY), null), order(atBangkok(TODAY), '250')], error: null }
            });

            expect(body.raw.salesMonth).toBe(250);
        });

        it('still counts an order\'s cost when its product row was deleted', async () => {
            // The product join comes back null, but the money was real.
            const body = await context(app, {
                orders: {
                    data: [order(atBangkok(TODAY), 500, [
                        { qty: 2, price_per_unit: 250, cost_price_at_sale: 100, subtotal: 500, products: null }
                    ])],
                    error: null
                }
            });

            expect(body.raw.profitMonth).toBe(300); // 500 - 200
        });
    });

    describe('quantities in weight units', () => {
        it('converts grams to kilograms when tallying how much sold', async () => {
            // 3000 g sold; a reorder line should read in kg, not grams.
            const body = await context(app, {
                orders: {
                    data: Array.from({ length: 5 }, (_, i) =>
                        order(`2026-08-2${i + 1}T05:00:00.000Z`, 300, [item('หมูสับ', 3000, 0.1, 0.05, { id: 'p1', unit: 'กรัม' })])),
                    error: null
                },
                products: { data: [product({ id: 'p1', name: 'หมูสับ', stock_qty: 2, unit_type: 'กก.' })], error: null }
            });

            // 5 orders x 3000 g = 15000 g = 15 kg, which clears the >10 sold threshold.
            expect(body.raw.reorderList).toHaveLength(1);
            expect(body.context).toContain('หมูสับ (15 กก.)');
        });

        it('converts ขีด to kilograms at ten to one', async () => {
            const body = await context(app, {
                orders: {
                    data: [order(atBangkok(TODAY), 100, [item('เนื้อ', 25, 4, 2, { unit: 'ขีด' })])],
                    error: null
                }
            });

            expect(body.context).toContain('เนื้อ (2.50 กก.)');
        });

        it('shows a whole number without decimals and a fraction with two', async () => {
            const body = await context(app, {
                orders: {
                    data: [
                        order(atBangkok(TODAY), 100, [item('กล้วย', 4, 25, 10)]),
                        order(atBangkok(TODAY), 60, [item('ส้ม', 1500, 0.04, 0.02, { unit: 'กรัม' })])
                    ],
                    error: null
                }
            });

            expect(body.context).toContain('กล้วย (4 ชิ้น)');
            expect(body.context).toContain('ส้ม (1.50 กก.)');
        });

        it('falls back to the product\'s own unit when the order line has none', async () => {
            const body = await context(app, {
                orders: {
                    data: [order(atBangkok(TODAY), 100, [item('พริก', 2000, 0.05, 0.02, { unitType: 'กรัม' })])],
                    error: null
                }
            });

            expect(body.context).toContain('พริก (2 กก.)');
        });
    });

    describe('best sellers', () => {
        it('ranks by quantity and by revenue separately', async () => {
            const body = await context(app, {
                orders: {
                    data: [
                        order(atBangkok(TODAY), 1000, [item('ถุงพลาสติก', 100, 1, 0.5, { id: 'cheap' })]),
                        order(atBangkok(TODAY), 1000, [item('เหล้า', 2, 500, 300, { id: 'pricey' })])
                    ],
                    error: null
                }
            });

            const byQty = body.context.split('By Quantity: ')[1].split('\n')[0];
            const byRev = body.context.split('By Revenue: ')[1].split('\n')[0];
            expect(byQty.indexOf('ถุงพลาสติก')).toBeLessThan(byQty.indexOf('เหล้า'));
            expect(byRev.indexOf('เหล้า')).toBeLessThan(byRev.indexOf('ถุงพลาสติก'));
        });

        it('lists at most five products in each ranking', async () => {
            const items = Array.from({ length: 8 }, (_, i) =>
                item(`สินค้า${i}`, 10 - i, 10, 5, { id: `p${i}` }));

            const body = await context(app, {
                orders: { data: [order(atBangkok(TODAY), 500, items)], error: null }
            });

            expect(body.context.split('By Quantity: ')[1].split('\n')[0].split(', ')).toHaveLength(5);
        });

        it('says there are no sales yet rather than printing an empty list', async () => {
            const body = await context(app);

            expect(body.context).toContain('By Quantity: No sales yet');
            expect(body.context).toContain('By Revenue: No sales yet');
        });

        it('accumulates a product sold across several orders', async () => {
            const body = await context(app, {
                orders: {
                    data: [
                        order(atBangkok(TODAY), 40, [item('นม', 2, 20, 12, { id: 'milk' })]),
                        order(atBangkok('2026-08-10'), 60, [item('นม', 3, 20, 12, { id: 'milk' })])
                    ],
                    error: null
                }
            });

            expect(body.context).toContain('นม (5 ชิ้น)');
            expect(body.context).toContain('นม (ยอดขายรวมทั้งเดือน ฿100)');
        });

        it('leaves last month\'s sales out of the monthly ranking', async () => {
            const body = await context(app, {
                orders: {
                    data: [order(atBangkok('2026-07-28'), 900, [item('ของเก่า', 9, 100, 50)])],
                    error: null
                }
            });

            expect(body.context).toContain('By Quantity: No sales yet');
        });
    });

    describe('basket pairs, peak hours and best day', () => {
        it('reports a pair only once it has occurred at least twice', async () => {
            const pair = (day) => order(`2026-08-${day}T05:00:00.000Z`, 100, [
                item('ขนมปัง', 1, 30, 20, { id: 'bread' }),
                item('นม', 1, 20, 12, { id: 'milk' })
            ]);

            const once = await context(app, { orders: { data: [pair('10')], error: null } });
            expect(once.context).not.toContain('ขนมปัง + นม');

            mockDb.reset();
            mockDb.onDefault(() => ({ data: [], error: null, count: 0 }));
            const twice = await context(app, { orders: { data: [pair('10'), pair('11')], error: null } });
            expect(twice.context).toContain('ขนมปัง + นม');
        });

        it('ranks the pairs, listing the most frequent basket first', async () => {
            const basket = (day, names) => order(`2026-08-${day}T05:00:00.000Z`, 100,
                names.map((n) => item(n, 1, 20, 10, { id: n })));

            const body = await context(app, {
                orders: {
                    data: [
                        basket('10', ['ก', 'ข']),
                        basket('11', ['ก', 'ข']),
                        basket('12', ['ก', 'ข']),
                        basket('13', ['ค', 'ง']),
                        basket('14', ['ค', 'ง'])
                    ],
                    error: null
                }
            });

            const pairs = body.context.split('Best Pairs: ')[1].split('\n')[0];
            expect(pairs.indexOf('ก + ข')).toBeLessThan(pairs.indexOf('ค + ง'));
        });

        it('names the busiest hours in Bangkok time', async () => {
            const body = await context(app, {
                orders: {
                    data: [
                        order('2026-08-26T02:00:00.000Z', 100), // 09:00 Bangkok
                        order('2026-08-26T02:30:00.000Z', 100),
                        order('2026-08-25T11:00:00.000Z', 100)  // 18:00 Bangkok
                    ],
                    error: null
                }
            });

            expect(body.context).toContain('9:00');
        });

        it('names the best weekday from Bangkok-local dates', async () => {
            const body = await context(app, {
                orders: { data: [order(atBangkok(TODAY), 5000)], error: null }
            });

            expect(body.context).toContain('Wed');
        });
    });

    describe('expiry buckets', () => {
        it('separates expired, expiring today and still-good batches', async () => {
            const body = await context(app, {
                product_batches: {
                    data: [
                        batch('นมหมดแล้ว', '2026-08-24'),
                        batch('ขนมหมดวันนี้', TODAY),
                        batch('น้ำใกล้หมด', '2026-08-30')
                    ],
                    error: null
                }
            });

            expect(body.raw.expiredList.map((e) => e.name)).toEqual(['นมหมดแล้ว']);
            expect(body.raw.expiresTodayList.map((e) => e.name)).toEqual(['ขนมหมดวันนี้']);
            expect(body.raw.expiryList.map((e) => e.name)).toEqual(['น้ำใกล้หมด']);
        });

        it('counts how many days ago a batch expired', async () => {
            const body = await context(app, {
                product_batches: { data: [batch('นม', '2026-08-21')], error: null }
            });

            expect(body.raw.expiredList[0].status).toBe('หมดอายุแล้ว 5 วัน');
        });

        it('counts how many days are left on a batch', async () => {
            const body = await context(app, {
                product_batches: { data: [batch('น้ำ', '2026-09-02')], error: null }
            });

            expect(body.raw.expiryList[0]).toMatchObject({ status: 'อีก 7 วัน', daysUntilExpiry: 7 });
        });

        it('tells the AI expired stock must be written off, never sold', async () => {
            const body = await context(app, {
                product_batches: { data: [batch('นมบูด', '2026-08-20')], error: null }
            });

            expect(body.context).toContain('ห้ามขาย! ต้องตัดสต็อกทิ้งเท่านั้น');
            expect(body.context).toContain('นมบูด');
        });

        it('marks a batch expiring today as urgent but still sellable', async () => {
            const body = await context(app, {
                product_batches: { data: [batch('ขนมปัง', TODAY)], error: null }
            });

            expect(body.raw.expiresTodayList[0].daysUntilExpiry).toBe(0);
            expect(body.context).toContain('ขายได้แต่ต้องรีบมาก');
        });

        it('carries cost and sale price so the AI can price a clearance', async () => {
            const body = await context(app, {
                product_batches: { data: [batch('โยเกิร์ต', '2026-08-28', { cost: 12, price: 30, qty: 4 })], error: null }
            });

            expect(body.raw.expiryList[0]).toMatchObject({ costPrice: 12, sellPrice: 30, qty: 4 });
        });

        it('says there is nothing expiring when the store is clean', async () => {
            const body = await context(app);

            expect(body.context).toContain('ไม่มีสินค้าใกล้หมดอายุ');
            expect(body.raw.expiryList).toEqual([]);
        });

        it('names an unnamed batch rather than printing undefined', async () => {
            const body = await context(app, {
                product_batches: { data: [{ remaining_qty: 1, expire_date: '2026-08-28', products: null }], error: null }
            });

            expect(body.raw.expiryList[0]).toMatchObject({ name: 'ไม่ระบุชื่อ', unit: 'ชิ้น' });
        });
    });

    describe('debt', () => {
        const debt = (name, amount, dueDate, phone = '0812345678') => ({
            remaining_amount: amount,
            customers_info: { store_id: STORE_ID, name, phone, due_date: dueDate }
        });

        it('merges several accounts belonging to one customer', async () => {
            const body = await context(app, {
                credit_accounts: {
                    data: [debt('สมชาย', '300', null), debt('สมชาย', '200', null)],
                    error: null
                }
            });

            expect(body.raw.debtList).toHaveLength(1);
            expect(body.raw.debtList[0].amount).toBe(500);
        });

        it('flags how many days a debt is overdue', async () => {
            const body = await context(app, {
                credit_accounts: { data: [debt('สมหญิง', '100', '2026-08-16')], error: null }
            });

            expect(body.raw.debtList[0].status).toBe('เกินกำหนด 10 วัน');
        });

        it('says when a debt falls due today', async () => {
            const body = await context(app, {
                credit_accounts: { data: [debt('สมปอง', '100', atBangkok(TODAY))], error: null }
            });

            expect(body.raw.debtList[0].status).toBe('ครบกำหนดวันนี้');
        });

        it('counts down to a debt that is not due yet', async () => {
            const body = await context(app, {
                credit_accounts: { data: [debt('สมศรี', '100', '2026-09-01T05:00:00.000Z')], error: null }
            });

            expect(body.raw.debtList[0].status).toBe('อีก 6 วัน');
        });

        it('leaves the status blank when no due date was recorded', async () => {
            const body = await context(app, {
                credit_accounts: { data: [debt('ไม่ระบุกำหนด', '100', null)], error: null }
            });

            expect(body.raw.debtList[0].status).toBe('');
            expect(body.context).toContain('ไม่ระบุวันครบกำหนด');
        });

        it('sorts debtors by how much they owe and shows the top five', async () => {
            const rows = Array.from({ length: 7 }, (_, i) => debt(`ลูกหนี้${i}`, String((i + 1) * 100), null));

            const body = await context(app, { credit_accounts: { data: rows, error: null } });

            expect(body.raw.debtList[0].name).toBe('ลูกหนี้6');
            const printed = body.context.split('👥')[1].split('🚫')[0].split('\n').filter((l) => l.startsWith('•'));
            expect(printed).toHaveLength(5);
            expect(printed[0]).toContain('฿700');
        });

        it('sums the total outstanding into the risk line', async () => {
            const body = await context(app, {
                credit_accounts: { data: [debt('ก', '1200', null), debt('ข', '800', null)], error: null }
            });

            expect(body.context).toContain('Debt Risk: ฿2,000 outstanding');
        });

        it('labels an unnamed customer instead of leaving a blank', async () => {
            const body = await context(app, {
                credit_accounts: { data: [{ remaining_amount: '50', customers_info: null }], error: null }
            });

            expect(body.raw.debtList[0].name).toBe('ไม่ระบุชื่อชื่อ'.slice(0, 11));
        });

        it('says there are no debtors when the ledger is empty', async () => {
            const body = await context(app);

            expect(body.context).toContain('ไม่มีลูกหนี้');
        });
    });

    describe('stock signals', () => {
        it('suggests a reorder quantity covering the next fourteen days', async () => {
            const body = await context(app, {
                orders: {
                    data: [order(atBangkok(TODAY), 600, [item('ไข่ไก่', 30, 20, 12, { id: 'egg' })])],
                    error: null
                },
                products: { data: [product({ id: 'egg', name: 'ไข่ไก่', stock_qty: 2, low_stock_threshold: 5 })], error: null }
            });

            // 30 sold over 30 days is 1/day; 14 days needs 14, minus 2 in stock.
            expect(body.raw.reorderList[0]).toMatchObject({ name: 'ไข่ไก่', suggestedOrder: 12 });
            expect(body.context).toContain('ควรสั่งเพิ่มด่วน 12 ชิ้น');
        });

        it('says to top up rather than naming a quantity when stock already covers demand', async () => {
            const body = await context(app, {
                orders: {
                    data: [order(atBangkok(TODAY), 220, [item('นม', 11, 20, 12, { id: 'milk' })])],
                    error: null
                },
                products: { data: [product({ id: 'milk', name: 'นม', stock_qty: 20, low_stock_threshold: 40 })], error: null }
            });

            expect(body.raw.reorderList[0].suggestedOrder).toBeLessThanOrEqual(0);
            expect(body.context).toContain('ควรเติมสต็อก');
        });

        it('leaves a well-stocked seller out of the reorder list', async () => {
            const body = await context(app, {
                orders: {
                    data: [order(atBangkok(TODAY), 600, [item('ไข่', 30, 20, 12, { id: 'egg' })])],
                    error: null
                },
                products: { data: [product({ id: 'egg', stock_qty: 100, low_stock_threshold: 5 })], error: null }
            });

            expect(body.raw.reorderList).toEqual([]);
        });

        it('reports stock that has not sold at all as dead money', async () => {
            const body = await context(app, {
                products: { data: [product({ name: 'ของค้าง', stock_qty: 50, cost_price: 30, price: 45 })], error: null }
            });

            expect(body.raw.deadStockList[0]).toMatchObject({ name: 'ของค้าง', qty: 50, costPrice: 30 });
            expect(body.context).toContain('ของค้าง (Stock 50, 0 Sales)');
        });

        it('does not call a small unsold stock dead', async () => {
            const body = await context(app, {
                products: { data: [product({ stock_qty: 3 })], error: null }
            });

            expect(body.raw.deadStockList).toEqual([]);
        });

        it('lists products that have run out', async () => {
            const body = await context(app, {
                products: {
                    data: [product({ name: 'หมด', stock_qty: 0 }), product({ id: 'p2', name: 'ติดลบ', stock_qty: -2 })],
                    error: null
                }
            });

            expect(body.raw.zeroStockProducts).toEqual(['หมด', 'ติดลบ']);
        });
    });

    describe('margin analysis', () => {
        it('flags a strong seller whose margin is thin', async () => {
            const body = await context(app, {
                orders: {
                    data: [order(atBangkok(TODAY), 2000, [item('น้ำอัดลม', 20, 100, 92, { id: 'coke' })])],
                    error: null
                },
                products: { data: [product({ id: 'coke', name: 'น้ำอัดลม', cost_price: 92, price: 100, stock_qty: 30 })], error: null }
            });

            expect(body.context).toContain('น้ำอัดลม (ขายไป 20 ชิ้น แต่กำไรต่อหน่วยละ 8%)');
        });

        it('flags a high-margin product that will not move', async () => {
            const body = await context(app, {
                products: { data: [product({ name: 'ของแพง', stock_qty: 20, cost_price: 20, price: 100 })], error: null }
            });

            expect(body.context).toContain('ของแพง (กำไรตั้ง 80%)');
        });

        it('offers a thin-margin product for a pricing review', async () => {
            const body = await context(app, {
                products: { data: [product({ name: 'บาง', cost_price: 90, price: 100, stock_qty: 5 })], error: null }
            });

            expect(body.raw.pricingCandidates[0]).toMatchObject({ name: 'บาง', margin: 10, cost: 90, price: 100 });
        });

        it('offers an unsold but fat-margin product for a pricing review', async () => {
            const body = await context(app, {
                products: { data: [product({ name: 'อ้วน', cost_price: 20, price: 100, stock_qty: 5 })], error: null }
            });

            expect(body.raw.pricingCandidates[0]).toMatchObject({ name: 'อ้วน', margin: 80, sold30d: 0 });
        });

        it('does not offer a product with no cost price recorded', async () => {
            const body = await context(app, {
                products: { data: [product({ cost_price: 0, price: 100, stock_qty: 5 })], error: null }
            });

            expect(body.raw.pricingCandidates).toEqual([]);
        });

        it('does not offer a product that is out of stock', async () => {
            const body = await context(app, {
                products: { data: [product({ cost_price: 90, price: 100, stock_qty: 0 })], error: null }
            });

            expect(body.raw.pricingCandidates).toEqual([]);
        });

        it('does not divide by zero when a product has no sale price', async () => {
            const body = await context(app, {
                products: { data: [product({ name: 'ไม่มีราคา', cost_price: 10, price: 0, stock_qty: 5 })], error: null }
            });

            expect(body.raw.pricingCandidates).toEqual([]);
            expect(body.context).not.toContain('NaN');
        });
    });

    describe('active promotions', () => {
        it('names the products already on promotion so the AI does not repeat them', async () => {
            mockDb.on('promotion_items', {
                data: [{ product_id: 'p9', promotions: { name: 'ลดล้างสต็อก', type: 'percentage', discount_value: 20, end_date: '2026-08-31' } }],
                error: null
            });
            mockDb.on('products', (state) => (filterArgs(state, 'in').length > 0
                ? { data: [{ id: 'p9', name: 'นมสด' }], error: null }
                : { data: [], error: null }));

            const body = await context(app);

            expect(body.raw.promoProductNames).toEqual(['นมสด']);
            expect(body.context).toContain('ห้ามแนะนำซ้ำ): นมสด');
            expect(body.context).toContain('ลดล้างสต็อก — สินค้า: นมสด');
        });

        it('says there are none when no promotion is running', async () => {
            const body = await context(app);

            expect(body.raw.promoProductNames).toEqual([]);
            expect(body.context).toContain('ห้ามแนะนำซ้ำ): ไม่มี');
        });

        it('reads only promotions that are active and in date for this store', async () => {
            await context(app);

            const [promos] = mockDb.callsFor('promotion_items');
            expect(filterArgs(promos, 'eq')).toContainEqual(['promotions.is_active', true]);
            expect(filterArgs(promos, 'eq')).toContainEqual(['promotions.store_id', STORE_ID]);
            expect(filterArgs(promos, 'lte')).toContainEqual(['promotions.start_date', TODAY]);
            expect(filterArgs(promos, 'gte')).toContainEqual(['promotions.end_date', TODAY]);
        });

        it('labels a promotion whose product row is missing', async () => {
            mockDb.on('promotion_items', {
                data: [{ product_id: null, promotions: { name: 'โปรลึกลับ', type: 'percentage', discount_value: 5, end_date: '2026-08-31' } }],
                error: null
            });

            const body = await context(app);

            expect(body.context).toContain('โปรลึกลับ — สินค้า: ไม่ระบุ');
        });
    });

    describe('store identity and surroundings', () => {
        it('uses the store name from the database', async () => {
            const body = await context(app, { stores: { data: [{ name: 'ร้านลุงหมี' }], error: null } });

            expect(body.context).toContain('AI Business Partner for Store "ร้านลุงหมี"');
        });

        it('falls back to a generic name when the store row is missing', async () => {
            const body = await context(app);

            expect(body.context).toContain('Store "ร้านของคุณ"');
        });

        it('reports the season from the Bangkok month', async () => {
            const body = await context(app);

            expect(body.context).toContain('[SEASON: Rainy]'); // August
        });

        it('includes the resolved address and weather', async () => {
            const body = await context(app);

            expect(body.raw.address).toContain('บางรัก');
            expect(body.context).toContain('32°C');
        });

        it('survives a failed geocoding lookup', async () => {
            global.fetch = jest.fn().mockRejectedValue(new Error('offline'));

            const body = await context(app);

            expect(body.context).toContain('[LOCATION: Thailand]');
            expect(body.context).toContain('[WEATHER: N/A]');
        });

        it('passes the caller\'s coordinates to the lookups', async () => {
            await request(app).get('/api/ai/context?lat=13.75&lon=100.5').set(headers);

            const urls = global.fetch.mock.calls.map(([url]) => String(url));
            expect(urls.some((u) => u.includes('13.75') && u.includes('100.5'))).toBe(true);
        });

        it('prints the reporting period as a Thai month range', async () => {
            const body = await context(app);

            expect(body.context).toMatch(/Period: 1 - 26 .+ \(26 Days\)/);
        });

        it('starts the period on the 1st, not on the last day of the previous month', async () => {
            // startOfMonth is a UTC instant seven hours behind Bangkok midnight, so
            // reading a day number off it used to print "Period: 31 - 26 ส.ค.".
            const body = await context(app);

            expect(body.context).not.toContain('Period: 31');
        });
    });

    describe('failures', () => {
        it('returns 400 without a store header', async () => {
            const res = await request(app).get('/api/ai/context');

            expect(res.status).toBe(400);
            expect(res.body.error).toBe('Store ID required');
        });

        it('returns 500 when a lookup throws', async () => {
            mockDb.on('stores', () => { throw new Error('connection reset'); });

            const res = await request(app).get('/api/ai/context').set(headers);

            expect(res.status).toBe(500);
            expect(res.body.error).toBe('connection reset');
        });
    });
});
