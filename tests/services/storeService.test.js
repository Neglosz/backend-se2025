const { createStoreService } = require('../../services/storeService');
const { createMockSupabase, filterArgs } = require('../helpers/mockSupabase');

describe('services/storeService', () => {
    let supabaseAdmin;
    let service;

    beforeEach(() => {
        supabaseAdmin = createMockSupabase();
        service = createStoreService({ supabaseAdmin });
    });

    it('exposes exactly the two service functions', () => {
        expect(Object.keys(service).sort()).toEqual(['checkStoreAccess', 'signUrlIfNeeded']);
    });

    describe('checkStoreAccess()', () => {
        it('denies without touching the database when either id is missing', async () => {
            expect(await service.checkStoreAccess(null, 'user-1')).toBe(false);
            expect(await service.checkStoreAccess('store-1', null)).toBe(false);
            expect(await service.checkStoreAccess(undefined, undefined)).toBe(false);
            expect(await service.checkStoreAccess('', '')).toBe(false);

            expect(supabaseAdmin.from).not.toHaveBeenCalled();
        });

        it('grants access to the store owner and stops before the member lookup', async () => {
            supabaseAdmin.on('stores', { data: { owner_id: 'user-1' }, error: null });

            expect(await service.checkStoreAccess('store-1', 'user-1')).toBe(true);
            expect(supabaseAdmin.callsFor('store_members')).toHaveLength(0);
        });

        it('queries the owner by store id', async () => {
            supabaseAdmin.on('stores', { data: { owner_id: 'user-1' }, error: null });

            await service.checkStoreAccess('store-9', 'user-1');

            const [call] = supabaseAdmin.callsFor('stores');
            expect(call.op).toBe('select');
            expect(filterArgs(call, 'eq')).toContainEqual(['id', 'store-9']);
            expect(call.terminal).toBe('single');
        });

        it('grants access to a store member who is not the owner', async () => {
            supabaseAdmin
                .on('stores', { data: { owner_id: 'someone-else' }, error: null })
                .on('store_members', { data: { role: 'manager' }, error: null });

            expect(await service.checkStoreAccess('store-1', 'user-1')).toBe(true);

            const [memberCall] = supabaseAdmin.callsFor('store_members');
            expect(filterArgs(memberCall, 'eq')).toContainEqual(['store_id', 'store-1']);
            expect(filterArgs(memberCall, 'eq')).toContainEqual(['user_id', 'user-1']);
        });

        it('grants access for any member role, not just manager', async () => {
            supabaseAdmin
                .on('stores', { data: { owner_id: 'other' }, error: null })
                .on('store_members', { data: { role: 'staff' }, error: null });

            expect(await service.checkStoreAccess('store-1', 'user-1')).toBe(true);
        });

        it('denies a user who is neither owner nor member', async () => {
            supabaseAdmin
                .on('stores', { data: { owner_id: 'other' }, error: null })
                .on('store_members', { data: null, error: null });

            expect(await service.checkStoreAccess('store-1', 'user-1')).toBe(false);
        });

        it('denies when the store does not exist', async () => {
            supabaseAdmin
                .on('stores', { data: null, error: null })
                .on('store_members', { data: null, error: null });

            expect(await service.checkStoreAccess('missing-store', 'user-1')).toBe(false);
        });

        it('denies when the owner id belongs to a different user, even on a partial id match', async () => {
            supabaseAdmin
                .on('stores', { data: { owner_id: 'user-10' }, error: null })
                .on('store_members', { data: null, error: null });

            expect(await service.checkStoreAccess('store-1', 'user-1')).toBe(false);
        });
    });

    describe('signUrlIfNeeded()', () => {
        it('returns null for falsy input', async () => {
            expect(await service.signUrlIfNeeded(null, 'customers')).toBeNull();
            expect(await service.signUrlIfNeeded('', 'customers')).toBeNull();
            expect(await service.signUrlIfNeeded(undefined, 'customers')).toBeNull();
        });

        it('passes the value through untouched for any bucket other than customers', async () => {
            const url = 'https://cdn.test/object/public/products/a.png';

            expect(await service.signUrlIfNeeded(url, 'products')).toBe(url);
            expect(await service.signUrlIfNeeded(url, 'stores')).toBe(url);
            expect(supabaseAdmin.storage.from).not.toHaveBeenCalled();
        });

        it('resolves a bare storage path through getPublicUrl', async () => {
            const out = await service.signUrlIfNeeded('store-1/cust-9.jpg', 'customers');

            expect(supabaseAdmin.storage.from).toHaveBeenCalledWith('customers');
            expect(out).toBe('https://cdn.test/object/public/customers/store-1/cust-9.jpg');
        });

        it('strips a full public URL back down to its object path before re-signing', async () => {
            const getPublicUrl = jest.fn((path) => ({ data: { publicUrl: `signed:${path}` } }));
            supabaseAdmin.setStorage('customers', { getPublicUrl });

            const out = await service.signUrlIfNeeded(
                'https://xyz.supabase.co/storage/v1/object/public/customers/store-1/cust-9.jpg',
                'customers'
            );

            expect(getPublicUrl).toHaveBeenCalledWith('store-1/cust-9.jpg');
            expect(out).toBe('signed:store-1/cust-9.jpg');
        });

        it('keeps a nested object path intact when stripping the URL prefix', async () => {
            const getPublicUrl = jest.fn((path) => ({ data: { publicUrl: `signed:${path}` } }));
            supabaseAdmin.setStorage('customers', { getPublicUrl });

            await service.signUrlIfNeeded(
                'https://xyz.supabase.co/storage/v1/object/public/customers/a/b/c.png',
                'customers'
            );

            expect(getPublicUrl).toHaveBeenCalledWith('a/b/c.png');
        });
    });
});
