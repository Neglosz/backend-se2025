const request = require('supertest');
const { registerSalesRoutes } = require('../../routes/salesRoutes');
const { convertDateFormat } = require('../../utils/date');
const { createMockSupabase, filterArgs } = require('../helpers/mockSupabase');
const { createTestApp, allowAccess, denyAccess, STORE_ID, storeHeader } = require('../helpers/testApp');

describe('routes/salesRoutes', () => {
    let supabaseAdmin;
    let upsertNotificationGlobal;
    let errorSpy;
    let logSpy;

    beforeEach(() => {
        supabaseAdmin = createMockSupabase();
        upsertNotificationGlobal = jest.fn(async () => true);
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        errorSpy.mockRestore();
        logSpy.mockRestore();
    });

    const app = (checkStoreAccess = allowAccess) =>
        createTestApp(registerSalesRoutes, {
            supabaseAdmin, checkStoreAccess, upsertNotificationGlobal, convertDateFormat
        });

    describe('POST /api/sales', () => {
        const cashItem = { product_id: 'p1', quantity: 2, price: 25 };
        const body = { items: [cashItem], paymentMethod: 'cash', totalAmount: 50, receivedAmount: 100 };

        /**
         * Wire the tables one sale touches: the order insert/read-back, the product
         * being sold and its batches.
         */
        function withSale({ product = { stock_qty: '10', low_stock_threshold: '0', name: 'นมสด', unit_type: 'ชิ้น' }, batches = [] } = {}) {
            return supabaseAdmin
                .on('orders', { data: { id: 'ord-1', order_no: 'ORD-1' }, error: null })
                .on('products', (state) => (state.op === 'select' ? { data: product, error: null } : { data: null, error: null }))
                .on('product_batches', (state) => (state.op === 'select' ? { data: batches, error: null } : { data: null, error: null }));
        }

        it('creates a paid cash order and returns the receipt', async () => {
            withSale();

            const res = await request(app()).post('/api/sales').set(storeHeader).send(body);

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);

            const [order] = supabaseAdmin.callsForOp('orders', 'insert');
            expect(order.payload[0]).toMatchObject({
                total_amount: 50, payment_status: 'paid', payment_type: 'cash_sale', store_id: STORE_ID, synced: true
            });
            expect(order.payload[0].order_no).toMatch(/^ORD-\d{8}$/);
        });

        it('marks a credit sale pending and creates a credit account for the customer', async () => {
            withSale();

            await request(app()).post('/api/sales').set(storeHeader)
                .send({ ...body, paymentMethod: 'credit', customerId: 'c1' });

            expect(supabaseAdmin.callsForOp('orders', 'insert')[0].payload[0])
                .toMatchObject({ payment_status: 'pending', payment_type: 'credit_sale', customer_id: 'c1' });

            const [credit] = supabaseAdmin.callsForOp('credit_accounts', 'insert');
            expect(credit.payload[0]).toMatchObject({
                order_id: 'ord-1', customer_id: 'c1', total_debt: 50, paid_amount: 0, remaining_amount: 50, status: 'unpaid'
            });
            expect(supabaseAdmin.callsFor('payments')).toHaveLength(0);
        });

        it('skips the credit account when a credit sale has no customer', async () => {
            withSale();

            await request(app()).post('/api/sales').set(storeHeader).send({ ...body, paymentMethod: 'credit' });

            expect(supabaseAdmin.callsFor('credit_accounts')).toHaveLength(0);
        });

        it('records the payment with the tendered amount and the change', async () => {
            withSale();

            await request(app()).post('/api/sales').set(storeHeader).send(body);

            const [payment] = supabaseAdmin.callsForOp('payments', 'insert');
            expect(payment.payload[0]).toMatchObject({
                order_id: 'ord-1', method: 'cash', amount: 50, tendered_amount: 100, change_amount: 50
            });
        });

        it('records no change when the customer paid the exact amount', async () => {
            withSale();

            await request(app()).post('/api/sales').set(storeHeader).send({ ...body, receivedAmount: undefined });

            expect(supabaseAdmin.callsForOp('payments', 'insert')[0].payload[0])
                .toMatchObject({ tendered_amount: 50, change_amount: 0 });
        });

        it('maps a qr payment onto the promptpay method', async () => {
            withSale();

            await request(app()).post('/api/sales').set(storeHeader).send({ ...body, paymentMethod: 'qr' });

            expect(supabaseAdmin.callsForOp('payments', 'insert')[0].payload[0].method).toBe('qr_promptpay');
            expect(supabaseAdmin.callsForOp('account_transactions', 'insert')[0].payload[0].payment_method).toBe('qr_promptpay');
        });

        it('mirrors the sale into the general ledger as income', async () => {
            withSale();

            await request(app()).post('/api/sales').set(storeHeader).send(body);

            const [ledger] = supabaseAdmin.callsForOp('account_transactions', 'insert');
            expect(ledger.payload[0]).toMatchObject({
                store_id: STORE_ID, trans_type: 'income', category: 'sales', amount: 50, reference_order_id: 'ord-1'
            });
            expect(ledger.payload[0].trans_date).toBe(new Date().toISOString().split('T')[0]);
        });

        it('honours a client timestamp so offline sales keep their original time', async () => {
            withSale();
            const clientTime = '2025-03-01T04:00:00.000Z';

            await request(app()).post('/api/sales').set(storeHeader).send({ ...body, client_created_at: clientTime });

            expect(supabaseAdmin.callsForOp('orders', 'insert')[0].payload[0])
                .toMatchObject({ created_at: clientTime, client_created_at: clientTime });
        });

        it('records one order item with no batch when the product has none', async () => {
            withSale({ batches: [] });

            await request(app()).post('/api/sales').set(storeHeader).send(body);

            const items = supabaseAdmin.callsForOp('order_items', 'insert');
            expect(items).toHaveLength(1);
            expect(items[0].payload[0]).toMatchObject({
                order_id: 'ord-1', product_id: 'p1', qty: 2, unit: 'ชิ้น', price_per_unit: 25, subtotal: 50, batch_id: null
            });
        });

        it('draws down batches oldest-expiry first, splitting the order item', async () => {
            withSale({
                product: { stock_qty: '10', low_stock_threshold: '0', name: 'นมสด', unit_type: 'ชิ้น' },
                batches: [
                    { id: 'b1', remaining_qty: '1', expire_date: '2025-01-01' },
                    { id: 'b2', remaining_qty: '9', expire_date: '2025-06-01' }
                ]
            });

            await request(app()).post('/api/sales').set(storeHeader).send(body);

            const [lookup] = supabaseAdmin.callsFor('product_batches');
            expect(lookup.filters).toContainEqual({ name: 'order', args: ['expire_date', { ascending: true, nullsFirst: false }] });
            expect(filterArgs(lookup, 'gt')).toContainEqual(['remaining_qty', 0]);

            const updates = supabaseAdmin.callsForOp('product_batches', 'update');
            expect(updates.map((u) => u.payload)).toEqual([{ remaining_qty: 0 }, { remaining_qty: 8 }]);

            const items = supabaseAdmin.callsForOp('order_items', 'insert');
            expect(items.map((i) => i.payload[0].qty)).toEqual([1, 1]);
            expect(items.map((i) => i.payload[0].batch_id)).toEqual(['b1', 'b2']);
        });

        it('logs an inventory movement for each batch it draws from', async () => {
            withSale({ batches: [{ id: 'b1', remaining_qty: '10', expire_date: null }] });

            await request(app()).post('/api/sales').set(storeHeader).send(body);

            const [log] = supabaseAdmin.callsForOp('inventory_transactions', 'insert');
            expect(log.payload[0]).toMatchObject({
                product_id: 'p1', batch_id: 'b1', trans_type: 'out', qty: 2, reference_type: 'sale', reference_id: 'ord-1'
            });
        });

        it('records the unfulfilled remainder against a null batch', async () => {
            withSale({
                product: { stock_qty: '10', low_stock_threshold: '0', name: 'นมสด', unit_type: 'ชิ้น' },
                batches: [{ id: 'b1', remaining_qty: '1', expire_date: null }]
            });

            await request(app()).post('/api/sales').set(storeHeader).send(body);

            const items = supabaseAdmin.callsForOp('order_items', 'insert');
            expect(items).toHaveLength(2);
            expect(items[1].payload[0]).toMatchObject({ batch_id: null, qty: 1 });
        });

        it('converts grams sold against a kilogram-stocked product', async () => {
            withSale({
                product: { stock_qty: '5', low_stock_threshold: '0', name: 'หมูสับ', unit_type: 'kg' },
                batches: [{ id: 'b1', remaining_qty: '5', expire_date: null }]
            });

            await request(app()).post('/api/sales').set(storeHeader).send({
                ...body,
                items: [{ product_id: 'p1', quantity: 500, price: 0.2, unit_code: 'g', unit: 'กรัม', isWeight: true }]
            });

            // 500 g = 0.5 kg deducted from stock, but recorded back in grams on the receipt.
            expect(supabaseAdmin.callsForOp('product_batches', 'update')[0].payload).toEqual({ remaining_qty: 4.5 });
            expect(supabaseAdmin.callsForOp('products', 'update')[0].payload).toEqual({ stock_qty: 4.5 });

            const [item] = supabaseAdmin.callsForOp('order_items', 'insert');
            expect(item.payload[0]).toMatchObject({ qty: 500, unit: 'กรัม', weight: 500 });
        });

        it('converts the Thai unit names as well as the codes', async () => {
            withSale({
                product: { stock_qty: '5', low_stock_threshold: '0', name: 'หมูสับ', unit_type: 'กิโลกรัม' },
                batches: [{ id: 'b1', remaining_qty: '5', expire_date: null }]
            });

            await request(app()).post('/api/sales').set(storeHeader).send({
                ...body,
                items: [{ product_id: 'p1', quantity: 3, price: 20, unit_code: 'ขีด', unit: 'ขีด' }]
            });

            // 3 ขีด = 0.3 kg
            expect(supabaseAdmin.callsForOp('products', 'update')[0].payload).toEqual({ stock_qty: 4.7 });
        });

        it('refuses to sell more than the product has in stock', async () => {
            withSale({ product: { stock_qty: '1', low_stock_threshold: '0', name: 'นมสด', unit_type: 'ชิ้น' } });

            const res = await request(app()).post('/api/sales').set(storeHeader).send(body);

            expect(res.status).toBe(400);
            expect(res.body.error).toContain('สต็อกไม่เพียงพอ');
            expect(res.body.error).toContain('นมสด');
            expect(supabaseAdmin.callsFor('payments')).toHaveLength(0);
        });

        it('rejects an oversell before any order row is written', async () => {
            withSale({ product: { stock_qty: '0', low_stock_threshold: '0', name: 'นมสด', unit_type: 'ชิ้น' } });

            const res = await request(app()).post('/api/sales').set(storeHeader).send(body);

            expect(res.status).toBe(400);
            expect(supabaseAdmin.callsForOp('orders', 'insert')).toHaveLength(0);
            expect(supabaseAdmin.callsFor('order_items')).toHaveLength(0);
        });

        it('checks the whole cart up front, so a short second line writes nothing', async () => {
            let reads = 0;
            supabaseAdmin
                .on('orders', { data: { id: 'ord-1' }, error: null })
                .on('products', (state) => {
                    if (state.op !== 'select') return { data: null, error: null };
                    reads += 1;
                    return reads === 1
                        ? { data: { stock_qty: '10', low_stock_threshold: '0', name: 'พอ', unit_type: 'ชิ้น' }, error: null }
                        : { data: { stock_qty: '0', low_stock_threshold: '0', name: 'ไม่พอ', unit_type: 'ชิ้น' }, error: null };
                });

            const res = await request(app()).post('/api/sales').set(storeHeader).send({
                ...body,
                items: [{ product_id: 'p1', quantity: 1, price: 10 }, { product_id: 'p2', quantity: 1, price: 10 }]
            });

            expect(res.status).toBe(400);
            expect(res.body.error).toContain('ไม่พอ');
            expect(supabaseAdmin.callsForOp('orders', 'insert')).toHaveLength(0);
            expect(supabaseAdmin.callsForOp('products', 'update')).toHaveLength(0);
        });

        it('reads each product once, reusing the pre-flight lookup', async () => {
            withSale();

            await request(app()).post('/api/sales').set(storeHeader).send(body);

            expect(supabaseAdmin.callsFor('products').filter((c) => c.op === 'select')).toHaveLength(1);
        });

        it('raises a stock-out alert when the sale empties the shelf', async () => {
            withSale({ product: { stock_qty: '2', low_stock_threshold: '0', name: 'นมสด', unit_type: 'ชิ้น' } });

            await request(app()).post('/api/sales').set(storeHeader).send(body);

            expect(upsertNotificationGlobal).toHaveBeenCalledWith(
                STORE_ID, 'stock_out', 'สินค้าหมด', 'นมสด', 'stock', 'high', 'p1', 'product', { product_id: 'p1' }
            );
        });

        it('raises a low-stock alert when the sale crosses the threshold', async () => {
            withSale({ product: { stock_qty: '5', low_stock_threshold: '3', name: 'นมสด', unit_type: 'ชิ้น' } });

            await request(app()).post('/api/sales').set(storeHeader).send(body);

            const [args] = upsertNotificationGlobal.mock.calls;
            expect(args[1]).toBe('stock_low');
            expect(args[3]).toContain('เหลือ 3 ชิ้น');
            expect(args[5]).toBe('medium');
        });

        it('raises no alert while stock stays healthy', async () => {
            withSale({ product: { stock_qty: '100', low_stock_threshold: '3', name: 'นมสด', unit_type: 'ชิ้น' } });

            await request(app()).post('/api/sales').set(storeHeader).send(body);

            expect(upsertNotificationGlobal).not.toHaveBeenCalled();
        });

        it('carries the promotion and cost price onto the order item', async () => {
            withSale();

            await request(app()).post('/api/sales').set(storeHeader).send({
                ...body,
                items: [{ product_id: 'p1', quantity: 1, price: 25, promotion: { id: 'promo-1' }, cost_price: 12 }]
            });

            expect(supabaseAdmin.callsForOp('order_items', 'insert')[0].payload[0])
                .toMatchObject({ promotion_id: 'promo-1', cost_price_at_sale: 12 });
        });

        it('rejects an empty cart and a missing store header', async () => {
            expect((await request(app()).post('/api/sales').send(body)).status).toBe(400);

            const empty = await request(app()).post('/api/sales').set(storeHeader).send({ ...body, items: [] });
            expect(empty.status).toBe(400);
            expect(empty.body.error).toBe('No items in cart');
        });

        it('rejects a user without store access before writing anything', async () => {
            const res = await request(app(denyAccess)).post('/api/sales').set(storeHeader).send(body);

            expect(res.status).toBe(403);
            expect(supabaseAdmin.from).not.toHaveBeenCalled();
        });

        it('returns 500 when the order insert fails', async () => {
            supabaseAdmin
                .on('products', { data: { stock_qty: '10', low_stock_threshold: '0', name: 'นมสด', unit_type: 'ชิ้น' }, error: null })
                .on('orders', { data: null, error: { message: 'order failed' } });

            const res = await request(app()).post('/api/sales').set(storeHeader).send(body);

            expect(res.status).toBe(500);
            expect(res.body).toEqual({ success: false, error: 'order failed' });
        });

        it('returns 500 when the payment insert fails', async () => {
            withSale();
            supabaseAdmin.on('payments', { data: null, error: { message: 'payment failed' } });

            const res = await request(app()).post('/api/sales').set(storeHeader).send(body);

            expect(res.status).toBe(500);
            expect(res.body).toEqual({ success: false, error: 'payment failed' });
        });
    });

    describe('POST /api/credit-sales', () => {
        const body = {
            customer_name: 'สมชาย',
            customer_phone: '0812345678',
            amount: 300,
            items: []
        };

        function withCreditSale({ customer = null, order = { id: 'ord-1' } } = {}) {
            return supabaseAdmin
                .on('customers_info', (state) => (state.op === 'select'
                    ? { data: customer, error: customer ? null : { message: 'no rows' } }
                    : { data: { id: 'c-new', name: 'สมชาย' }, error: null }))
                .on('orders', { data: order, error: null })
                .on('credit_accounts', { data: { id: 'ca-1' }, error: null });
        }

        it('creates a new customer and an unpaid credit account', async () => {
            withCreditSale();

            const res = await request(app()).post('/api/credit-sales').set(storeHeader).send(body);

            expect(res.status).toBe(200);
            expect(res.body.data).toMatchObject({ customer: { id: 'c-new' }, order: { id: 'ord-1' }, credit_account: { id: 'ca-1' } });

            expect(supabaseAdmin.callsForOp('customers_info', 'insert')[0].payload[0])
                .toMatchObject({ name: 'สมชาย', phone: '0812345678', store_id: STORE_ID, image_url: null });

            expect(supabaseAdmin.callsForOp('credit_accounts', 'insert')[0].payload[0])
                .toMatchObject({ order_id: 'ord-1', customer_id: 'c-new', total_debt: 300, paid_amount: 0, remaining_amount: 300, status: 'unpaid' });
        });

        it('creates the order as a pending credit sale', async () => {
            withCreditSale();

            await request(app()).post('/api/credit-sales').set(storeHeader).send(body);

            expect(supabaseAdmin.callsForOp('orders', 'insert')[0].payload[0])
                .toMatchObject({ customer_id: 'c-new', total_amount: 300, payment_status: 'pending', payment_type: 'credit_sale', store_id: STORE_ID });
        });

        it('reuses an existing customer found by phone within the store', async () => {
            supabaseAdmin
                .on('customers_info', { data: { id: 'c-old', name: 'สมชาย' }, error: null })
                .on('orders', { data: { id: 'ord-1' }, error: null })
                .on('credit_accounts', { data: { id: 'ca-1' }, error: null });

            const res = await request(app()).post('/api/credit-sales').set(storeHeader).send(body);

            expect(res.body.data.customer.id).toBe('c-old');
            expect(supabaseAdmin.callsForOp('customers_info', 'insert')).toHaveLength(0);

            const [lookup] = supabaseAdmin.callsFor('customers_info');
            expect(filterArgs(lookup, 'eq')).toContainEqual(['phone', '0812345678']);
            expect(filterArgs(lookup, 'eq')).toContainEqual(['store_id', STORE_ID]);
        });

        it('uses the supplied customer id when one is given', async () => {
            supabaseAdmin
                .on('customers_info', { data: { id: 'c1', name: 'สมชาย', image_url: null }, error: null })
                .on('orders', { data: { id: 'ord-1' }, error: null })
                .on('credit_accounts', { data: { id: 'ca-1' }, error: null });

            const res = await request(app()).post('/api/credit-sales').set(storeHeader).send({ ...body, customer_id: 'c1' });

            expect(res.status).toBe(200);
            expect(filterArgs(supabaseAdmin.callsFor('customers_info')[0], 'eq')).toContainEqual(['id', 'c1']);
        });

        it('returns 404 when the supplied customer id does not exist', async () => {
            supabaseAdmin.on('customers_info', { data: null, error: { message: 'no rows' } });

            const res = await request(app()).post('/api/credit-sales').set(storeHeader).send({ ...body, customer_id: 'missing' });

            expect(res.status).toBe(404);
            expect(res.body).toEqual({ success: false, error: 'Customer not found' });
        });

        it('uploads a base64 customer photo and stores the public URL', async () => {
            const upload = jest.fn(async () => ({ data: { path: 'p' }, error: null }));
            supabaseAdmin.setStorage('customers', { upload });
            withCreditSale();

            await request(app()).post('/api/credit-sales').set(storeHeader)
                .send({ ...body, customer_image: 'data:image/jpeg;base64,QUJD' });

            const [path, buffer, options] = upload.mock.calls[0];
            expect(path).toMatch(new RegExp(`^${STORE_ID}/customer-\\d+\\.jpg$`));
            expect(buffer.toString()).toBe('ABC');
            expect(options).toMatchObject({ contentType: 'image/jpeg', upsert: true });
            expect(supabaseAdmin.callsForOp('customers_info', 'insert')[0].payload[0].image_url).toContain('customers');
        });

        it('stores a null photo when the upload fails, without aborting the sale', async () => {
            supabaseAdmin.setStorage('customers', { upload: async () => ({ data: null, error: { message: 'bucket full' } }) });
            withCreditSale();

            const res = await request(app()).post('/api/credit-sales').set(storeHeader)
                .send({ ...body, customer_image: 'data:image/jpeg;base64,QUJD' });

            expect(res.status).toBe(200);
            expect(supabaseAdmin.callsForOp('customers_info', 'insert')[0].payload[0].image_url).toBeNull();
        });

        it('updates an existing customer photo when a new one is supplied', async () => {
            supabaseAdmin
                .on('customers_info', (state) => (state.op === 'select'
                    ? { data: { id: 'c1', image_url: 'old.jpg' }, error: null }
                    : { data: { id: 'c1', image_url: 'https://cdn.test/new.jpg' }, error: null }))
                .on('orders', { data: { id: 'ord-1' }, error: null })
                .on('credit_accounts', { data: { id: 'ca-1' }, error: null });

            const res = await request(app()).post('/api/credit-sales').set(storeHeader)
                .send({ ...body, customer_id: 'c1', customer_image: 'https://cdn.test/new.jpg' });

            expect(supabaseAdmin.callsForOp('customers_info', 'update')[0].payload)
                .toEqual({ image_url: 'https://cdn.test/new.jpg' });
            expect(res.body.data.customer.image_url).toBe('https://cdn.test/new.jpg');
        });

        it('stores the due date on the customer, converted to SQL format', async () => {
            withCreditSale();

            await request(app()).post('/api/credit-sales').set(storeHeader).send({ ...body, due_date: '25/12/2025' });

            const [update] = supabaseAdmin.callsForOp('customers_info', 'update');
            expect(update.payload).toEqual({ due_date: '2025-12-25' });
            expect(filterArgs(update, 'eq')).toContainEqual(['id', 'c-new']);
        });

        it('keeps the sale when the due-date update fails', async () => {
            supabaseAdmin
                .on('customers_info', (state) => {
                    if (state.op === 'select') return { data: null, error: { message: 'no rows' } };
                    if (state.op === 'update') return { data: null, error: { message: 'due date failed' } };
                    return { data: { id: 'c-new' }, error: null };
                })
                .on('orders', { data: { id: 'ord-1' }, error: null })
                .on('credit_accounts', { data: { id: 'ca-1' }, error: null });

            const res = await request(app()).post('/api/credit-sales').set(storeHeader).send({ ...body, due_date: '25/12/2025' });

            expect(res.status).toBe(200);
            expect(errorSpy).toHaveBeenCalledWith('Failed to update customer due_date:', expect.anything());
        });

        it('deducts stock for the sold items', async () => {
            supabaseAdmin
                .on('customers_info', (state) => (state.op === 'select' ? { data: null, error: { message: 'x' } } : { data: { id: 'c-new' }, error: null }))
                .on('orders', { data: { id: 'ord-1' }, error: null })
                .on('credit_accounts', { data: { id: 'ca-1' }, error: null })
                .on('products', (state) => (state.op === 'select'
                    ? { data: { stock_qty: '10', low_stock_threshold: '0', name: 'นมสด', unit_type: 'ชิ้น' }, error: null }
                    : { data: null, error: null }))
                .on('product_batches', (state) => (state.op === 'select'
                    ? { data: [{ id: 'b1', remaining_qty: '10', expire_date: null }], error: null }
                    : { data: null, error: null }));

            await request(app()).post('/api/credit-sales').set(storeHeader)
                .send({ ...body, items: [{ product_id: 'p1', quantity: 3, price: 100 }] });

            expect(supabaseAdmin.callsForOp('products', 'update')[0].payload).toEqual({ stock_qty: 7 });
            expect(supabaseAdmin.callsForOp('product_batches', 'update')[0].payload).toEqual({ remaining_qty: 7 });
            expect(supabaseAdmin.callsForOp('order_items', 'insert')[0].payload[0]).toMatchObject({ qty: 3, batch_id: 'b1' });
        });

        it('refuses to oversell on a credit sale', async () => {
            supabaseAdmin
                .on('customers_info', (state) => (state.op === 'select' ? { data: null, error: { message: 'x' } } : { data: { id: 'c-new' }, error: null }))
                .on('orders', { data: { id: 'ord-1' }, error: null })
                .on('products', { data: { stock_qty: '1', name: 'นมสด', unit_type: 'ชิ้น' }, error: null });

            const res = await request(app()).post('/api/credit-sales').set(storeHeader)
                .send({ ...body, items: [{ product_id: 'p1', quantity: 5, price: 10 }] });

            expect(res.status).toBe(400);
            expect(res.body.error).toContain('สต็อกไม่เพียงพอ');
        });

        it('requires a store header', async () => {
            const res = await request(app()).post('/api/credit-sales').send(body);

            expect(res.status).toBe(400);
            expect(res.body).toEqual({ success: false, error: 'Store ID required' });
        });

        it('rejects a caller without access to the store, before writing anything', async () => {
            withCreditSale();

            const res = await request(app(denyAccess)).post('/api/credit-sales').set(storeHeader).send(body);

            expect(res.status).toBe(403);
            expect(res.body).toEqual({ success: false, error: 'Unauthorized access to store' });
            expect(supabaseAdmin.from).not.toHaveBeenCalled();
        });

        it('checks access with the header store and the authenticated user', async () => {
            const check = jest.fn(async () => true);
            withCreditSale();

            await request(app(check)).post('/api/credit-sales').set(storeHeader).send(body);

            expect(check).toHaveBeenCalledWith(STORE_ID, 'user-1');
        });

        it('rejects an oversell before creating the customer or the order', async () => {
            supabaseAdmin
                .on('products', { data: { stock_qty: '1', low_stock_threshold: '0', name: 'นมสด', unit_type: 'ชิ้น' }, error: null });

            const res = await request(app()).post('/api/credit-sales').set(storeHeader)
                .send({ ...body, items: [{ product_id: 'p1', quantity: 5, price: 10 }] });

            expect(res.status).toBe(400);
            expect(res.body.error).toContain('สต็อกไม่เพียงพอ');
            expect(supabaseAdmin.callsFor('customers_info')).toHaveLength(0);
            expect(supabaseAdmin.callsFor('orders')).toHaveLength(0);
            expect(supabaseAdmin.callsFor('credit_accounts')).toHaveLength(0);
        });

        it('returns 500 when the order or credit account insert fails', async () => {
            supabaseAdmin
                .on('customers_info', (state) => (state.op === 'select' ? { data: null, error: { message: 'x' } } : { data: { id: 'c-new' }, error: null }))
                .on('orders', { data: null, error: { message: 'order failed' } });
            expect((await request(app()).post('/api/credit-sales').set(storeHeader).send(body)).body)
                .toEqual({ success: false, error: 'order failed' });

            supabaseAdmin.reset();
            supabaseAdmin
                .on('customers_info', (state) => (state.op === 'select' ? { data: null, error: { message: 'x' } } : { data: { id: 'c-new' }, error: null }))
                .on('orders', { data: { id: 'ord-1' }, error: null })
                .on('credit_accounts', { data: null, error: { message: 'credit failed' } });
            const res = await request(app()).post('/api/credit-sales').set(storeHeader).send(body);
            expect(res.status).toBe(500);
            expect(res.body).toEqual({ success: false, error: 'credit failed' });
        });
    });
});
