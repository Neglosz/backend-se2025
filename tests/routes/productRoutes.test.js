const request = require('supertest');
const { registerProductRoutes } = require('../../routes/productRoutes');
const { categoryValidators } = require('../../middleware/validators');
const { convertDateFormat } = require('../../utils/date');
const { createMockSupabase, filterArgs } = require('../helpers/mockSupabase');
const { createTestApp, allowAccess, denyAccess, STORE_ID, storeHeader } = require('../helpers/testApp');

describe('routes/productRoutes', () => {
    let supabaseAdmin;
    let deleteNotificationGlobal;
    let errorSpy;
    let logSpy;

    beforeEach(() => {
        supabaseAdmin = createMockSupabase();
        deleteNotificationGlobal = jest.fn(async () => true);
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        errorSpy.mockRestore();
        logSpy.mockRestore();
    });

    const app = (checkStoreAccess = allowAccess, validators = categoryValidators) =>
        createTestApp(registerProductRoutes, {
            supabaseAdmin,
            categoryValidators: validators,
            checkStoreAccess,
            convertDateFormat,
            deleteNotificationGlobal
        });

    describe('GET /api/products', () => {
        const product = { id: 'p1', name: 'นมสด', price: 20, is_weightable: false };

        it('returns the store products with pagination echoed back', async () => {
            supabaseAdmin.on('products', { data: [product], error: null }).on('promotion_items', { data: [], error: null });

            const res = await request(app()).get('/api/products').set(storeHeader);

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ success: true, page: 1, limit: 20 });
            expect(res.body.data[0]).toMatchObject({ id: 'p1', name: 'นมสด' });
        });

        it('lists non-weighted products by default, sorted by name', async () => {
            supabaseAdmin.on('products', { data: [], error: null });

            await request(app()).get('/api/products').set(storeHeader);

            const [call] = supabaseAdmin.callsFor('products');
            expect(filterArgs(call, 'eq')).toContainEqual(['is_weightable', false]);
            expect(filterArgs(call, 'eq')).toContainEqual(['store_id', STORE_ID]);
            expect(call.filters).toContainEqual({ name: 'is', args: ['deleted_at', null] });
            expect(call.filters).toContainEqual({ name: 'order', args: ['name', { ascending: true }] });
        });

        it('switches to weighted products, or drops the filter for type=all', async () => {
            supabaseAdmin.on('products', { data: [], error: null });

            await request(app()).get('/api/products?type=weight').set(storeHeader);
            await request(app()).get('/api/products?type=all').set(storeHeader);

            const [weight, all] = supabaseAdmin.callsFor('products');
            expect(filterArgs(weight, 'eq')).toContainEqual(['is_weightable', true]);
            expect(filterArgs(all, 'eq').some(([col]) => col === 'is_weightable')).toBe(false);
        });

        it('filters by category and searches name or barcode', async () => {
            supabaseAdmin.on('products', { data: [], error: null });

            await request(app()).get('/api/products?categoryId=cat-1&search=นม').set(storeHeader);

            const [call] = supabaseAdmin.callsFor('products');
            expect(filterArgs(call, 'eq')).toContainEqual(['category_id', 'cat-1']);
            expect(call.filters).toContainEqual({ name: 'or', args: ['name.ilike.%นม%,barcode.ilike.%นม%'] });
        });

        it('paginates with range, applied last', async () => {
            supabaseAdmin.on('products', { data: [], error: null });

            await request(app()).get('/api/products?page=2&limit=5').set(storeHeader);

            const [call] = supabaseAdmin.callsFor('products');
            expect(call.filters).toContainEqual({ name: 'range', args: [5, 9] });
            expect(call.filters.at(-1)).toEqual({ name: 'range', args: [5, 9] });
        });

        it('applies a percentage promotion to the listed price', async () => {
            supabaseAdmin
                .on('products', { data: [{ ...product, price: 100 }], error: null })
                .on('promotion_items', { data: [{ product_id: 'p1', promotions: { id: 'promo-1', name: 'ลด 20%', type: 'discount_percent', discount_value: '20' } }], error: null });

            const res = await request(app()).get('/api/products').set(storeHeader);

            expect(res.body.data[0]).toMatchObject({
                price: 80, original_price: 100, is_promotion: true, discount_percent: 20
            });
            expect(res.body.data[0].promotion).toMatchObject({ id: 'promo-1', type: 'discount_percent' });
        });

        it('applies a fixed-amount promotion and never goes below zero', async () => {
            supabaseAdmin
                .on('products', { data: [{ ...product, price: 8 }], error: null })
                .on('promotion_items', { data: [{ product_id: 'p1', promotions: { id: 'x', type: 'discount_amount', discount_value: '20' } }], error: null });

            const res = await request(app()).get('/api/products').set(storeHeader);

            expect(res.body.data[0].price).toBe(0);
        });

        it('leaves the price untouched for buy_x_get_y and bundle promotions', async () => {
            supabaseAdmin
                .on('products', { data: [{ id: 'p1', price: 50 }, { id: 'p2', price: 60 }], error: null })
                .on('promotion_items', {
                    data: [
                        { product_id: 'p1', promotions: { id: 'a', type: 'buy_x_get_y', min_qty_required: 2, free_qty: 1 } },
                        { product_id: 'p2', promotions: { id: 'b', type: 'bundle', min_spend: 100 } }
                    ],
                    error: null
                });

            const res = await request(app()).get('/api/products').set(storeHeader);

            expect(res.body.data[0]).toMatchObject({ price: 50, is_promotion: true });
            expect(res.body.data[1]).toMatchObject({ price: 60, is_promotion: true });
            expect(res.body.data[0].promotion).toMatchObject({ min_qty: 2, free_qty: 1 });
        });

        it('marks products without a promotion explicitly', async () => {
            supabaseAdmin.on('products', { data: [{ ...product, price: 20 }], error: null }).on('promotion_items', { data: [], error: null });

            const res = await request(app()).get('/api/products').set(storeHeader);

            expect(res.body.data[0]).toMatchObject({ is_promotion: false, discount_percent: 0, original_price: 20 });
        });

        it('skips the promotion lookup when no products matched', async () => {
            supabaseAdmin.on('products', { data: [], error: null });

            await request(app()).get('/api/products').set(storeHeader);

            expect(supabaseAdmin.callsFor('promotion_items')).toHaveLength(0);
        });

        it('requires a store header and store access', async () => {
            expect((await request(app()).get('/api/products')).status).toBe(400);
            expect((await request(app(denyAccess)).get('/api/products').set(storeHeader)).status).toBe(403);
            expect(supabaseAdmin.from).not.toHaveBeenCalled();
        });

        it('returns 500 when the product query fails', async () => {
            supabaseAdmin.on('products', { data: null, error: { message: 'bad range' } });

            const res = await request(app()).get('/api/products').set(storeHeader);

            expect(res.status).toBe(500);
            expect(res.body).toEqual({ success: false, error: 'bad range' });
        });
    });

    describe('GET /api/products/barcode/:barcode', () => {
        const found = { id: 'p1', name: 'นมสด', price: 100, barcode: '8850001' };

        it('returns the product with its batches and no promotion', async () => {
            supabaseAdmin
                .on('products', { data: found, error: null })
                .on('product_batches', { data: [{ id: 'b1' }], error: null })
                .on('promotion_items', { data: [], error: null });

            const res = await request(app()).get('/api/products/barcode/8850001').set(storeHeader);

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ success: true, exists: true });
            expect(res.body.data).toMatchObject({
                id: 'p1', price: 100, original_price: 100, discount_percent: 0, is_promotion: false, promotion: null
            });
            expect(res.body.data.batches).toEqual([{ id: 'b1' }]);
        });

        it('reports a clean miss (exists:false) for an unknown barcode', async () => {
            supabaseAdmin.on('products', { data: null, error: { code: 'PGRST116', message: 'no rows' } });

            const res = await request(app()).get('/api/products/barcode/nope').set(storeHeader);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ success: true, exists: false, data: null });
        });

        it('scopes the lookup to the store and skips soft-deleted products', async () => {
            supabaseAdmin.on('products', { data: found, error: null }).on('promotion_items', { data: [], error: null });

            await request(app()).get('/api/products/barcode/8850001').set(storeHeader);

            const [call] = supabaseAdmin.callsFor('products');
            expect(filterArgs(call, 'eq')).toContainEqual(['barcode', '8850001']);
            expect(filterArgs(call, 'eq')).toContainEqual(['store_id', STORE_ID]);
            expect(call.filters).toContainEqual({ name: 'is', args: ['deleted_at', null] });
        });

        it('sorts the batches by expiry, soonest first', async () => {
            supabaseAdmin.on('products', { data: found, error: null }).on('promotion_items', { data: [], error: null });

            await request(app()).get('/api/products/barcode/8850001').set(storeHeader);

            expect(supabaseAdmin.callsFor('product_batches')[0].filters)
                .toContainEqual({ name: 'order', args: ['expire_date', { ascending: true }] });
        });

        it('discounts the price when an active percentage promotion exists', async () => {
            supabaseAdmin
                .on('products', { data: found, error: null })
                .on('product_batches', { data: [], error: null })
                .on('promotion_items', { data: [{ promotions: { id: 'promo-1', name: 'ลด 25%', type: 'discount_percent', discount_value: '25' } }], error: null });

            const res = await request(app()).get('/api/products/barcode/8850001').set(storeHeader);

            expect(res.body.data).toMatchObject({ price: 75, original_price: 100, discount_percent: 25, is_promotion: true });
        });

        it('applies a fixed-amount promotion with a zero floor', async () => {
            supabaseAdmin
                .on('products', { data: { ...found, price: 10 }, error: null })
                .on('product_batches', { data: [], error: null })
                .on('promotion_items', { data: [{ promotions: { id: 'x', type: 'discount_amount', discount_value: '30' } }], error: null });

            const res = await request(app()).get('/api/products/barcode/8850001').set(storeHeader);

            expect(res.body.data.price).toBe(0);
        });

        it('requires a store header and store access', async () => {
            expect((await request(app()).get('/api/products/barcode/1')).status).toBe(400);
            expect((await request(app(denyAccess)).get('/api/products/barcode/1').set(storeHeader)).status).toBe(403);
        });

        it('returns 500 for any other lookup error', async () => {
            supabaseAdmin.on('products', { data: null, error: { code: 'PGRST500', message: 'boom' } });

            const res = await request(app()).get('/api/products/barcode/1').set(storeHeader);

            expect(res.status).toBe(500);
        });
    });

    describe('GET /api/products/:id', () => {
        it('returns one product scoped to the store', async () => {
            supabaseAdmin.on('products', { data: { id: 'p1', name: 'นมสด' }, error: null });

            const res = await request(app()).get('/api/products/p1').set(storeHeader);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ success: true, data: { id: 'p1', name: 'นมสด' } });

            const [call] = supabaseAdmin.callsFor('products');
            expect(filterArgs(call, 'eq')).toContainEqual(['id', 'p1']);
            expect(filterArgs(call, 'eq')).toContainEqual(['store_id', STORE_ID]);
        });

        it('calls checkStoreAccess with (storeId, userId), like every other route', async () => {
            const check = jest.fn(async () => true);
            supabaseAdmin.on('products', { data: { id: 'p1' }, error: null });

            await request(app(check)).get('/api/products/p1').set(storeHeader);

            expect(check).toHaveBeenCalledWith(STORE_ID, 'user-1');
        });

        it('returns 400 with its own wording when the store header is missing', async () => {
            const res = await request(app()).get('/api/products/p1');

            expect(res.status).toBe(400);
            expect(res.body).toEqual({ success: false, error: 'Missing store ID' });
        });

        it('returns 403 when access is denied', async () => {
            expect((await request(app(denyAccess)).get('/api/products/p1').set(storeHeader)).status).toBe(403);
        });

        it('returns 404 when the product is missing or the query errored', async () => {
            supabaseAdmin.on('products', { data: null, error: null });
            expect((await request(app()).get('/api/products/p1').set(storeHeader)).status).toBe(404);

            supabaseAdmin.on('products', { data: null, error: { message: 'no rows' } });
            const res = await request(app()).get('/api/products/p1').set(storeHeader);
            expect(res.status).toBe(404);
            expect(res.body).toEqual({ success: false, error: 'Product not found' });
        });
    });

    describe('POST /api/products/:id/add-batch', () => {
        /**
         * The handler now reads the product twice: an ownership probe first, then the
         * stock/price row. Both come from the same `products` handler.
         */
        function withProduct(product = { stock_qty: '10', cost_price: '5', price: '12', low_stock_threshold: '2' }, owned = { id: 'p1' }) {
            let reads = 0;
            return supabaseAdmin
                .on('product_batches', { data: { id: 'b1', batch_no: 'LOT-1' }, error: null })
                .on('products', (state) => {
                    if (state.op !== 'select') return { data: null, error: null };
                    reads += 1;
                    return reads === 1 ? { data: owned, error: null } : { data: product, error: null };
                });
        }

        it('creates a batch and accumulates the product stock', async () => {
            withProduct();

            const res = await request(app()).post('/api/products/p1/add-batch').set(storeHeader).send({ quantity: 5 });

            expect(res.status).toBe(200);
            expect(res.body.data).toMatchObject({ newStockQty: 15, addedQty: 5, newSalePrice: '12' });

            const [batch] = supabaseAdmin.callsForOp('product_batches', 'insert');
            expect(batch.payload[0]).toMatchObject({ product_id: 'p1', qty: 5, remaining_qty: 5, expire_date: null });
            expect(batch.payload[0].batch_no).toMatch(/^LOT-\d+$/);

            expect(supabaseAdmin.callsForOp('products', 'update')[0].payload).toEqual({ stock_qty: 15 });
        });

        it('converts a DD/MM/YYYY expiry into an SQL date', async () => {
            withProduct();

            await request(app()).post('/api/products/p1/add-batch').set(storeHeader).send({ quantity: 1, expireDate: '25/12/2025' });

            expect(supabaseAdmin.callsForOp('product_batches', 'insert')[0].payload[0].expire_date).toBe('2025-12-25');
        });

        it('updates the cost and sale price only when a positive value is given', async () => {
            withProduct();

            await request(app()).post('/api/products/p1/add-batch').set(storeHeader)
                .send({ quantity: 1, costPrice: 7, salePrice: 15 });

            expect(supabaseAdmin.callsForOp('products', 'update')[0].payload)
                .toEqual({ stock_qty: 11, cost_price: 7, price: 15 });

            supabaseAdmin.reset();
            withProduct();
            await request(app()).post('/api/products/p1/add-batch').set(storeHeader)
                .send({ quantity: 1, costPrice: 0, salePrice: 0 });

            expect(supabaseAdmin.callsForOp('products', 'update')[0].payload).toEqual({ stock_qty: 11 });
        });

        it('clears the stock alerts for that product once stock arrives', async () => {
            withProduct();

            await request(app()).post('/api/products/p1/add-batch').set(storeHeader).send({ quantity: 5 });

            expect(deleteNotificationGlobal).toHaveBeenCalledWith(STORE_ID, ['stock_out', 'stock_low'], 'p1', 'product');
        });

        it('requires a store header', async () => {
            withProduct();

            const res = await request(app()).post('/api/products/p1/add-batch').send({ quantity: 5 });

            expect(res.status).toBe(400);
            expect(res.body).toEqual({ success: false, error: 'Store ID required' });
            expect(deleteNotificationGlobal).not.toHaveBeenCalled();
        });

        it('rejects a non-positive quantity before touching the database', async () => {
            for (const quantity of [0, -3, 'abc', undefined]) {
                // eslint-disable-next-line no-await-in-loop
                const res = await request(app()).post('/api/products/p1/add-batch').set(storeHeader).send({ quantity });
                expect(res.status).toBe(400);
                expect(res.body.error).toBe('กรุณากรอกจำนวนสินค้า');
            }
            expect(supabaseAdmin.from).not.toHaveBeenCalled();
        });

        it('rejects a caller without access to the store', async () => {
            withProduct();

            const res = await request(app(denyAccess)).post('/api/products/p1/add-batch').set(storeHeader).send({ quantity: 1 });

            expect(res.status).toBe(403);
            expect(res.body).toEqual({ success: false, error: 'Unauthorized access to store' });
            expect(supabaseAdmin.callsFor('product_batches')).toHaveLength(0);
        });

        it('returns 404 when the product belongs to another store', async () => {
            withProduct(undefined, null);

            const res = await request(app()).post('/api/products/p1/add-batch').set(storeHeader).send({ quantity: 1 });

            expect(res.status).toBe(404);
            expect(res.body).toEqual({ success: false, error: 'ไม่พบสินค้าในร้านนี้' });
            expect(supabaseAdmin.callsFor('product_batches')).toHaveLength(0);
        });

        it('verifies ownership with a store-scoped lookup that skips soft-deleted rows', async () => {
            withProduct();

            await request(app()).post('/api/products/p1/add-batch').set(storeHeader).send({ quantity: 1 });

            const [probe] = supabaseAdmin.callsFor('products');
            expect(filterArgs(probe, 'eq')).toContainEqual(['id', 'p1']);
            expect(filterArgs(probe, 'eq')).toContainEqual(['store_id', STORE_ID]);
            expect(probe.filters).toContainEqual({ name: 'is', args: ['deleted_at', null] });
        });

        it('scopes the stock update to the store as well as the product', async () => {
            withProduct();

            await request(app()).post('/api/products/p1/add-batch').set(storeHeader).send({ quantity: 1 });

            expect(filterArgs(supabaseAdmin.callsForOp('products', 'update')[0], 'eq'))
                .toContainEqual(['store_id', STORE_ID]);
        });

        it('returns 500 when the batch or product lookup fails', async () => {
            supabaseAdmin
                .on('products', { data: { id: 'p1' }, error: null })
                .on('product_batches', { data: null, error: { message: 'batch failed' } });
            expect((await request(app()).post('/api/products/p1/add-batch').set(storeHeader).send({ quantity: 1 })).status).toBe(500);

            supabaseAdmin.reset();
            let reads = 0;
            supabaseAdmin
                .on('product_batches', { data: { id: 'b1' }, error: null })
                .on('products', (state) => {
                    if (state.op !== 'select') return { data: null, error: null };
                    reads += 1;
                    return reads === 1
                        ? { data: { id: 'p1' }, error: null }
                        : { data: null, error: { message: 'product gone' } };
                });
            const res = await request(app()).post('/api/products/p1/add-batch').set(storeHeader).send({ quantity: 1 });
            expect(res.body).toEqual({ success: false, error: 'product gone' });
        });
    });

    describe('GET /api/product-categories', () => {
        it('returns the store categories sorted by name', async () => {
            supabaseAdmin.on('product_categories', { data: [{ id: 'c1', name: 'เครื่องดื่ม' }], error: null });

            const res = await request(app()).get('/api/product-categories').set(storeHeader);

            expect(res.status).toBe(200);
            expect(res.body.data).toEqual([{ id: 'c1', name: 'เครื่องดื่ม' }]);

            const [call] = supabaseAdmin.callsFor('product_categories');
            expect(call.filters).toContainEqual({ name: 'order', args: ['name'] });
            expect(filterArgs(call, 'eq')).toContainEqual(['store_id', STORE_ID]);
        });

        it('requires a store header and store access, and reports query failures', async () => {
            expect((await request(app()).get('/api/product-categories')).status).toBe(400);
            expect((await request(app(denyAccess)).get('/api/product-categories').set(storeHeader)).status).toBe(403);

            supabaseAdmin.on('product_categories', { data: null, error: { message: 'down' } });
            expect((await request(app()).get('/api/product-categories').set(storeHeader)).status).toBe(500);
        });
    });

    describe('POST /api/product-categories', () => {
        it('creates a trimmed category for the store', async () => {
            supabaseAdmin.on('product_categories', { data: { id: 'c1', name: 'ขนม' }, error: null });

            const res = await request(app()).post('/api/product-categories').set(storeHeader).send({ name: '  ขนม  ' });

            expect(res.status).toBe(200);
            expect(supabaseAdmin.callsForOp('product_categories', 'insert')[0].payload)
                .toEqual([{ name: 'ขนม', store_id: STORE_ID }]);
        });

        it('runs the category validators first', async () => {
            const res = await request(app()).post('/api/product-categories').set(storeHeader).send({ name: 'bad!name' });

            expect(res.status).toBe(400);
            expect(res.body.error).toBe('Validation Error');
            expect(supabaseAdmin.from).not.toHaveBeenCalled();
        });

        it('requires a store header and store access', async () => {
            const noValidators = [];
            expect((await request(app(allowAccess, noValidators)).post('/api/product-categories').send({ name: 'x' })).status).toBe(400);
            expect((await request(app(denyAccess, noValidators)).post('/api/product-categories').set(storeHeader).send({ name: 'x' })).status).toBe(403);
        });

        it('rejects a blank name even when the validators are bypassed', async () => {
            const res = await request(app(allowAccess, [])).post('/api/product-categories').set(storeHeader).send({ name: '   ' });

            expect(res.status).toBe(400);
            expect(res.body.error).toBe('Category name is required');
        });

        it('returns 500 when the insert fails', async () => {
            supabaseAdmin.on('product_categories', { data: null, error: { message: 'duplicate' } });

            const res = await request(app()).post('/api/product-categories').set(storeHeader).send({ name: 'ขนม' });

            expect(res.status).toBe(500);
        });
    });

    describe('PUT /api/product-categories/:id', () => {
        it('renames the category, scoped to the store', async () => {
            supabaseAdmin.on('product_categories', { data: { id: 'c1', name: 'ของใช้' }, error: null });

            const res = await request(app()).put('/api/product-categories/c1').set(storeHeader).send({ name: ' ของใช้ ' });

            expect(res.status).toBe(200);
            const [update] = supabaseAdmin.callsForOp('product_categories', 'update');
            expect(update.payload).toEqual({ name: 'ของใช้' });
            expect(filterArgs(update, 'eq')).toContainEqual(['id', 'c1']);
            expect(filterArgs(update, 'eq')).toContainEqual(['store_id', STORE_ID]);
        });

        it('rejects a blank name', async () => {
            const res = await request(app()).put('/api/product-categories/c1').set(storeHeader).send({ name: '  ' });

            expect(res.status).toBe(400);
            expect(res.body.error).toBe('Category name is required');
            expect(supabaseAdmin.from).not.toHaveBeenCalled();
        });

        it('requires a store header and store access, and reports update failures', async () => {
            expect((await request(app()).put('/api/product-categories/c1').send({ name: 'x' })).status).toBe(400);
            expect((await request(app(denyAccess)).put('/api/product-categories/c1').set(storeHeader).send({ name: 'x' })).status).toBe(403);

            supabaseAdmin.on('product_categories', { data: null, error: { message: 'down' } });
            expect((await request(app()).put('/api/product-categories/c1').set(storeHeader).send({ name: 'x' })).status).toBe(500);
        });
    });

    describe('DELETE /api/product-categories/:id', () => {
        it('deletes an unused category, scoped to the store', async () => {
            supabaseAdmin.on('products', { data: [], error: null }).on('product_categories', { data: null, error: null });

            const res = await request(app()).delete('/api/product-categories/c1').set(storeHeader);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ success: true, message: 'Category deleted successfully' });

            const [del] = supabaseAdmin.callsForOp('product_categories', 'delete');
            expect(filterArgs(del, 'eq')).toContainEqual(['id', 'c1']);
            expect(filterArgs(del, 'eq')).toContainEqual(['store_id', STORE_ID]);
        });

        it('refuses to delete a category that still has products', async () => {
            supabaseAdmin.on('products', { data: [{ id: 'p1' }], error: null });

            const res = await request(app()).delete('/api/product-categories/c1').set(storeHeader);

            expect(res.status).toBe(400);
            expect(res.body.error).toContain('มีสินค้าในหมวดหมู่นี้อยู่');
            expect(supabaseAdmin.callsFor('product_categories')).toHaveLength(0);
        });

        it('ignores soft-deleted products when checking whether the category is in use', async () => {
            supabaseAdmin.on('products', { data: [], error: null }).on('product_categories', { data: null, error: null });

            await request(app()).delete('/api/product-categories/c1').set(storeHeader);

            const [probe] = supabaseAdmin.callsFor('products');
            expect(probe.filters).toContainEqual({ name: 'is', args: ['deleted_at', null] });
            expect(probe.filters).toContainEqual({ name: 'limit', args: [1] });
        });

        it('requires a store header and store access', async () => {
            supabaseAdmin.on('products', { data: [], error: null }).on('product_categories', { data: null, error: null });

            const noHeader = await request(app()).delete('/api/product-categories/c1');
            expect(noHeader.status).toBe(400);
            expect(noHeader.body).toEqual({ success: false, error: 'Store ID required' });

            const denied = await request(app(denyAccess)).delete('/api/product-categories/c1').set(storeHeader);
            expect(denied.status).toBe(403);

            expect(supabaseAdmin.from).not.toHaveBeenCalled();
        });

        it('scopes the in-use probe to the store as well', async () => {
            supabaseAdmin.on('products', { data: [], error: null }).on('product_categories', { data: null, error: null });

            await request(app()).delete('/api/product-categories/c1').set(storeHeader);

            expect(filterArgs(supabaseAdmin.callsFor('products')[0], 'eq')).toContainEqual(['store_id', STORE_ID]);
        });

        it('returns 500 when the delete fails', async () => {
            supabaseAdmin.on('products', { data: [], error: null }).on('product_categories', { data: null, error: { message: 'FK' } });

            expect((await request(app()).delete('/api/product-categories/c1').set(storeHeader)).status).toBe(500);
        });
    });

    describe('PUT /api/products/:id/price', () => {
        it('updates the price and returns the refreshed row', async () => {
            supabaseAdmin.on('products', { data: { id: 'p1', name: 'นมสด', price: 25 }, error: null });

            const res = await request(app()).put('/api/products/p1/price').set(storeHeader).send({ newPrice: '25' });

            expect(res.status).toBe(200);
            const [update] = supabaseAdmin.callsForOp('products', 'update');
            expect(update.payload).toEqual({ price: 25 });
            expect(filterArgs(update, 'eq')).toContainEqual(['id', 'p1']);
            expect(filterArgs(update, 'eq')).toContainEqual(['store_id', STORE_ID]);
        });

        it('rejects a missing, non-numeric or negative price', async () => {
            for (const newPrice of [undefined, null, '', 'abc', -5]) {
                // eslint-disable-next-line no-await-in-loop
                const res = await request(app()).put('/api/products/p1/price').set(storeHeader).send({ newPrice });
                expect(res.status).toBe(400);
                expect(res.body.error).toBe('ราคาไม่ถูกต้อง');
            }
            expect(supabaseAdmin.from).not.toHaveBeenCalled();
        });

        it('accepts a price of 0', async () => {
            supabaseAdmin.on('products', { data: { id: 'p1', price: 0 }, error: null });

            const res = await request(app()).put('/api/products/p1/price').set(storeHeader).send({ newPrice: 0 });

            expect(res.status).toBe(200);
            expect(supabaseAdmin.callsForOp('products', 'update')[0].payload).toEqual({ price: 0 });
        });

        it('requires a store header and store access', async () => {
            supabaseAdmin.on('products', { data: { id: 'p1' }, error: null });

            const noHeader = await request(app()).put('/api/products/p1/price').send({ newPrice: 10 });
            expect(noHeader.status).toBe(400);
            expect(noHeader.body).toEqual({ success: false, error: 'Store ID required' });

            const denied = await request(app(denyAccess)).put('/api/products/p1/price').set(storeHeader).send({ newPrice: 10 });
            expect(denied.status).toBe(403);

            expect(supabaseAdmin.from).not.toHaveBeenCalled();
        });

        it('returns 404 when no row matched and 500 when the update failed', async () => {
            supabaseAdmin.on('products', { data: null, error: null });
            const missing = await request(app()).put('/api/products/p1/price').set(storeHeader).send({ newPrice: 10 });
            expect(missing.status).toBe(404);
            expect(missing.body.error).toBe('ไม่พบสินค้า');

            supabaseAdmin.on('products', { data: null, error: { message: 'locked' } });
            expect((await request(app()).put('/api/products/p1/price').set(storeHeader).send({ newPrice: 10 })).status).toBe(500);
        });
    });

    describe('POST /api/products', () => {
        function withInsert(product = { id: 'p1', name: 'นมสด' }) {
            return supabaseAdmin
                .on('products', { data: product, error: null })
                .on('product_batches', { data: null, error: null });
        }

        it('creates the product with defaults filled in', async () => {
            withInsert();

            const res = await request(app()).post('/api/products').set(storeHeader).send({ name: '  นมสด  ' });

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ success: true, data: { id: 'p1', name: 'นมสด' } });

            expect(supabaseAdmin.callsForOp('products', 'insert')[0].payload[0]).toMatchObject({
                barcode: null, name: 'นมสด', category_id: null, stock_qty: 0, cost_price: 0,
                price: 0, low_stock_threshold: 0, unit_type: 'ชิ้น', store_id: STORE_ID,
                image_url: null, is_weightable: false
            });
        });

        it('coerces the numeric fields and forces is_weightable to a boolean', async () => {
            withInsert();

            await request(app()).post('/api/products').set(storeHeader).send({
                name: 'x', code: '8850001', categoryId: 'c1', quantity: '3',
                costPrice: '4.5', salePrice: '9', lowStockThreshold: '2',
                unitType: 'กก.', isWeightable: 'yes'
            });

            expect(supabaseAdmin.callsForOp('products', 'insert')[0].payload[0]).toMatchObject({
                barcode: '8850001', category_id: 'c1', stock_qty: 3, cost_price: 4.5,
                price: 9, low_stock_threshold: 2, unit_type: 'กก.', is_weightable: true
            });
        });

        it('creates an opening batch when a quantity was supplied', async () => {
            withInsert();

            await request(app()).post('/api/products').set(storeHeader).send({ name: 'x', quantity: 4, expireDate: '25/12/2025' });

            const [batch] = supabaseAdmin.callsForOp('product_batches', 'insert');
            expect(batch.payload[0]).toMatchObject({ product_id: 'p1', qty: 4, remaining_qty: 4, expire_date: '2025-12-25' });
        });

        it('skips the batch when the quantity is zero', async () => {
            withInsert();

            await request(app()).post('/api/products').set(storeHeader).send({ name: 'x', quantity: 0 });

            expect(supabaseAdmin.callsFor('product_batches')).toHaveLength(0);
        });

        it('still reports success when only the batch insert fails', async () => {
            supabaseAdmin
                .on('products', { data: { id: 'p1' }, error: null })
                .on('product_batches', { data: null, error: { message: 'batch failed' } });

            const res = await request(app()).post('/api/products').set(storeHeader).send({ name: 'x', quantity: 2 });

            expect(res.status).toBe(200);
            expect(errorSpy).toHaveBeenCalledWith('Batch creation failed:', expect.anything());
        });

        it('uploads a base64 image and stores its public URL', async () => {
            const upload = jest.fn(async () => ({ data: { path: 'p' }, error: null }));
            supabaseAdmin.setStorage('products', { upload });
            withInsert();

            await request(app()).post('/api/products').set(storeHeader)
                .send({ name: 'x', imageUrl: 'data:image/jpeg;base64,QUJD' });

            expect(supabaseAdmin.storage.from).toHaveBeenCalledWith('products');
            const [path, buffer, options] = upload.mock.calls[0];
            expect(path).toMatch(new RegExp(`^${STORE_ID}/product-\\d+\\.jpg$`));
            expect(buffer.toString()).toBe('ABC');
            expect(options).toMatchObject({ contentType: 'image/jpeg', upsert: true });

            expect(supabaseAdmin.callsForOp('products', 'insert')[0].payload[0].image_url)
                .toContain('products');
        });

        it('passes a plain URL through without uploading', async () => {
            withInsert();

            await request(app()).post('/api/products').set(storeHeader)
                .send({ name: 'x', imageUrl: 'https://cdn.test/a.png' });

            expect(supabaseAdmin.storage.from).not.toHaveBeenCalled();
            expect(supabaseAdmin.callsForOp('products', 'insert')[0].payload[0].image_url).toBe('https://cdn.test/a.png');
        });

        it('stores a null image when the upload fails, rather than aborting', async () => {
            supabaseAdmin.setStorage('products', { upload: async () => ({ data: null, error: { message: 'bucket full' } }) });
            withInsert();

            const res = await request(app()).post('/api/products').set(storeHeader)
                .send({ name: 'x', imageUrl: 'data:image/png;base64,QUJD' });

            expect(res.status).toBe(200);
            expect(supabaseAdmin.callsForOp('products', 'insert')[0].payload[0].image_url).toBeNull();
        });

        it('rejects a blank product name', async () => {
            for (const name of ['', '   ', undefined]) {
                // eslint-disable-next-line no-await-in-loop
                const res = await request(app()).post('/api/products').set(storeHeader).send({ name });
                expect(res.status).toBe(400);
                expect(res.body.error).toBe('กรุณากรอกชื่อสินค้า');
            }
            expect(supabaseAdmin.from).not.toHaveBeenCalled();
        });

        it('requires a store header and store access', async () => {
            withInsert();

            const noHeader = await request(app()).post('/api/products').send({ name: 'x' });
            expect(noHeader.status).toBe(400);
            expect(noHeader.body).toEqual({ success: false, error: 'Store ID required' });

            const denied = await request(app(denyAccess)).post('/api/products').set(storeHeader).send({ name: 'x' });
            expect(denied.status).toBe(403);

            expect(supabaseAdmin.from).not.toHaveBeenCalled();
        });

        it('returns 500 when the product insert fails', async () => {
            supabaseAdmin.on('products', { data: null, error: { message: 'duplicate barcode' } });

            const res = await request(app()).post('/api/products').set(storeHeader).send({ name: 'x' });

            expect(res.status).toBe(500);
            expect(res.body).toEqual({ success: false, error: 'duplicate barcode' });
        });
    });
});
