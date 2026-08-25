const request = require('supertest');
const express = require('express');
const { registerSystemRoutes } = require('../../routes/systemRoutes');
const { createMockSupabase, filterArgs } = require('../helpers/mockSupabase');

const USER = { id: 'user-1', email: 'owner@test.dev' };

/**
 * systemRoutes takes `authMiddleware` as an argument and attaches it per route,
 * so the app is assembled here rather than through the shared helper.
 */
function buildApp(supabaseAdmin, authMiddleware) {
    const app = express();
    app.use(express.json());
    registerSystemRoutes({ app, authMiddleware, supabaseAdmin });
    return app;
}

const passThroughAuth = (req, _res, next) => { req.user = USER; next(); };

describe('routes/systemRoutes', () => {
    let supabaseAdmin;
    let app;

    beforeEach(() => {
        supabaseAdmin = createMockSupabase();
        app = buildApp(supabaseAdmin, passThroughAuth);
    });

    it('guards every route with the injected auth middleware', async () => {
        const blocking = jest.fn((_req, res) => res.status(401).json({ success: false }));
        const guarded = buildApp(supabaseAdmin, blocking);

        for (const call of [
            request(guarded).post('/api/admin/migrate-add-tendered'),
            request(guarded).get('/api/debug/whoami'),
            request(guarded).post('/api/admin/purge-deleted-products')
        ]) {
            // eslint-disable-next-line no-await-in-loop
            const res = await call;
            expect(res.status).toBe(401);
        }
        expect(blocking).toHaveBeenCalledTimes(3);
        expect(supabaseAdmin.from).not.toHaveBeenCalled();
    });

    describe('POST /api/admin/migrate-add-tendered', () => {
        it('is a stub that points the caller at the agent tool', async () => {
            const res = await request(app).post('/api/admin/migrate-add-tendered');

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ message: 'Use the agent tool to migrate.' });
            expect(supabaseAdmin.from).not.toHaveBeenCalled();
        });
    });

    describe('GET /api/debug/whoami', () => {
        it('reports the user, the header store and the owned stores', async () => {
            const stores = [{ id: 'store-1', name: 'ร้านทดสอบ' }];
            supabaseAdmin.on('stores', { data: stores, error: null }).on('products', { count: 0, data: null, error: null });

            const res = await request(app).get('/api/debug/whoami').set('x-store-id', 'store-1');

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({
                success: true,
                user: { id: 'user-1', email: 'owner@test.dev' },
                headerStoreId: 'store-1',
                ownedStores: stores
            });
        });

        it('counts products in the header store and orphaned products separately', async () => {
            supabaseAdmin
                .on('stores', { data: [], error: null })
                .queue('products', { count: 7, data: null, error: null }, { count: 3, data: null, error: null });

            const res = await request(app).get('/api/debug/whoami').set('x-store-id', 'store-1');

            expect(res.body.stats).toEqual({ inThisStore: 7, orphans: 3 });

            const [inStore, orphans] = supabaseAdmin.callsFor('products');
            expect(filterArgs(inStore, 'eq')).toContainEqual(['store_id', 'store-1']);
            expect(inStore.filters).toContainEqual({ name: 'is', args: ['deleted_at', null] });
            expect(orphans.filters).toContainEqual({ name: 'is', args: ['store_id', null] });
        });

        it('skips the in-store count entirely when no store header is sent', async () => {
            supabaseAdmin.on('stores', { data: [], error: null }).on('products', { count: 4, data: null, error: null });

            const res = await request(app).get('/api/debug/whoami');

            expect(res.body.headerStoreId).toBeUndefined();
            expect(res.body.stats).toEqual({ inThisStore: 0, orphans: 4 });
            expect(supabaseAdmin.callsFor('products')).toHaveLength(1); // orphan count only
        });

        it('filters owned stores by the authenticated user', async () => {
            supabaseAdmin.on('stores', { data: [], error: null }).on('products', { count: 0, data: null, error: null });

            await request(app).get('/api/debug/whoami');

            expect(filterArgs(supabaseAdmin.callsFor('stores')[0], 'eq')).toContainEqual(['owner_id', 'user-1']);
        });

        it('returns 500 when a lookup throws', async () => {
            supabaseAdmin.on('stores', () => { throw new Error('db down'); });

            const res = await request(app).get('/api/debug/whoami');

            expect(res.status).toBe(500);
            expect(res.body).toEqual({ error: 'db down' });
        });
    });

    describe('POST /api/admin/purge-deleted-products', () => {
        it('reports zeroes when there is nothing to purge', async () => {
            supabaseAdmin.on('products', { data: [], error: null }).on('product_batches', { data: [], error: null });

            const res = await request(app).post('/api/admin/purge-deleted-products');

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ success: true, deleted: 0, deletedProducts: 0, deletedBatches: 0 });
            expect(supabaseAdmin.callsFor('promotion_items')).toHaveLength(0);
        });

        it('selects only products soft-deleted more than 30 days ago', async () => {
            supabaseAdmin.on('products', { data: [], error: null }).on('product_batches', { data: [], error: null });
            const before = Date.now();

            await request(app).post('/api/admin/purge-deleted-products');

            const [lookup] = supabaseAdmin.callsFor('products');
            expect(lookup.filters).toContainEqual({ name: 'not', args: ['deleted_at', 'is', null] });
            const [[column, cutoff]] = filterArgs(lookup, 'lt');
            expect(column).toBe('deleted_at');
            const age = before - new Date(cutoff).getTime();
            expect(age).toBeGreaterThan(29.9 * 24 * 60 * 60 * 1000);
            expect(age).toBeLessThan(30.1 * 24 * 60 * 60 * 1000);
        });

        it('deletes child rows before the products themselves (FK order matters)', async () => {
            supabaseAdmin
                .queue('products', { data: [{ id: 'p1' }, { id: 'p2' }], error: null }, { data: null, error: null })
                .on('product_batches', { data: [], error: null });

            const res = await request(app).post('/api/admin/purge-deleted-products');

            expect(res.body).toMatchObject({ deleted: 2, deletedProducts: 2 });

            const order = supabaseAdmin.calls.map((c) => `${c.table}:${c.op}`);
            const productDelete = order.lastIndexOf('products:delete');
            for (const child of ['promotion_items:delete', 'inventory_transactions:delete', 'product_batches:delete']) {
                expect(order.indexOf(child)).toBeGreaterThan(-1);
                expect(order.indexOf(child)).toBeLessThan(productDelete);
            }

            for (const table of ['promotion_items', 'inventory_transactions']) {
                expect(supabaseAdmin.callsFor(table)[0].filters).toContainEqual({ name: 'in', args: ['product_id', ['p1', 'p2']] });
            }
        });

        it('purges empty batches older than two years, capped at 500 per run', async () => {
            supabaseAdmin
                .on('products', { data: [], error: null })
                .queue('product_batches', { data: [{ id: 'b1' }, { id: 'b2' }], error: null }, { data: null, error: null });
            const before = Date.now();

            const res = await request(app).post('/api/admin/purge-deleted-products');

            expect(res.body.deletedBatches).toBe(2);

            const [lookup] = supabaseAdmin.callsFor('product_batches');
            expect(filterArgs(lookup, 'eq')).toContainEqual(['remaining_qty', 0]);
            expect(lookup.filters).toContainEqual({ name: 'limit', args: [500] });
            const [[, cutoff]] = filterArgs(lookup, 'lt');
            expect(new Date(cutoff).getTime()).toBeLessThan(before - 700 * 24 * 60 * 60 * 1000);
        });

        it('nulls out batch references before deleting the batches (avoids FK errors)', async () => {
            supabaseAdmin
                .on('products', { data: [], error: null })
                .queue('product_batches', { data: [{ id: 'b1' }], error: null }, { data: null, error: null });

            await request(app).post('/api/admin/purge-deleted-products');

            for (const table of ['order_items', 'inventory_transactions']) {
                const [call] = supabaseAdmin.callsFor(table);
                expect(call.op).toBe('update');
                expect(call.payload).toEqual({ batch_id: null });
                expect(call.filters).toContainEqual({ name: 'in', args: ['batch_id', ['b1']] });
            }

            const order = supabaseAdmin.calls.map((c) => `${c.table}:${c.op}`);
            expect(order.indexOf('order_items:update')).toBeLessThan(order.lastIndexOf('product_batches:delete'));
        });

        it('returns 500 with success:false when a purge step throws', async () => {
            supabaseAdmin.on('products', () => { throw new Error('lock timeout'); });

            const res = await request(app).post('/api/admin/purge-deleted-products');

            expect(res.status).toBe(500);
            expect(res.body).toEqual({ success: false, error: 'lock timeout' });
        });
    });
});
