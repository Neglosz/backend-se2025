const request = require('supertest');
const { registerReportRoutes } = require('../../routes/reportRoutes');
const { createMockSupabase, filterArgs } = require('../helpers/mockSupabase');
const { createTestApp, allowAccess, denyAccess, STORE_ID, storeHeader } = require('../helpers/testApp');

// Every range in this module is derived from `Date.now()` shifted to UTC+7, so the
// clock is pinned to a known instant: 2025-03-12T03:00:00Z = Wed 12 Mar 2025, 10:00
// in Bangkok. Only `Date.now` is stubbed, so `new Date(isoString)` still parses.
const FIXED_NOW = Date.UTC(2025, 2, 12, 3, 0, 0);

const RANGE = {
    todayStart: '2025-03-11T17:00:00.000Z',
    todayEnd: '2025-03-12T16:59:59.999Z',
    weekStart: '2025-03-09T17:00:00.000Z',
    monthStart: '2025-02-28T17:00:00.000Z',
    yearStart: '2024-12-31T17:00:00.000Z',
    prevDayStart: '2025-03-10T17:00:00.000Z',
    prevDayEnd: '2025-03-11T16:59:59.999Z',
    prevWeekStart: '2025-03-02T17:00:00.000Z',
    prevWeekEnd: '2025-03-09T16:59:59.999Z',
    prevMonthStart: '2025-01-31T17:00:00.000Z',
    prevMonthEnd: '2025-02-28T16:59:59.999Z'
};

