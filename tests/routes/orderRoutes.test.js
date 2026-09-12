const request = require('supertest');
const { registerOrderRoutes } = require('../../routes/orderRoutes');
const { createMockSupabase, filterArgs } = require('../helpers/mockSupabase');
const { createTestApp, allowAccess, denyAccess, STORE_ID, storeHeader } = require('../helpers/testApp');

/** One order row shaped the way the select in the handler returns it. */
function orderRow(overrides = {}) {
    return {
        id: 'ord-1',
        order_no: 'INV-001',
        total_amount: '250.50',
        created_at: '2025-03-01T08:30:00.000Z',
        payment_status: 'paid',
        payment_type: 'cash_sale',
        customers_info: null,
        payments: [{ method: 'cash' }],
        ...overrides
    };
}

describe('routes/orderRoutes', () => {
    let supabaseAdmin;
    let errorSpy;

    beforeEach(() => {
        supabaseAdmin = createMockSupabase();
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => errorSpy.mockRestore());

    const app = (checkStoreAccess = allowAccess) =>
        createTestApp(registerOrderRoutes, { supabaseAdmin, checkStoreAccess });

    describe('GET /api/orders', () => {
        it('returns formatted orders with the total row count', async () => {
            supabaseAdmin.on('orders', { data: [orderRow()], count: 42, error: null });

            const res = await request(app()).get('/api/orders').set(storeHeader);

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ success: true, total: 42, page: 1, limit: 20 });
            expect(res.body.data[0]).toMatchObject({
                id: 'ord-1',
                orderNo: 'INV-001',
                amount: 250.5,
                paymentStatus: 'paid',
                method: 'cash'
            });
        });

        it('falls back to a generic customer label when the order has no customer', async () => {
            supabaseAdmin.on('orders', { data: [orderRow()], count: 1, error: null });

            const res = await request(app()).get('/api/orders').set(storeHeader);

            expect(res.body.data[0].customer).toBe('ลูกค้าทั่วไป');
        });

        it('uses the linked customer name when present', async () => {
            supabaseAdmin.on('orders', { data: [orderRow({ customers_info: { name: 'สมชาย' } })], count: 1, error: null });

            const res = await request(app()).get('/api/orders').set(storeHeader);

            expect(res.body.data[0].customer).toBe('สมชาย');
        });

        it('renders the timestamp in Bangkok time on the Buddhist calendar', async () => {
            supabaseAdmin.on('orders', { data: [orderRow()], count: 1, error: null });

            const res = await request(app()).get('/api/orders').set(storeHeader);

            // 08:30 UTC is 15:30 in Bangkok, and 2025 CE is 2568 BE.
            expect(res.body.data[0].time).toContain('15:30');
            expect(res.body.data[0].date).toContain('2568');
        });

        it('derives the display method from payment_type and the payment rows', async () => {
            supabaseAdmin.on('orders', {
                data: [
                    orderRow({ id: 'a', payment_type: 'credit_sale', payments: [] }),
                    orderRow({ id: 'b', payments: [{ method: 'qr_promptpay' }] }),
                    orderRow({ id: 'c', payments: [{ method: 'transfer' }] }),
                    orderRow({ id: 'd', payments: [] })
                ],
                count: 4,
                error: null
            });

            const res = await request(app()).get('/api/orders').set(storeHeader);

            expect(res.body.data.map((o) => o.method)).toEqual(['credit', 'qr', 'other', 'other']);
        });

        it('paginates with a default page size of 20', async () => {
            supabaseAdmin.on('orders', { data: [], count: 0, error: null });

            await request(app()).get('/api/orders').set(storeHeader);

            expect(supabaseAdmin.callsFor('orders')[0].filters).toContainEqual({ name: 'range', args: [0, 19] });
        });

        it('offsets the range for a later page', async () => {
            supabaseAdmin.on('orders', { data: [], count: 0, error: null });

            await request(app()).get('/api/orders?page=3&limit=10').set(storeHeader);

            expect(supabaseAdmin.callsFor('orders')[0].filters).toContainEqual({ name: 'range', args: [20, 29] });
        });

        it('falls back to page 1 / limit 20 on non-numeric pagination input', async () => {
            supabaseAdmin.on('orders', { data: [], count: 0, error: null });

            const res = await request(app()).get('/api/orders?page=abc&limit=xyz').set(storeHeader);

            expect(res.body).toMatchObject({ page: 1, limit: 20 });
            expect(supabaseAdmin.callsFor('orders')[0].filters).toContainEqual({ name: 'range', args: [0, 19] });
        });

        it('sorts newest first by default', async () => {
            supabaseAdmin.on('orders', { data: [], count: 0, error: null });

            await request(app()).get('/api/orders').set(storeHeader);

            expect(supabaseAdmin.callsFor('orders')[0].filters)
                .toContainEqual({ name: 'order', args: ['created_at', { ascending: false }] });
        });

        it('supports the oldest, highest and lowest sort modes', async () => {
            supabaseAdmin.on('orders', { data: [], count: 0, error: null });

            await request(app()).get('/api/orders?sort=oldest').set(storeHeader);
            await request(app()).get('/api/orders?sort=highest').set(storeHeader);
            await request(app()).get('/api/orders?sort=lowest').set(storeHeader);

            const [oldest, highest, lowest] = supabaseAdmin.callsFor('orders');
            expect(oldest.filters).toContainEqual({ name: 'order', args: ['created_at', { ascending: true }] });
            expect(highest.filters).toContainEqual({ name: 'order', args: ['total_amount', { ascending: false }] });
            expect(lowest.filters).toContainEqual({ name: 'order', args: ['total_amount', { ascending: true }] });
        });

        it('applies a date range when both bounds are given', async () => {
            supabaseAdmin.on('orders', { data: [], count: 0, error: null });

            await request(app()).get('/api/orders?startDate=2025-01-01&endDate=2025-01-31').set(storeHeader);

            const [call] = supabaseAdmin.callsFor('orders');
            expect(filterArgs(call, 'gte')).toContainEqual(['created_at', '2025-01-01']);
            expect(filterArgs(call, 'lte')).toContainEqual(['created_at', '2025-01-31']);
        });

        it('maps the status filter onto payment_status', async () => {
            supabaseAdmin.on('orders', { data: [], count: 0, error: null });

            await request(app()).get('/api/orders?status=paid').set(storeHeader);
            await request(app()).get('/api/orders?status=unpaid').set(storeHeader);
            await request(app()).get('/api/orders?status=pending').set(storeHeader);

            const [paid, unpaid, pending] = supabaseAdmin.callsFor('orders');
            expect(filterArgs(paid, 'eq')).toContainEqual(['payment_status', 'paid']);
            expect(unpaid.filters).toContainEqual({ name: 'in', args: ['payment_status', ['pending', 'partial', 'cancelled']] });
            expect(filterArgs(pending, 'eq')).toContainEqual(['payment_status', 'pending']);
        });

        it('ignores an unknown status value', async () => {
            supabaseAdmin.on('orders', { data: [], count: 0, error: null });

            await request(app()).get('/api/orders?status=refunded').set(storeHeader);

            expect(filterArgs(supabaseAdmin.callsFor('orders')[0], 'eq').some(([c]) => c === 'payment_status')).toBe(false);
        });

        it('filters credit sales on payment_type', async () => {
            supabaseAdmin.on('orders', { data: [], count: 0, error: null });

            await request(app()).get('/api/orders?paymentMethod=credit').set(storeHeader);

            expect(filterArgs(supabaseAdmin.callsFor('orders')[0], 'eq')).toContainEqual(['payment_type', 'credit_sale']);
        });

        it('rebuilds the query with an inner join for cash and qr, keeping the date filters', async () => {
            supabaseAdmin.on('orders', { data: [], count: 0, error: null });

            await request(app()).get('/api/orders?paymentMethod=cash&startDate=2025-01-01').set(storeHeader);
            await request(app()).get('/api/orders?paymentMethod=qr&endDate=2025-01-31').set(storeHeader);

            const [cash, qr] = supabaseAdmin.callsFor('orders');
            expect(cash.selectArgs[0]).toContain('payments!inner');
            expect(filterArgs(cash, 'eq')).toContainEqual(['payments.method', 'cash']);
            expect(filterArgs(cash, 'gte')).toContainEqual(['created_at', '2025-01-01']);

            expect(filterArgs(qr, 'eq')).toContainEqual(['payments.method', 'qr_promptpay']);
            expect(filterArgs(qr, 'lte')).toContainEqual(['created_at', '2025-01-31']);
        });

        it('keeps the status filter alongside a cash or qr payment filter', async () => {
            supabaseAdmin.on('orders', { data: [], count: 0, error: null });

            await request(app()).get('/api/orders?paymentMethod=cash&status=paid').set(storeHeader);
            await request(app()).get('/api/orders?paymentMethod=qr&status=unpaid').set(storeHeader);

            const [cash, qr] = supabaseAdmin.callsFor('orders');
            expect(filterArgs(cash, 'eq')).toContainEqual(['payments.method', 'cash']);
            expect(filterArgs(cash, 'eq')).toContainEqual(['payment_status', 'paid']);

            expect(filterArgs(qr, 'eq')).toContainEqual(['payments.method', 'qr_promptpay']);
            expect(qr.filters).toContainEqual({ name: 'in', args: ['payment_status', ['pending', 'partial', 'cancelled']] });
        });

        it('keeps sorting and pagination when a payment filter is applied', async () => {
            supabaseAdmin.on('orders', { data: [], count: 0, error: null });

            await request(app()).get('/api/orders?paymentMethod=cash&sort=highest&page=2&limit=5').set(storeHeader);

            const [call] = supabaseAdmin.callsFor('orders');
            expect(call.filters).toContainEqual({ name: 'order', args: ['total_amount', { ascending: false }] });
            expect(call.filters).toContainEqual({ name: 'range', args: [5, 9] });
        });

        it('uses the plain payments embed when no payment filter is applied', async () => {
            supabaseAdmin.on('orders', { data: [], count: 0, error: null });

            await request(app()).get('/api/orders').set(storeHeader);
            await request(app()).get('/api/orders?paymentMethod=credit').set(storeHeader);

            const [plain, credit] = supabaseAdmin.callsFor('orders');
            expect(plain.selectArgs[0]).not.toContain('payments!inner');
            expect(credit.selectArgs[0]).not.toContain('payments!inner');
        });

        it('always scopes the query to the header store', async () => {
            supabaseAdmin.on('orders', { data: [], count: 0, error: null });

            await request(app()).get('/api/orders?paymentMethod=qr').set(storeHeader);

            expect(filterArgs(supabaseAdmin.callsFor('orders')[0], 'eq')).toContainEqual(['store_id', STORE_ID]);
        });

        it('requires a store header and store access', async () => {
            expect((await request(app()).get('/api/orders')).status).toBe(400);
            expect((await request(app(denyAccess)).get('/api/orders').set(storeHeader)).status).toBe(403);
            expect(supabaseAdmin.from).not.toHaveBeenCalled();
        });

        it('returns 500 when the query fails', async () => {
            supabaseAdmin.on('orders', { data: null, error: { message: 'bad range' } });

            const res = await request(app()).get('/api/orders').set(storeHeader);

            expect(res.status).toBe(500);
            expect(res.body).toEqual({ success: false, error: 'bad range' });
        });
    });

    describe('PATCH /api/orders/:id/cancel', () => {
        it('restores stock for every order item and cancels the order', async () => {
            supabaseAdmin
                .on('order_items', { data: [{ product_id: 'p1', qty: 2 }, { product_id: 'p2', qty: 5 }], error: null })
                .on('products', (state) => (state.op === 'select' ? { data: { stock_qty: 10 }, error: null } : { data: null, error: null }))
                .on('orders', { data: null, error: null });

            const res = await request(app()).patch('/api/orders/ord-1/cancel').set(storeHeader);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ success: true });

            const updates = supabaseAdmin.callsForOp('products', 'update');
            expect(updates.map((u) => u.payload)).toEqual([{ stock_qty: 12 }, { stock_qty: 15 }]);

            const [orderUpdate] = supabaseAdmin.callsForOp('orders', 'update');
            expect(orderUpdate.payload).toEqual({ payment_status: 'cancelled' });
            expect(filterArgs(orderUpdate, 'eq')).toContainEqual(['id', 'ord-1']);
            expect(filterArgs(orderUpdate, 'eq')).toContainEqual(['store_id', STORE_ID]);
        });

        it('skips items with no linked product', async () => {
            supabaseAdmin
                .on('order_items', { data: [{ product_id: null, qty: 3 }], error: null })
                .on('orders', { data: null, error: null });

            const res = await request(app()).patch('/api/orders/ord-1/cancel').set(storeHeader);

            expect(res.status).toBe(200);
            expect(supabaseAdmin.callsFor('products')).toHaveLength(0);
        });

        it('skips a product that no longer exists', async () => {
            supabaseAdmin
                .on('order_items', { data: [{ product_id: 'gone', qty: 1 }], error: null })
                .on('products', { data: null, error: null })
                .on('orders', { data: null, error: null });

            await request(app()).patch('/api/orders/ord-1/cancel').set(storeHeader);

            expect(supabaseAdmin.callsForOp('products', 'update')).toHaveLength(0);
        });

        it('cancels an order that has no items', async () => {
            supabaseAdmin.on('order_items', { data: [], error: null }).on('orders', { data: null, error: null });

            const res = await request(app()).patch('/api/orders/ord-1/cancel').set(storeHeader);

            expect(res.status).toBe(200);
            expect(supabaseAdmin.callsForOp('orders', 'update')).toHaveLength(1);
        });

        it('requires a store header and store access', async () => {
            expect((await request(app()).patch('/api/orders/ord-1/cancel')).status).toBe(400);
            expect((await request(app(denyAccess)).patch('/api/orders/ord-1/cancel').set(storeHeader)).status).toBe(403);
            expect(supabaseAdmin.from).not.toHaveBeenCalled();
        });

        it('returns 500 when the item lookup fails, before any stock is touched', async () => {
            supabaseAdmin.on('order_items', { data: null, error: { message: 'items unavailable' } });

            const res = await request(app()).patch('/api/orders/ord-1/cancel').set(storeHeader);

            expect(res.status).toBe(500);
            expect(supabaseAdmin.callsFor('products')).toHaveLength(0);
        });

        it('returns 500 when marking the order cancelled fails', async () => {
            supabaseAdmin.on('order_items', { data: [], error: null }).on('orders', { data: null, error: { message: 'write failed' } });

            const res = await request(app()).patch('/api/orders/ord-1/cancel').set(storeHeader);

            expect(res.status).toBe(500);
            expect(res.body).toEqual({ success: false, error: 'write failed' });
        });
    });

    describe('GET /api/orders/:id', () => {
        function receiptOrder(overrides = {}) {
            return {
                order_no: 'INV-001',
                created_at: '2025-03-01T08:30:00.000Z',
                total_amount: '250.50',
                payment_type: 'cash_sale',
                payments: [{ method: 'cash', tendered_amount: '300', change_amount: '49.50' }],
                order_items: [{ qty: 2, price_per_unit: '100', unit: 'ขวด', weight: null, products: { name: 'น้ำเปล่า' } }],
                stores: { name: 'ร้านทดสอบ', address: 'กทม.', phone: '021234567' },
                ...overrides
            };
        }

        it('formats a cash receipt with tendered and change amounts', async () => {
            supabaseAdmin.on('orders', { data: receiptOrder(), error: null });

            const res = await request(app()).get('/api/orders/ord-1').set(storeHeader);

            expect(res.status).toBe(200);
            expect(res.body.data).toMatchObject({
                receiptNo: 'INV-001',
                paymentMethod: 'เงินสด',
                total: 250.5,
                received: 300,
                change: 49.5,
                store: { name: 'ร้านทดสอบ' }
            });
            expect(res.body.data.items[0]).toEqual({
                name: 'น้ำเปล่า', quantity: 2, price: '100', unit: 'ขวด', weight: null
            });
        });

        it('labels a credit sale and reports nothing received', async () => {
            supabaseAdmin.on('orders', { data: receiptOrder({ payment_type: 'credit_sale', payments: [] }), error: null });

            const res = await request(app()).get('/api/orders/ord-1').set(storeHeader);

            expect(res.body.data.paymentMethod).toBe('เครดิต (ค้างจ่าย)');
            expect(res.body.data.received).toBe(0);
            expect(res.body.data.change).toBe(0);
        });

        it('labels QR and card payments', async () => {
            supabaseAdmin
                .queue('orders',
                    { data: receiptOrder({ payments: [{ method: 'qr_promptpay', tendered_amount: null }] }), error: null },
                    { data: receiptOrder({ payments: [{ method: 'credit', tendered_amount: null }] }), error: null });

            const qr = await request(app()).get('/api/orders/ord-1').set(storeHeader);
            const card = await request(app()).get('/api/orders/ord-2').set(storeHeader);

            expect(qr.body.data.paymentMethod).toBe('สแกน QR');
            expect(card.body.data.paymentMethod).toBe('บัตรเครดิต');
        });

        it('falls back to the order total as "received" when no tendered amount was recorded', async () => {
            supabaseAdmin.on('orders', { data: receiptOrder({ payments: [{ method: 'cash', tendered_amount: null }] }), error: null });

            const res = await request(app()).get('/api/orders/ord-1').set(storeHeader);

            expect(res.body.data.received).toBe(250.5);
            expect(res.body.data.change).toBe(0);
        });

        it('treats a missing change_amount as zero', async () => {
            supabaseAdmin.on('orders', { data: receiptOrder({ payments: [{ method: 'cash', tendered_amount: '300', change_amount: null }] }), error: null });

            const res = await request(app()).get('/api/orders/ord-1').set(storeHeader);

            expect(res.body.data.change).toBe(0);
        });

        it('falls back to generic labels for items with no product or unit', async () => {
            supabaseAdmin.on('orders', {
                data: receiptOrder({ order_items: [{ qty: 1, price_per_unit: '5', products: null, unit: null, weight: null }] }),
                error: null
            });

            const res = await request(app()).get('/api/orders/ord-1').set(storeHeader);

            expect(res.body.data.items[0]).toMatchObject({ name: 'สินค้า', unit: 'ชิ้น' });
        });

        it('renders the receipt date in Bangkok time on the Buddhist calendar', async () => {
            supabaseAdmin.on('orders', { data: receiptOrder(), error: null });

            const res = await request(app()).get('/api/orders/ord-1').set(storeHeader);

            expect(res.body.data.date).toContain('2568');
            expect(res.body.data.date).toContain('15:30');
        });

        it('scopes the receipt lookup to the store', async () => {
            supabaseAdmin.on('orders', { data: receiptOrder(), error: null });

            await request(app()).get('/api/orders/ord-9').set(storeHeader);

            const [call] = supabaseAdmin.callsFor('orders');
            expect(filterArgs(call, 'eq')).toContainEqual(['id', 'ord-9']);
            expect(filterArgs(call, 'eq')).toContainEqual(['store_id', STORE_ID]);
            expect(call.terminal).toBe('single');
        });

        it('requires a store header and store access', async () => {
            expect((await request(app()).get('/api/orders/ord-1')).status).toBe(400);
            expect((await request(app(denyAccess)).get('/api/orders/ord-1').set(storeHeader)).status).toBe(403);
        });

        it('returns 500 when the order is not found for this store', async () => {
            supabaseAdmin.on('orders', { data: null, error: { message: 'No rows found' } });

            const res = await request(app()).get('/api/orders/ord-1').set(storeHeader);

            expect(res.status).toBe(500);
            expect(res.body).toEqual({ success: false, error: 'No rows found' });
        });
    });
});
