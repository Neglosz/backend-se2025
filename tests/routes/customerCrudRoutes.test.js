const request = require('supertest');
const { registerCustomerCrudRoutes } = require('../../routes/customerCrudRoutes');
const { createMockSupabase, filterArgs } = require('../helpers/mockSupabase');
const { createTestApp, allowAccess, denyAccess, STORE_ID, storeHeader } = require('../helpers/testApp');

describe('routes/customerCrudRoutes', () => {
    let supabaseAdmin;

    beforeEach(() => {
        supabaseAdmin = createMockSupabase();
    });

    const app = (checkStoreAccess = allowAccess) =>
        createTestApp(registerCustomerCrudRoutes, { supabaseAdmin, checkStoreAccess });

    describe('PUT /api/customers/:id', () => {
        it('updates name and phone and returns the new row', async () => {
            const updated = { id: 'cust-1', name: 'สมชาย', phone: '0812345678' };
            supabaseAdmin.on('customers_info', { data: updated, error: null });

            const res = await request(app())
                .put('/api/customers/cust-1')
                .set(storeHeader)
                .send({ name: 'สมชาย', phone: '0812345678' });

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ success: true, data: updated });
        });

        it('scopes the update to the store as well as the customer id', async () => {
            supabaseAdmin.on('customers_info', { data: {}, error: null });

            await request(app()).put('/api/customers/cust-1').set(storeHeader).send({ name: 'A', phone: '1' });

            const [call] = supabaseAdmin.callsFor('customers_info');
            expect(call.op).toBe('update');
            expect(call.payload).toEqual({ name: 'A', phone: '1' });
            expect(filterArgs(call, 'eq')).toContainEqual(['id', 'cust-1']);
            expect(filterArgs(call, 'eq')).toContainEqual(['store_id', STORE_ID]);
        });

        it('rejects a request with no x-store-id header', async () => {
            const res = await request(app()).put('/api/customers/cust-1').send({ name: 'A' });

            expect(res.status).toBe(400);
            expect(res.body).toEqual({ success: false, error: 'Store ID required' });
            expect(supabaseAdmin.from).not.toHaveBeenCalled();
        });

        it('rejects a user without access to the store', async () => {
            const res = await request(app(denyAccess)).put('/api/customers/cust-1').set(storeHeader).send({ name: 'A' });

            expect(res.status).toBe(403);
            expect(res.body).toEqual({ success: false, error: 'Unauthorized access to store' });
            expect(supabaseAdmin.from).not.toHaveBeenCalled();
        });

        it('checks access with the header store and the authenticated user', async () => {
            const check = jest.fn(async () => true);
            supabaseAdmin.on('customers_info', { data: {}, error: null });

            await request(app(check)).put('/api/customers/cust-1').set(storeHeader).send({ name: 'A' });

            expect(check).toHaveBeenCalledWith(STORE_ID, 'user-1');
        });

        it('returns 500 when the update fails', async () => {
            supabaseAdmin.on('customers_info', { data: null, error: { message: 'duplicate phone' } });

            const res = await request(app()).put('/api/customers/cust-1').set(storeHeader).send({ name: 'A' });

            expect(res.status).toBe(500);
            expect(res.body).toEqual({ success: false, error: 'duplicate phone' });
        });

        it('writes undefined fields as-is when the body is empty (no partial-update guard)', async () => {
            supabaseAdmin.on('customers_info', { data: {}, error: null });

            await request(app()).put('/api/customers/cust-1').set(storeHeader).send({});

            expect(supabaseAdmin.callsFor('customers_info')[0].payload).toEqual({ name: undefined, phone: undefined });
        });
    });

    describe('DELETE /api/customers/:id', () => {
        it('deletes the customer and confirms', async () => {
            supabaseAdmin.on('customers_info', { data: null, error: null });

            const res = await request(app()).delete('/api/customers/cust-1').set(storeHeader);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ success: true, message: 'Customer deleted successfully' });
        });

        it('scopes the delete to the store as well as the customer id', async () => {
            supabaseAdmin.on('customers_info', { data: null, error: null });

            await request(app()).delete('/api/customers/cust-9').set(storeHeader);

            const [call] = supabaseAdmin.callsFor('customers_info');
            expect(call.op).toBe('delete');
            expect(filterArgs(call, 'eq')).toContainEqual(['id', 'cust-9']);
            expect(filterArgs(call, 'eq')).toContainEqual(['store_id', STORE_ID]);
        });

        it('rejects a request with no x-store-id header', async () => {
            const res = await request(app()).delete('/api/customers/cust-1');

            expect(res.status).toBe(400);
            expect(supabaseAdmin.from).not.toHaveBeenCalled();
        });

        it('rejects a user without access to the store', async () => {
            const res = await request(app(denyAccess)).delete('/api/customers/cust-1').set(storeHeader);

            expect(res.status).toBe(403);
            expect(supabaseAdmin.from).not.toHaveBeenCalled();
        });

        it('returns 500 when the delete fails', async () => {
            supabaseAdmin.on('customers_info', { data: null, error: { message: 'FK violation' } });

            const res = await request(app()).delete('/api/customers/cust-1').set(storeHeader);

            expect(res.status).toBe(500);
            expect(res.body).toEqual({ success: false, error: 'FK violation' });
        });
    });
});
