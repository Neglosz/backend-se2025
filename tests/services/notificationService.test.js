const { createNotificationService } = require('../../services/notificationService');
const { createMockSupabase, filterArgs } = require('../helpers/mockSupabase');

const STORE_ID = 'store-1';
const REF_ID = 'batch-42';
const REF_TYPE = 'product_batch';

/**
 * Wire up the store/member lookups that `getStoreUsers` performs, so the tests
 * below only have to describe the notifications table.
 */
function withStoreUsers(db, { ownerId = 'owner-1', memberIds = ['member-1'] } = {}) {
    return db
        .on('stores', { data: ownerId ? { owner_id: ownerId } : null, error: null })
        .on('store_members', { data: memberIds.map((user_id) => ({ user_id })), error: null });
}

describe('services/notificationService', () => {
    let supabaseAdmin;
    let service;
    let errorSpy;

    beforeEach(() => {
        supabaseAdmin = createMockSupabase();
        service = createNotificationService({ supabaseAdmin });
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => errorSpy.mockRestore());

    it('exposes exactly the two global helpers', () => {
        expect(Object.keys(service).sort()).toEqual(['deleteNotificationGlobal', 'upsertNotificationGlobal']);
    });

    describe('upsertNotificationGlobal()', () => {
        const args = [STORE_ID, 'stock_low', 'Low stock', 'Only 2 left', 'stock', 'high', REF_ID, REF_TYPE, { qty: 2 }];

        it('inserts one fresh notification per store user when none exists', async () => {
            withStoreUsers(supabaseAdmin, { ownerId: 'owner-1', memberIds: ['member-1', 'member-2'] });
            supabaseAdmin.on('notifications', { data: [], error: null });

            const created = await service.upsertNotificationGlobal(...args);

            expect(created).toBe(true);
            const inserts = supabaseAdmin.callsForOp('notifications', 'insert');
            expect(inserts).toHaveLength(3); // owner + 2 members
            expect(inserts.map((c) => c.payload[0].user_id)).toEqual(['owner-1', 'member-1', 'member-2']);
        });

        it('writes the full notification row, unread, with a 30-day expiry', async () => {
            withStoreUsers(supabaseAdmin, { memberIds: [] });
            supabaseAdmin.on('notifications', { data: [], error: null });
            const before = Date.now();

            await service.upsertNotificationGlobal(...args);

            const [row] = supabaseAdmin.callsForOp('notifications', 'insert')[0].payload;
            expect(row).toMatchObject({
                store_id: STORE_ID,
                user_id: 'owner-1',
                type: 'stock_low',
                title: 'Low stock',
                message: 'Only 2 left',
                category: 'stock',
                priority: 'high',
                reference_id: REF_ID,
                reference_type: REF_TYPE,
                payload: { qty: 2 },
                is_read: false
            });
            const thirtyDays = 30 * 24 * 60 * 60 * 1000;
            expect(row.expires_at.getTime()).toBeGreaterThanOrEqual(before + thirtyDays - 5000);
            expect(row.expires_at.getTime()).toBeLessThanOrEqual(Date.now() + thirtyDays + 5000);
        });

        it('deduplicates the owner when the owner is also listed as a member', async () => {
            withStoreUsers(supabaseAdmin, { ownerId: 'owner-1', memberIds: ['owner-1', 'member-1'] });
            supabaseAdmin.on('notifications', { data: [], error: null });

            await service.upsertNotificationGlobal(...args);

            const users = supabaseAdmin.callsForOp('notifications', 'insert').map((c) => c.payload[0].user_id);
            expect(users).toEqual(['owner-1', 'member-1']);
        });

        it('matches an existing notification by reference, not by type', async () => {
            withStoreUsers(supabaseAdmin, { memberIds: [] });
            supabaseAdmin.on('notifications', { data: [{ id: 'n1', type: 'stock_near_expiry', title: 'Old', message: 'Old' }], error: null });

            await service.upsertNotificationGlobal(...args);

            const [lookup] = supabaseAdmin.callsFor('notifications');
            const eqs = filterArgs(lookup, 'eq');
            expect(eqs).toContainEqual(['reference_id', REF_ID]);
            expect(eqs).toContainEqual(['reference_type', REF_TYPE]);
            expect(eqs.some(([col]) => col === 'type')).toBe(false);
        });

        it('updates in place when the type changes (near_expiry -> expired)', async () => {
            withStoreUsers(supabaseAdmin, { memberIds: [] });
            supabaseAdmin.on('notifications', (state) => {
                if (state.op === 'select') {
                    return { data: [{ id: 'n1', type: 'stock_near_expiry', title: 'Low stock', message: 'Only 2 left' }], error: null };
                }
                return { data: null, error: null };
            });

            const changed = await service.upsertNotificationGlobal(...args);

            expect(changed).toBe(true);
            const [update] = supabaseAdmin.callsForOp('notifications', 'update');
            expect(update.payload).toMatchObject({ type: 'stock_low', title: 'Low stock', message: 'Only 2 left', is_read: false });
            expect(filterArgs(update, 'eq')).toContainEqual(['id', 'n1']);
            expect(supabaseAdmin.callsForOp('notifications', 'insert')).toHaveLength(0);
        });

        it('never touches created_at on update (it would retrigger the Realtime loop)', async () => {
            withStoreUsers(supabaseAdmin, { memberIds: [] });
            supabaseAdmin.on('notifications', (state) =>
                state.op === 'select'
                    ? { data: [{ id: 'n1', type: 'other', title: 'Low stock', message: 'Only 2 left' }], error: null }
                    : { data: null, error: null });

            await service.upsertNotificationGlobal(...args);

            expect(supabaseAdmin.callsForOp('notifications', 'update')[0].payload).not.toHaveProperty('created_at');
        });

        it('updates when only the content changed', async () => {
            withStoreUsers(supabaseAdmin, { memberIds: [] });
            supabaseAdmin.on('notifications', (state) =>
                state.op === 'select'
                    ? { data: [{ id: 'n1', type: 'stock_low', title: 'Low stock', message: 'Only 5 left' }], error: null }
                    : { data: null, error: null });

            expect(await service.upsertNotificationGlobal(...args)).toBe(true);
            expect(supabaseAdmin.callsForOp('notifications', 'update')).toHaveLength(1);
        });

        it('does nothing when type and content are unchanged (preserves is_read/created_at)', async () => {
            withStoreUsers(supabaseAdmin, { memberIds: [] });
            supabaseAdmin.on('notifications', (state) =>
                state.op === 'select'
                    ? { data: [{ id: 'n1', type: 'stock_low', title: 'Low stock', message: 'Only 2 left' }], error: null }
                    : { data: null, error: null });

            expect(await service.upsertNotificationGlobal(...args)).toBe(false);
            expect(supabaseAdmin.callsForOp('notifications', 'update')).toHaveLength(0);
            expect(supabaseAdmin.callsForOp('notifications', 'insert')).toHaveLength(0);
        });

        it('self-heals duplicate rows, keeping the row it is about to update', async () => {
            withStoreUsers(supabaseAdmin, { memberIds: [] });
            supabaseAdmin.on('notifications', (state) =>
                state.op === 'select'
                    ? { data: [{ id: 'n1', type: 'other', title: 'x', message: 'y' }], error: null }
                    : { data: null, error: null });

            await service.upsertNotificationGlobal(...args);

            const [del] = supabaseAdmin.callsForOp('notifications', 'delete');
            expect(del.filters).toContainEqual({ name: 'neq', args: ['id', 'n1'] });
        });

        it('reads the newest row first and limits to 1 (never maybeSingle, which throws on dupes)', async () => {
            withStoreUsers(supabaseAdmin, { memberIds: [] });
            supabaseAdmin.on('notifications', { data: [], error: null });

            await service.upsertNotificationGlobal(...args);

            const [lookup] = supabaseAdmin.callsFor('notifications');
            expect(lookup.filters).toContainEqual({ name: 'order', args: ['created_at', { ascending: false }] });
            expect(lookup.filters).toContainEqual({ name: 'limit', args: [1] });
            expect(lookup.terminal).toBeNull();
        });

        it('returns false when the store has no users at all', async () => {
            supabaseAdmin.on('stores', { data: null, error: null }).on('store_members', { data: [], error: null });

            expect(await service.upsertNotificationGlobal(...args)).toBe(false);
            expect(supabaseAdmin.callsFor('notifications')).toHaveLength(0);
        });

        it('swallows a failure in getStoreUsers and returns false instead of crashing the pipeline', async () => {
            supabaseAdmin.on('stores', () => { throw new Error('db down'); });

            expect(await service.upsertNotificationGlobal(...args)).toBe(false);
            expect(errorSpy).toHaveBeenCalled();
        });

        it('returns false when the notification write itself throws', async () => {
            withStoreUsers(supabaseAdmin, { memberIds: [] });
            supabaseAdmin.on('notifications', () => { throw new Error('insert failed'); });

            expect(await service.upsertNotificationGlobal(...args)).toBe(false);
            expect(errorSpy).toHaveBeenCalledWith('upsertNotificationGlobal Error:', expect.any(Error));
        });
    });

    describe('deleteNotificationGlobal()', () => {
        it('deletes every matching notification id', async () => {
            withStoreUsers(supabaseAdmin, { ownerId: 'owner-1', memberIds: ['member-1'] });
            supabaseAdmin.on('notifications', (state) =>
                state.op === 'select' ? { data: [{ id: 'n1' }, { id: 'n2' }], error: null } : { data: null, error: null });

            expect(await service.deleteNotificationGlobal(STORE_ID, 'stock_low', REF_ID, REF_TYPE)).toBe(true);

            const [del] = supabaseAdmin.callsForOp('notifications', 'delete');
            expect(del.filters).toContainEqual({ name: 'in', args: ['id', ['n1', 'n2']] });
        });

        it('scopes the lookup to the store, its users, the types and the reference', async () => {
            withStoreUsers(supabaseAdmin, { ownerId: 'owner-1', memberIds: ['member-1'] });
            supabaseAdmin.on('notifications', (state) =>
                state.op === 'select' ? { data: [{ id: 'n1' }], error: null } : { data: null, error: null });

            await service.deleteNotificationGlobal(STORE_ID, ['stock_low', 'stock_out'], REF_ID, REF_TYPE);

            const [lookup] = supabaseAdmin.callsFor('notifications');
            expect(lookup.filters).toContainEqual({ name: 'in', args: ['user_id', ['owner-1', 'member-1']] });
            expect(lookup.filters).toContainEqual({ name: 'eq', args: ['store_id', STORE_ID] });
            expect(lookup.filters).toContainEqual({ name: 'in', args: ['type', ['stock_low', 'stock_out']] });
            expect(lookup.filters).toContainEqual({ name: 'eq', args: ['reference_id', REF_ID] });
            expect(lookup.filters).toContainEqual({ name: 'eq', args: ['reference_type', REF_TYPE] });
        });

        it('wraps a single type string into an array', async () => {
            withStoreUsers(supabaseAdmin, { memberIds: [] });
            supabaseAdmin.on('notifications', { data: [], error: null });

            await service.deleteNotificationGlobal(STORE_ID, 'stock_low', REF_ID, REF_TYPE);

            expect(supabaseAdmin.callsFor('notifications')[0].filters)
                .toContainEqual({ name: 'in', args: ['type', ['stock_low']] });
        });

        it('returns true and issues no delete when nothing matches', async () => {
            withStoreUsers(supabaseAdmin, { memberIds: [] });
            supabaseAdmin.on('notifications', { data: [], error: null });

            expect(await service.deleteNotificationGlobal(STORE_ID, 'stock_low', REF_ID, REF_TYPE)).toBe(true);
            expect(supabaseAdmin.callsForOp('notifications', 'delete')).toHaveLength(0);
        });

        it('returns false when the delete throws', async () => {
            withStoreUsers(supabaseAdmin, { memberIds: [] });
            supabaseAdmin.on('notifications', () => { throw new Error('db down'); });

            expect(await service.deleteNotificationGlobal(STORE_ID, 'stock_low', REF_ID, REF_TYPE)).toBe(false);
            expect(errorSpy).toHaveBeenCalledWith('deleteNotificationGlobal Error:', expect.any(Error));
        });
    });
});
