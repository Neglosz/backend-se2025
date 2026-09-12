/**
 * The parts of POST /api/credit-sales the main suite does not reach: the customer
 * photo upload, and the stock deduction that runs when a credit sale carries items.
 *
 * Both matter because they are the paths where a credit sale can silently lose data —
 * a photo that never uploads, or goods that leave the shelf without an order line.
 */
const request = require('supertest');
const { registerSalesRoutes } = require('../../routes/salesRoutes');
const { convertDateFormat } = require('../../utils/date');
const { createMockSupabase, filterArgs } = require('../helpers/mockSupabase');
const { createTestApp, allowAccess, STORE_ID, storeHeader } = require('../helpers/testApp');

const PNG_1PX = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

describe('routes/salesRoutes credit sales with items and photos', () => {
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

    const app = () => createTestApp(registerSalesRoutes, {
        supabaseAdmin, checkStoreAccess: allowAccess, upsertNotificationGlobal, convertDateFormat
    });

    const post = (body) => request(app()).post('/api/credit-sales').set(storeHeader).send(body);

    /** The order line written for one item, whichever branch produced it. */
    const orderItems = () => supabaseAdmin.callsForOp('order_items', 'insert').map((c) => c.payload[0]);

    describe('the customer photo', () => {
        /** An existing customer, so the update-with-photo branch runs. */
        function withExistingCustomer() {
            supabaseAdmin
                .on('customers_info', (state) => (state.op === 'select'
                    ? { data: { id: 'c1', name: 'สมชาย', image_url: null }, error: null }
                    : { data: { id: 'c1', name: 'สมชาย', image_url: 'https://cdn.test/new.jpg' }, error: null }))
                .on('orders', { data: { id: 'ord-1' }, error: null })
                .on('credit_accounts', { data: { id: 'ca-1' }, error: null });
        }

        const withPhoto = { customer_id: 'c1', customer_name: 'สมชาย', amount: 300, items: [], customer_image: PNG_1PX };

        it('uploads a base64 photo and stores the public url against the customer', async () => {
            withExistingCustomer();

            const res = await post(withPhoto);

            expect(res.status).toBe(200);
            const [upload] = supabaseAdmin.callsForOp('customers_info', 'update');
            expect(upload.payload.image_url).toMatch(/^https:\/\/cdn\.test\//);
            expect(supabaseAdmin.storage.from).toHaveBeenCalledWith('customers');
        });

        it('names the uploaded file under the store\'s own folder', async () => {
            const upload = jest.fn(async () => ({ data: { path: 'x' }, error: null }));
            supabaseAdmin.setStorage('customers', { upload });
            withExistingCustomer();

            await post(withPhoto);

            const [fileName, buffer, options] = upload.mock.calls[0];
            expect(fileName.startsWith(`${STORE_ID}/customer-`)).toBe(true);
            expect(Buffer.isBuffer(buffer)).toBe(true);
            expect(options).toMatchObject({ contentType: 'image/jpeg', upsert: true });
        });

        it('never writes a megabyte of base64 to the row when the upload fails', async () => {
            supabaseAdmin.setStorage('customers', {
                upload: async () => ({ data: null, error: { message: 'bucket full' } })
            });
            withExistingCustomer();

            const res = await post(withPhoto);

            expect(res.status).toBe(200);
            // The url resolves to null, so the update is skipped and the customer keeps
            // whatever photo they already had rather than gaining a broken one.
            expect(supabaseAdmin.callsForOp('customers_info', 'update')).toHaveLength(0);
            expect(errorSpy).toHaveBeenCalledWith('Customer Image Upload Error:', expect.anything());
        });

        it('leaves the sale standing when the photo cannot be attached to the customer', async () => {
            supabaseAdmin
                .on('customers_info', (state) => (state.op === 'select'
                    ? { data: { id: 'c1', name: 'สมชาย', image_url: null }, error: null }
                    : { data: null, error: { message: 'row locked' } }))
                .on('orders', { data: { id: 'ord-1' }, error: null })
                .on('credit_accounts', { data: { id: 'ca-1' }, error: null });

            const res = await post(withPhoto);

            expect(res.status).toBe(200);
            expect(res.body.data.customer.id).toBe('c1');
            expect(errorSpy).toHaveBeenCalledWith('Update customer image error:', expect.anything());
        });

        it('does not upload a photo that is already a url', async () => {
            const upload = jest.fn();
            supabaseAdmin.setStorage('customers', { upload });
            withExistingCustomer();

            await post({ ...withPhoto, customer_image: 'https://cdn.test/existing.jpg' });

            expect(upload).not.toHaveBeenCalled();
        });

        it('uploads a photo for a customer being created for the first time', async () => {
            supabaseAdmin
                .on('customers_info', (state) => (state.op === 'select'
                    ? { data: null, error: { message: 'no rows' } }
                    : { data: { id: 'c-new', name: 'สมชาย' }, error: null }))
                .on('orders', { data: { id: 'ord-1' }, error: null })
                .on('credit_accounts', { data: { id: 'ca-1' }, error: null });

            const res = await post({
                customer_name: 'สมชาย', customer_phone: '0812345678', amount: 300, items: [], customer_image: PNG_1PX
            });

            expect(res.status).toBe(200);
            expect(supabaseAdmin.callsForOp('customers_info', 'insert')[0].payload[0].image_url)
                .toMatch(/^https:\/\/cdn\.test\//);
        });

        it('creates the customer with no photo when their upload fails', async () => {
            supabaseAdmin.setStorage('customers', {
                upload: async () => ({ data: null, error: { message: 'bucket full' } })
            });
            supabaseAdmin
                .on('customers_info', (state) => (state.op === 'select'
                    ? { data: null, error: { message: 'no rows' } }
                    : { data: { id: 'c-new' }, error: null }))
                .on('orders', { data: { id: 'ord-1' }, error: null })
                .on('credit_accounts', { data: { id: 'ca-1' }, error: null });

            const res = await post({
                customer_name: 'สมชาย', customer_phone: '0812345678', amount: 300, items: [], customer_image: PNG_1PX
            });

            expect(res.status).toBe(200);
            expect(supabaseAdmin.callsForOp('customers_info', 'insert')[0].payload[0].image_url).toBeNull();
            expect(errorSpy).toHaveBeenCalledWith('New Customer Image Upload Error:', expect.anything());
        });

        it('reports a failure to create the customer instead of a half-made sale', async () => {
            supabaseAdmin
                .on('customers_info', (state) => (state.op === 'select'
                    ? { data: null, error: { message: 'no rows' } }
                    : { data: null, error: { message: 'duplicate phone' } }))
                .on('orders', { data: { id: 'ord-1' }, error: null });

            const res = await post({ customer_name: 'สมชาย', customer_phone: '0812345678', amount: 300, items: [] });

            expect(res.status).toBe(500);
            expect(supabaseAdmin.callsForOp('orders', 'insert')).toHaveLength(0);
        });
    });

    describe('deducting stock for the items on a credit sale', () => {
        const item = (over = {}) => ({ product_id: 'p1', quantity: 3, price: 25, unit: 'ชิ้น', ...over });

        /** One product with the given batches; the customer already exists. */
        function withItems({ product = { id: 'p1', stock_qty: '10', unit_type: 'ชิ้น', name: 'นมสด', low_stock_threshold: '0' }, batches = [] } = {}) {
            supabaseAdmin
                .on('customers_info', { data: { id: 'c1', name: 'สมชาย', image_url: null }, error: null })
                .on('orders', { data: { id: 'ord-1' }, error: null })
                .on('credit_accounts', { data: { id: 'ca-1' }, error: null })
                .on('products', (state) => (state.op === 'select' ? { data: product, error: null } : { data: null, error: null }))
                .on('product_batches', (state) => (state.op === 'select' ? { data: batches, error: null } : { data: null, error: null }));
        }

        const body = (items) => ({ customer_id: 'c1', customer_name: 'สมชาย', amount: 75, items });

        it('records an order line with no batch when the product is not batch-tracked', async () => {
            withItems();

            const res = await post(body([item()]));

            expect(res.status).toBe(200);
            expect(orderItems()).toEqual([expect.objectContaining({
                order_id: 'ord-1', product_id: 'p1', qty: 3, unit: 'ชิ้น',
                price_per_unit: 25, subtotal: 75, batch_id: null
            })]);
        });

        it('draws down the oldest batch first and logs the movement', async () => {
            withItems({ batches: [{ id: 'b1', remaining_qty: '10', expire_date: '2026-01-01' }] });

            const res = await post(body([item()]));

            expect(res.status).toBe(200);
            const [batchUpdate] = supabaseAdmin.callsForOp('product_batches', 'update');
            expect(batchUpdate.payload).toEqual({ remaining_qty: 7 });
            expect(filterArgs(batchUpdate, 'eq')).toContainEqual(['id', 'b1']);

            const [log] = supabaseAdmin.callsForOp('inventory_transactions', 'insert');
            expect(log.payload[0]).toMatchObject({
                product_id: 'p1', batch_id: 'b1', trans_type: 'out', qty: 3,
                reference_type: 'sale', reference_id: 'ord-1'
            });
            expect(log.payload[0].notes).toContain('Credit Sale:');

            expect(orderItems()).toEqual([expect.objectContaining({ batch_id: 'b1', qty: 3, subtotal: 75 })]);
        });

        it('splits one item across two batches when the first cannot cover it', async () => {
            withItems({
                batches: [
                    { id: 'b1', remaining_qty: '2', expire_date: '2026-01-01' },
                    { id: 'b2', remaining_qty: '5', expire_date: '2026-06-01' }
                ]
            });

            const res = await post(body([item()]));

            expect(res.status).toBe(200);
            expect(orderItems()).toEqual([
                expect.objectContaining({ batch_id: 'b1', qty: 2, subtotal: 50 }),
                expect.objectContaining({ batch_id: 'b2', qty: 1, subtotal: 25 })
            ]);
            expect(supabaseAdmin.callsForOp('product_batches', 'update').map((c) => c.payload))
                .toEqual([{ remaining_qty: 0 }, { remaining_qty: 4 }]);
        });

        it('stops drawing batches down once the quantity is covered', async () => {
            withItems({
                batches: [
                    { id: 'b1', remaining_qty: '10', expire_date: '2026-01-01' },
                    { id: 'b2', remaining_qty: '10', expire_date: '2026-06-01' }
                ]
            });

            await post(body([item()]));

            expect(supabaseAdmin.callsForOp('product_batches', 'update')).toHaveLength(1);
        });

        it('records the shortfall as a batchless line rather than losing it', async () => {
            // The pre-flight check allows this when stock_qty still covers the sale but
            // the batches do not. The goods left the shelf either way, so the order must
            // account for all of them.
            withItems({ batches: [{ id: 'b1', remaining_qty: '1', expire_date: '2026-01-01' }] });

            const res = await post(body([item()]));

            expect(res.status).toBe(200);
            expect(orderItems()).toEqual([
                expect.objectContaining({ batch_id: 'b1', qty: 1, subtotal: 25 }),
                expect.objectContaining({ batch_id: null, qty: 2, subtotal: 50 })
            ]);
        });

        it('lowers the product\'s stock by the full quantity sold', async () => {
            withItems({ batches: [{ id: 'b1', remaining_qty: '10', expire_date: '2026-01-01' }] });

            await post(body([item()]));

            const [stockUpdate] = supabaseAdmin.callsForOp('products', 'update');
            expect(stockUpdate.payload).toEqual({ stock_qty: 7 });
            expect(filterArgs(stockUpdate, 'eq')).toContainEqual(['id', 'p1']);
        });

        it('reads batches oldest-first, skipping the empty ones', async () => {
            withItems({ batches: [{ id: 'b1', remaining_qty: '10', expire_date: '2026-01-01' }] });

            await post(body([item()]));

            const [read] = supabaseAdmin.callsForOp('product_batches', 'select');
            expect(filterArgs(read, 'gt')).toContainEqual(['remaining_qty', 0]);
            expect(filterArgs(read, 'order')).toContainEqual(['expire_date', { ascending: true, nullsFirst: false }]);
        });

        it('carries the promotion and the cost captured at sale onto the line', async () => {
            withItems({ batches: [{ id: 'b1', remaining_qty: '10', expire_date: '2026-01-01' }] });

            await post(body([item({ promotion: { id: 'promo-1' }, cost_price: 12 })]));

            expect(orderItems()[0]).toMatchObject({ promotion_id: 'promo-1', cost_price_at_sale: 12 });
        });

        it('records the weight on a line sold by weight', async () => {
            withItems({
                product: { id: 'p1', stock_qty: '10', unit_type: 'กก.', name: 'หมูสับ', low_stock_threshold: '0' },
                batches: [{ id: 'b1', remaining_qty: '10', expire_date: '2026-01-01' }]
            });

            await post(body([item({ isWeight: true, quantity: 2, unit: 'กก.' })]));

            expect(orderItems()[0].weight).toBe(2);
        });

        it('leaves the weight null on a line sold by the piece', async () => {
            withItems({ batches: [{ id: 'b1', remaining_qty: '10', expire_date: '2026-01-01' }] });

            await post(body([item()]));

            expect(orderItems()[0].weight).toBeNull();
        });

        it('refuses the sale when a product does not have the stock', async () => {
            withItems({ product: { id: 'p1', stock_qty: '1', unit_type: 'ชิ้น', name: 'นมสด', low_stock_threshold: '0' } });

            const res = await post(body([item()]));

            expect(res.status).toBe(400);
            expect(supabaseAdmin.callsForOp('orders', 'insert')).toHaveLength(0);
            expect(orderItems()).toHaveLength(0);
        });
    });
});