describe('routes/reportRoutes', () => {
    let supabaseAdmin;
    let errorSpy;
    let nowSpy;

    beforeEach(() => {
        supabaseAdmin = createMockSupabase();
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        nowSpy = jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
    });

    afterEach(() => {
        errorSpy.mockRestore();
        nowSpy.mockRestore();
    });

    const app = (checkStoreAccess = allowAccess) =>
        createTestApp(registerReportRoutes, { supabaseAdmin, checkStoreAccess });

    describe('GET /api/reports/sales-summary', () => {
        it('sums the order totals and counts the orders', async () => {
            supabaseAdmin.on('orders', { data: [{ total_amount: '100.25' }, { total_amount: '50' }], error: null });

            const res = await request(app()).get('/api/reports/sales-summary').set(storeHeader);

            expect(res.status).toBe(200);
            expect(res.body.data).toMatchObject({ totalSales: 150.25, totalOrders: 2 });
        });

        it('defaults to today and excludes cancelled orders', async () => {
            supabaseAdmin.on('orders', { data: [], error: null });

            await request(app()).get('/api/reports/sales-summary').set(storeHeader);

            const [call] = supabaseAdmin.callsFor('orders');
            expect(filterArgs(call, 'eq')).toContainEqual(['store_id', STORE_ID]);
            expect(filterArgs(call, 'neq')).toContainEqual(['payment_status', 'cancelled']);
            expect(filterArgs(call, 'gte')).toContainEqual(['created_at', RANGE.todayStart]);
            expect(filterArgs(call, 'lte')).toContainEqual(['created_at', RANGE.todayEnd]);
        });

        it('builds the Thai-time range for week, month and year', async () => {
            supabaseAdmin.on('orders', { data: [], error: null });

            await request(app()).get('/api/reports/sales-summary?period=week').set(storeHeader);
            await request(app()).get('/api/reports/sales-summary?period=month').set(storeHeader);
            await request(app()).get('/api/reports/sales-summary?period=year').set(storeHeader);

            const calls = supabaseAdmin.callsFor('orders').filter((c) => filterArgs(c, 'gte').length);
            const starts = calls.map((c) => filterArgs(c, 'gte')[0][1]);
            expect(starts).toContain(RANGE.weekStart);
            expect(starts).toContain(RANGE.monthStart);
            expect(starts).toContain(RANGE.yearStart);
        });

        it('treats "day" as an alias for "today"', async () => {
            supabaseAdmin.on('orders', { data: [], error: null });

            await request(app()).get('/api/reports/sales-summary?period=day').set(storeHeader);

            expect(filterArgs(supabaseAdmin.callsFor('orders')[0], 'gte')).toContainEqual(['created_at', RANGE.todayStart]);
        });

        it('compares today against yesterday for growth', async () => {
            supabaseAdmin.queue('orders',
                { data: [{ total_amount: '150' }], error: null },
                { data: [{ total_amount: '100' }], error: null });

            const res = await request(app()).get('/api/reports/sales-summary?period=today').set(storeHeader);

            expect(res.body.data.growth).toBe(50);
            const [, prev] = supabaseAdmin.callsFor('orders');
            expect(filterArgs(prev, 'gte')).toContainEqual(['created_at', RANGE.prevDayStart]);
            expect(filterArgs(prev, 'lte')).toContainEqual(['created_at', RANGE.prevDayEnd]);
        });

        it('compares the current week against the previous Monday-Sunday week', async () => {
            supabaseAdmin.queue('orders', { data: [], error: null }, { data: [], error: null });

            await request(app()).get('/api/reports/sales-summary?period=week').set(storeHeader);

            const [, prev] = supabaseAdmin.callsFor('orders');
            expect(filterArgs(prev, 'gte')).toContainEqual(['created_at', RANGE.prevWeekStart]);
            expect(filterArgs(prev, 'lte')).toContainEqual(['created_at', RANGE.prevWeekEnd]);
        });

        it('compares the current month against the whole previous month', async () => {
            supabaseAdmin.queue('orders', { data: [], error: null }, { data: [], error: null });

            await request(app()).get('/api/reports/sales-summary?period=month').set(storeHeader);

            const [, prev] = supabaseAdmin.callsFor('orders');
            expect(filterArgs(prev, 'gte')).toContainEqual(['created_at', RANGE.prevMonthStart]);
            expect(filterArgs(prev, 'lte')).toContainEqual(['created_at', RANGE.prevMonthEnd]);
        });

        it('reports zero growth for a yearly report (no previous period defined)', async () => {
            supabaseAdmin.on('orders', { data: [{ total_amount: '500' }], error: null });

            const res = await request(app()).get('/api/reports/sales-summary?period=year').set(storeHeader);

            expect(res.body.data.growth).toBe(0);
            expect(supabaseAdmin.callsFor('orders')).toHaveLength(1);
        });

        it('reports 100% growth when the previous period had no sales but this one does', async () => {
            supabaseAdmin.queue('orders', { data: [{ total_amount: '80' }], error: null }, { data: [], error: null });

            const res = await request(app()).get('/api/reports/sales-summary?period=today').set(storeHeader);

            expect(res.body.data.growth).toBe(100);
        });

        it('reports zero growth when both periods are empty', async () => {
            supabaseAdmin.queue('orders', { data: [], error: null }, { data: [], error: null });

            const res = await request(app()).get('/api/reports/sales-summary?period=today').set(storeHeader);

            expect(res.body.data).toEqual({ totalSales: 0, totalOrders: 0, growth: 0 });
        });

        it('reports negative growth when sales fell', async () => {
            supabaseAdmin.queue('orders', { data: [{ total_amount: '50' }], error: null }, { data: [{ total_amount: '200' }], error: null });

            const res = await request(app()).get('/api/reports/sales-summary?period=today').set(storeHeader);

            expect(res.body.data.growth).toBe(-75);
        });

        it('rounds the growth percentage to a whole number', async () => {
            supabaseAdmin.queue('orders', { data: [{ total_amount: '101' }], error: null }, { data: [{ total_amount: '99' }], error: null });

            const res = await request(app()).get('/api/reports/sales-summary?period=today').set(storeHeader);

            expect(Number.isInteger(res.body.data.growth)).toBe(true);
        });

        it('treats an unparseable total as zero', async () => {
            supabaseAdmin.on('orders', { data: [{ total_amount: null }, { total_amount: 'abc' }, { total_amount: '10' }], error: null });

            const res = await request(app()).get('/api/reports/sales-summary?period=year').set(storeHeader);

            expect(res.body.data).toMatchObject({ totalSales: 10, totalOrders: 3 });
        });

        it('requires a store header and store access', async () => {
            expect((await request(app()).get('/api/reports/sales-summary')).status).toBe(400);
            expect((await request(app(denyAccess)).get('/api/reports/sales-summary').set(storeHeader)).status).toBe(403);
            expect(supabaseAdmin.from).not.toHaveBeenCalled();
        });

        it('returns 500 when the query fails', async () => {
            supabaseAdmin.on('orders', { data: null, error: { message: 'timeout' } });

            const res = await request(app()).get('/api/reports/sales-summary').set(storeHeader);

            expect(res.status).toBe(500);
            expect(res.body).toEqual({ success: false, error: 'timeout' });
        });
    });

    describe('GET /api/reports/sales-chart', () => {
        it('groups today by Thai hour and only keeps hours with sales', async () => {
            supabaseAdmin.on('orders', {
                data: [
                    { created_at: '2025-03-12T02:30:00.000Z', total_amount: '100' }, // 09:00 TH
                    { created_at: '2025-03-12T02:45:00.000Z', total_amount: '50' },  // 09:00 TH
                    { created_at: '2025-03-12T05:10:00.000Z', total_amount: '200' }  // 12:00 TH
                ],
                error: null
            });

            const res = await request(app()).get('/api/reports/sales-chart?period=today').set(storeHeader);

            expect(res.status).toBe(200);
            expect(res.body.data.labels).toEqual(['9:00', '12:00']);
            expect(res.body.data.values).toEqual([150, 200]);
        });

        it('reports the peak hour and its amount for today', async () => {
            supabaseAdmin.on('orders', {
                data: [
                    { created_at: '2025-03-12T02:30:00.000Z', total_amount: '100' },
                    { created_at: '2025-03-12T05:10:00.000Z', total_amount: '300' }
                ],
                error: null
            });

            const res = await request(app()).get('/api/reports/sales-chart?period=today').set(storeHeader);

            expect(res.body.data.peakTime).toBe('12:00 น.');
            expect(res.body.data.peakAmount).toBe(300);
        });

        it('wraps hours past midnight UTC into the Thai day', async () => {
            supabaseAdmin.on('orders', {
                data: [{ created_at: '2025-03-11T18:30:00.000Z', total_amount: '40' }], // 01:00 TH
                error: null
            });

            const res = await request(app()).get('/api/reports/sales-chart?period=today').set(storeHeader);

            expect(res.body.data.labels).toEqual(['1:00']);
        });

        it('emits one bucket per day from Monday to today for a weekly chart', async () => {
            supabaseAdmin.on('orders', {
                data: [{ created_at: '2025-03-11T04:00:00.000Z', total_amount: '120' }],
                error: null
            });

            const res = await request(app()).get('/api/reports/sales-chart?period=week').set(storeHeader);

            expect(res.body.data.labels).toEqual(['10/3', '11/3', '12/3']);
            expect(res.body.data.values).toEqual([0, 120, 0]);
            expect(res.body.data.peakTime).toBe('11/3');
        });

        it('emits one bucket per day from the 1st to today for a monthly chart', async () => {
            supabaseAdmin.on('orders', {
                data: [{ created_at: '2025-03-03T04:00:00.000Z', total_amount: '75' }],
                error: null
            });

            const res = await request(app()).get('/api/reports/sales-chart?period=month').set(storeHeader);

            expect(res.body.data.labels).toHaveLength(12); // 1..12 March
            expect(res.body.data.labels[0]).toBe('1/3');
            expect(res.body.data.values[2]).toBe(75);
        });

        it('ignores orders that fall outside the generated buckets', async () => {
            supabaseAdmin.on('orders', {
                data: [{ created_at: '2025-02-20T04:00:00.000Z', total_amount: '999' }],
                error: null
            });

            const res = await request(app()).get('/api/reports/sales-chart?period=week').set(storeHeader);

            expect(res.body.data.values).toEqual([0, 0, 0]);
            expect(res.body.data.peakAmount).toBe(0);
        });

        it('returns empty arrays and a placeholder peak when there are no sales today', async () => {
            supabaseAdmin.on('orders', { data: [], error: null });

            const res = await request(app()).get('/api/reports/sales-chart?period=today').set(storeHeader);

            expect(res.body.data).toEqual({ labels: [], values: [], peakTime: '-', peakAmount: 0 });
        });

        it('returns empty arrays for a period with no chart branch (e.g. year)', async () => {
            supabaseAdmin.on('orders', { data: [{ created_at: '2025-03-12T02:00:00.000Z', total_amount: '10' }], error: null });

            const res = await request(app()).get('/api/reports/sales-chart?period=year').set(storeHeader);

            expect(res.body.data.labels).toEqual([]);
            expect(res.body.data.values).toEqual([]);
        });

        it('reads chronologically, excludes cancelled orders and scopes to the store', async () => {
            supabaseAdmin.on('orders', { data: [], error: null });

            await request(app()).get('/api/reports/sales-chart?period=today').set(storeHeader);

            const [call] = supabaseAdmin.callsFor('orders');
            expect(call.filters).toContainEqual({ name: 'order', args: ['created_at', { ascending: true }] });
            expect(filterArgs(call, 'neq')).toContainEqual(['payment_status', 'cancelled']);
            expect(filterArgs(call, 'eq')).toContainEqual(['store_id', STORE_ID]);
        });

        it('requires a store header and store access', async () => {
            expect((await request(app()).get('/api/reports/sales-chart')).status).toBe(400);
            expect((await request(app(denyAccess)).get('/api/reports/sales-chart').set(storeHeader)).status).toBe(403);
        });

        it('returns 500 when the query fails', async () => {
            supabaseAdmin.on('orders', { data: null, error: { message: 'boom' } });

            const res = await request(app()).get('/api/reports/sales-chart').set(storeHeader);

            expect(res.status).toBe(500);
        });
    });

    describe('GET /api/reports/payment-methods', () => {
        it('splits settled payments into cash, qr and card buckets with percentages', async () => {
            supabaseAdmin
                .on('payments', {
                    data: [
                        { amount: '60', method: 'cash' },
                        { amount: '30', method: 'qr_promptpay' },
                        { amount: '10', method: 'credit' }
                    ],
                    error: null
                })
                .on('credit_accounts', { data: [], error: null });

            const res = await request(app()).get('/api/reports/payment-methods').set(storeHeader);

            expect(res.status).toBe(200);
            expect(res.body.data).toEqual({
                cash: { amount: 60, percent: 60 },
                qr: { amount: 30, percent: 30 },
                credit: { amount: 10, percent: 10 }
            });
        });

        it('adds outstanding credit balances to the credit bucket', async () => {
            supabaseAdmin
                .on('payments', { data: [{ amount: '50', method: 'cash' }], error: null })
                .on('credit_accounts', { data: [{ remaining_amount: '50' }], error: null });

            const res = await request(app()).get('/api/reports/payment-methods').set(storeHeader);

            expect(res.body.data.credit).toEqual({ amount: 50, percent: 50 });
            expect(res.body.data.cash).toEqual({ amount: 50, percent: 50 });
        });

        it('counts only the unpaid remainder of a partially paid credit account', async () => {
            supabaseAdmin
                .on('payments', { data: [], error: null })
                .on('credit_accounts', { data: [{ remaining_amount: '40' }], error: null });

            const res = await request(app()).get('/api/reports/payment-methods').set(storeHeader);

            expect(res.body.data.credit.amount).toBe(40);
        });

        it('ignores an unknown payment method in the buckets but still counts it in the total', async () => {
            supabaseAdmin
                .on('payments', { data: [{ amount: '50', method: 'cash' }, { amount: '50', method: 'voucher' }], error: null })
                .on('credit_accounts', { data: [], error: null });

            const res = await request(app()).get('/api/reports/payment-methods').set(storeHeader);

            expect(res.body.data.cash).toEqual({ amount: 50, percent: 50 });
        });

        it('returns zero percentages instead of dividing by zero', async () => {
            supabaseAdmin.on('payments', { data: [], error: null }).on('credit_accounts', { data: [], error: null });

            const res = await request(app()).get('/api/reports/payment-methods').set(storeHeader);

            expect(res.body.data).toEqual({
                cash: { amount: 0, percent: 0 },
                qr: { amount: 0, percent: 0 },
                credit: { amount: 0, percent: 0 }
            });
        });

        it('filters payments by the ORDER date, not the payment date', async () => {
            supabaseAdmin.on('payments', { data: [], error: null }).on('credit_accounts', { data: [], error: null });

            await request(app()).get('/api/reports/payment-methods').set(storeHeader);

            const [call] = supabaseAdmin.callsFor('payments');
            expect(filterArgs(call, 'gte')).toContainEqual(['orders.created_at', RANGE.todayStart]);
            expect(filterArgs(call, 'lte')).toContainEqual(['orders.created_at', RANGE.todayEnd]);
            expect(filterArgs(call, 'eq')).toContainEqual(['orders.store_id', STORE_ID]);
            expect(filterArgs(call, 'neq')).toContainEqual(['orders.payment_status', 'cancelled']);
        });

        it('reads only unpaid and partial credit accounts', async () => {
            supabaseAdmin.on('payments', { data: [], error: null }).on('credit_accounts', { data: [], error: null });

            await request(app()).get('/api/reports/payment-methods').set(storeHeader);

            expect(supabaseAdmin.callsFor('credit_accounts')[0].filters)
                .toContainEqual({ name: 'in', args: ['status', ['unpaid', 'partial']] });
        });

        it('requires a store header and store access', async () => {
            expect((await request(app()).get('/api/reports/payment-methods')).status).toBe(400);
            expect((await request(app(denyAccess)).get('/api/reports/payment-methods').set(storeHeader)).status).toBe(403);
        });

        it('returns 500 when either query fails', async () => {
            supabaseAdmin.on('payments', { data: null, error: { message: 'payments down' } });
            expect((await request(app()).get('/api/reports/payment-methods').set(storeHeader)).status).toBe(500);

            supabaseAdmin.reset();
            supabaseAdmin.on('payments', { data: [], error: null }).on('credit_accounts', { data: null, error: { message: 'credit down' } });
            const res = await request(app()).get('/api/reports/payment-methods').set(storeHeader);
            expect(res.body).toEqual({ success: false, error: 'credit down' });
        });
    });

    describe('GET /api/reports/recent-orders', () => {
        it('returns the ten most recent paid orders, newest first', async () => {
            supabaseAdmin.on('orders', {
                data: [{ id: 'o1', order_no: 'INV-1', total_amount: '99.5', created_at: '2025-03-12T02:30:00.000Z', customers_info: { name: 'สมชาย' } }],
                error: null
            });

            const res = await request(app()).get('/api/reports/recent-orders').set(storeHeader);

            expect(res.status).toBe(200);
            expect(res.body.data[0]).toMatchObject({ id: 'o1', orderNo: 'INV-1', customer: 'สมชาย', amount: 99.5 });

            const [call] = supabaseAdmin.callsFor('orders');
            expect(filterArgs(call, 'eq')).toContainEqual(['payment_status', 'paid']);
            expect(call.filters).toContainEqual({ name: 'order', args: ['created_at', { ascending: false }] });
            expect(call.filters).toContainEqual({ name: 'limit', args: [10] });
        });

        it('renders the time and date in Bangkok time on the Buddhist calendar', async () => {
            supabaseAdmin.on('orders', {
                data: [{ id: 'o1', total_amount: '10', created_at: '2025-03-12T02:30:00.000Z', customers_info: null }],
                error: null
            });

            const res = await request(app()).get('/api/reports/recent-orders').set(storeHeader);

            expect(res.body.data[0].time).toContain('09:30');
            expect(res.body.data[0].date).toContain('2568');
        });

        it('falls back to a generic customer label', async () => {
            supabaseAdmin.on('orders', {
                data: [{ id: 'o1', total_amount: '10', created_at: '2025-03-12T02:30:00.000Z', customers_info: null }],
                error: null
            });

            const res = await request(app()).get('/api/reports/recent-orders').set(storeHeader);

            expect(res.body.data[0].customer).toBe('ลูกค้าทั่วไป');
        });

        it('requires a store header and store access', async () => {
            expect((await request(app()).get('/api/reports/recent-orders')).status).toBe(400);
            expect((await request(app(denyAccess)).get('/api/reports/recent-orders').set(storeHeader)).status).toBe(403);
        });

        it('returns 500 when the query fails', async () => {
            supabaseAdmin.on('orders', { data: null, error: { message: 'down' } });

            const res = await request(app()).get('/api/reports/recent-orders').set(storeHeader);

            expect(res.status).toBe(500);
        });
    });
});
