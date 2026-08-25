const request = require('supertest');
const express = require('express');

// branches.js builds its own admin client at require time, so the Supabase module is
// replaced before the router is loaded. A single mock instance is reused and reset
// between tests (the router captured this exact object at load time).
let mockDb;
jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn(() => mockDb) }));

const { createMockSupabase, filterArgs } = require('../helpers/mockSupabase');
const { decrypt } = require('../../utils/crypto');
mockDb = createMockSupabase();

const { createClient } = require('@supabase/supabase-js');
const branchesRouter = require('../../routes/branches');

const createClientCalls = createClient.mock.calls.map((args) => [...args]);

const OWNER = { id: 'owner-1', email: 'owner@test.dev' };
const STORE_ID = 'store-1234-5678';

function buildApp(user = OWNER) {
    const app = express();
    app.use(express.json());
    if (user) app.use((req, _res, next) => { req.user = user; next(); });
    app.use('/api/branches', branchesRouter);
    return app;
}

describe('routes/branches', () => {
    let app;
    let errorSpy;
    let logSpy;

    beforeEach(() => {
        mockDb.reset();
        mockDb.auth.admin.createUser.mockResolvedValue({ data: { user: { id: 'manager-1' } }, error: null });
        mockDb.auth.admin.deleteUser.mockResolvedValue({ data: null, error: null });
        app = buildApp();
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        errorSpy.mockRestore();
        logSpy.mockRestore();
    });

    it('uses the service role key - this router bypasses RLS by design', () => {
        expect(createClientCalls).toContainEqual([process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY]);
    });

    describe('POST /create-manager', () => {
        const body = { store_id: STORE_ID, email: 'manager@test.dev', password: 'secret123' };

        function ownedStore() {
            return mockDb.on('stores', { data: { id: STORE_ID, owner_id: OWNER.id }, error: null });
        }

        it('stores the credentials itself, encrypted with the server key', async () => {
            ownedStore();
            mockDb.on('profiles', { data: null, error: null })
                .on('store_members', { data: null, error: null })
                .on('store_credentials', { data: null, error: null });

            await request(app).post('/api/branches/create-manager').send(body);

            const ops = mockDb.calls.filter((c) => c.table === 'store_credentials').map((c) => c.op);
            expect(ops).toEqual(['delete', 'insert']); // replace any previous row

            const row = mockDb.callsForOp('store_credentials', 'insert')[0].payload;
            expect(row).toMatchObject({ store_id: STORE_ID, email: 'manager@test.dev' });
            expect(decrypt(row.password_encrypted)).toBe('secret123');
        });

        it('still succeeds when the credential row cannot be stored', async () => {
            ownedStore();
            mockDb.on('profiles', { data: null, error: null })
                .on('store_members', { data: null, error: null })
                .on('store_credentials', { data: null, error: { message: 'table missing' } });

            const res = await request(app).post('/api/branches/create-manager').send(body);

            expect(res.status).toBe(200);
            expect(errorSpy).toHaveBeenCalledWith('Failed to store manager credentials:', expect.anything());
        });

        it('creates the auth user, tags the profile and links the store member', async () => {
            ownedStore();
            mockDb.on('profiles', { data: null, error: null }).on('store_members', { data: null, error: null });

            const res = await request(app).post('/api/branches/create-manager').send(body);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ success: true, manager_id: 'manager-1', email: 'manager@test.dev' });

            expect(mockDb.auth.admin.createUser).toHaveBeenCalledWith({
                email: 'manager@test.dev', password: 'secret123', email_confirm: true
            });

            const [profile] = mockDb.callsForOp('profiles', 'update');
            expect(profile.payload).toEqual({ full_name: 'Manager - store-12', role: 'manager', created_by: OWNER.id });
            expect(filterArgs(profile, 'eq')).toContainEqual(['id', 'manager-1']);

            expect(mockDb.callsForOp('store_members', 'insert')[0].payload)
                .toEqual({ store_id: STORE_ID, user_id: 'manager-1', role: 'manager' });
        });

        it('returns 404 when the store does not exist', async () => {
            mockDb.on('stores', { data: null, error: null });

            const res = await request(app).post('/api/branches/create-manager').send(body);

            expect(res.status).toBe(404);
            expect(res.body).toEqual({ error: 'Store not found' });
            expect(mockDb.auth.admin.createUser).not.toHaveBeenCalled();
        });

        it('returns 403 when the caller does not own the store', async () => {
            mockDb.on('stores', { data: { id: STORE_ID, owner_id: 'someone-else' }, error: null });

            const res = await request(app).post('/api/branches/create-manager').send(body);

            expect(res.status).toBe(403);
            expect(res.body).toEqual({ error: 'Not authorized' });
            expect(mockDb.auth.admin.createUser).not.toHaveBeenCalled();
        });

        it('rejects a malformed email before creating anything', async () => {
            ownedStore();

            for (const email of ['not-an-email', 'a@b', 'a b@test.dev', '@test.dev', '']) {
                // eslint-disable-next-line no-await-in-loop
                const res = await request(app).post('/api/branches/create-manager').send({ ...body, email });
                expect(res.status).toBe(400);
                expect(res.body).toEqual({ error: 'Invalid email format' });
            }
            expect(mockDb.auth.admin.createUser).not.toHaveBeenCalled();
        });

        it('accepts an email with dots, dashes and underscores', async () => {
            ownedStore();
            mockDb.on('profiles', { data: null, error: null }).on('store_members', { data: null, error: null });

            const res = await request(app).post('/api/branches/create-manager')
                .send({ ...body, email: 'first.last-1_x@sub.example.co' });

            expect(res.status).toBe(200);
        });

        it('still succeeds when the profile update fails (logged, not fatal)', async () => {
            ownedStore();
            mockDb.on('profiles', { data: null, error: { message: 'no profile row' } }).on('store_members', { data: null, error: null });

            const res = await request(app).post('/api/branches/create-manager').send(body);

            expect(res.status).toBe(200);
            expect(errorSpy).toHaveBeenCalledWith('Profile update error:', expect.anything());
        });

        it('returns 500 when the auth user cannot be created', async () => {
            ownedStore();
            mockDb.auth.admin.createUser.mockResolvedValue({ data: null, error: { message: 'email already registered' } });

            const res = await request(app).post('/api/branches/create-manager').send(body);

            expect(res.status).toBe(500);
            expect(res.body).toEqual({ error: 'email already registered' });
        });

        it('rolls back the auth account when the store_members insert fails', async () => {
            ownedStore();
            mockDb.on('profiles', { data: null, error: null }).on('store_members', { data: null, error: { message: 'duplicate member' } });

            const res = await request(app).post('/api/branches/create-manager').send(body);

            expect(res.status).toBe(500);
            expect(res.body).toEqual({ error: 'duplicate member' });
            expect(mockDb.auth.admin.deleteUser).toHaveBeenCalledWith('manager-1');
        });

        it('still reports the original failure when the rollback itself fails', async () => {
            ownedStore();
            mockDb.on('profiles', { data: null, error: null }).on('store_members', { data: null, error: { message: 'duplicate member' } });
            mockDb.auth.admin.deleteUser.mockRejectedValue(new Error('user already gone'));

            const res = await request(app).post('/api/branches/create-manager').send(body);

            expect(res.status).toBe(500);
            expect(res.body).toEqual({ error: 'duplicate member' });
            expect(errorSpy).toHaveBeenCalledWith(
                'Failed to roll back orphan manager account:', 'manager-1', 'user already gone'
            );
        });
    });

    describe('POST /reset-credentials', () => {
        const body = {
            store_id: STORE_ID,
            old_user_id: 'manager-old',
            new_email: 'new@test.dev',
            new_password: 'newsecret'
        };

        function ownedStore() {
            return mockDb.on('stores', { data: { id: STORE_ID, owner_id: OWNER.id }, error: null });
        }

        it('removes the old manager, creates a new one and stores the credentials', async () => {
            ownedStore();

            const res = await request(app).post('/api/branches/reset-credentials').send(body);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ success: true, manager_id: 'manager-1', email: 'new@test.dev' });

            expect(mockDb.auth.admin.deleteUser).toHaveBeenCalledWith('manager-old');
            expect(filterArgs(mockDb.callsForOp('store_members', 'delete')[0], 'eq')).toContainEqual(['user_id', 'manager-old']);
            expect(mockDb.callsForOp('store_members', 'insert')[0].payload)
                .toEqual({ store_id: STORE_ID, user_id: 'manager-1', role: 'manager' });
        });

        it('replaces any previous credential row for the store', async () => {
            ownedStore();

            await request(app).post('/api/branches/reset-credentials').send(body);

            const order = mockDb.calls.filter((c) => c.table === 'store_credentials').map((c) => c.op);
            expect(order).toEqual(['delete', 'insert']);
            expect(filterArgs(mockDb.callsForOp('store_credentials', 'delete')[0], 'eq')).toContainEqual(['store_id', STORE_ID]);
        });

        it('stores the password with the server-side AES key, not the old XOR scheme', async () => {
            ownedStore();

            await request(app).post('/api/branches/reset-credentials').send(body);

            const row = mockDb.callsForOp('store_credentials', 'insert')[0].payload;
            expect(row.email).toBe('new@test.dev');
            expect(row.password_encrypted).not.toBe('newsecret');
            // AES-256-CBC output from utils/crypto: "<iv-hex>:<cipher-hex>"
            expect(row.password_encrypted).toMatch(/^[0-9a-f]{32}:[0-9a-f]+$/);
            expect(decrypt(row.password_encrypted)).toBe('newsecret');
        });

        it('no longer recovers the password with the key that shipped in the app bundle', async () => {
            ownedStore();

            await request(app).post('/api/branches/reset-credentials').send(body);

            const { password_encrypted } = mockDb.callsForOp('store_credentials', 'insert')[0].payload;
            const CRED_KEY = 'yourpos-secret-key-2026';
            const xored = Buffer.from(password_encrypted, 'base64').toString('binary');
            let recovered = '';
            for (let i = 0; i < xored.length; i++) {
                recovered += String.fromCharCode(xored.charCodeAt(i) ^ CRED_KEY.charCodeAt(i % CRED_KEY.length));
            }
            expect(recovered).not.toBe('newsecret');
        });

        it('produces a different ciphertext each time (random IV)', async () => {
            ownedStore();
            await request(app).post('/api/branches/reset-credentials').send(body);
            const first = mockDb.callsForOp('store_credentials', 'insert')[0].payload.password_encrypted;

            mockDb.reset();
            mockDb.auth.admin.createUser.mockResolvedValue({ data: { user: { id: 'manager-1' } }, error: null });
            ownedStore();
            await request(app).post('/api/branches/reset-credentials').send(body);
            const second = mockDb.callsForOp('store_credentials', 'insert')[0].payload.password_encrypted;

            expect(first).not.toBe(second);
        });

        it('skips the deletion step when no old user id is supplied', async () => {
            ownedStore();

            const res = await request(app).post('/api/branches/reset-credentials')
                .send({ ...body, old_user_id: null });

            expect(res.status).toBe(200);
            expect(mockDb.auth.admin.deleteUser).not.toHaveBeenCalled();
        });

        it('returns 404 for an unknown store and 403 for a non-owner', async () => {
            mockDb.on('stores', { data: null, error: null });
            expect((await request(app).post('/api/branches/reset-credentials').send(body)).status).toBe(404);

            mockDb.on('stores', { data: { owner_id: 'other' }, error: null });
            expect((await request(app).post('/api/branches/reset-credentials').send(body)).status).toBe(403);
        });

        it('validates the new email BEFORE removing the current manager', async () => {
            // A malformed new_email must abort with the old manager still intact,
            // otherwise the store is left with nobody who can sign in.
            ownedStore();

            const res = await request(app).post('/api/branches/reset-credentials')
                .send({ ...body, new_email: 'bad-email' });

            expect(res.status).toBe(400);
            expect(res.body).toEqual({ error: 'Invalid email format' });
            expect(mockDb.auth.admin.deleteUser).not.toHaveBeenCalled();
            expect(mockDb.callsForOp('store_members', 'delete')).toHaveLength(0);
            expect(mockDb.callsFor('store_credentials')).toHaveLength(0);
        });

        it('returns 500 when creating the replacement user fails', async () => {
            ownedStore();
            mockDb.auth.admin.createUser.mockResolvedValue({ data: null, error: { message: 'weak password' } });

            const res = await request(app).post('/api/branches/reset-credentials').send(body);

            expect(res.status).toBe(500);
            expect(res.body).toEqual({ error: 'weak password' });
        });
    });

    describe('GET /:storeId/credentials', () => {
        const { encrypt } = require('../../utils/crypto');

        function ownedStore() {
            return mockDb.on('stores', { data: { id: STORE_ID, owner_id: OWNER.id }, error: null });
        }

        it('returns the manager email with the password decrypted server-side', async () => {
            ownedStore();
            mockDb.on('store_credentials', {
                data: [{ email: 'manager@test.dev', password_encrypted: encrypt('secret123') }],
                error: null
            });

            const res = await request(app).get(`/api/branches/${STORE_ID}/credentials`);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({
                success: true,
                data: { email: 'manager@test.dev', password: 'secret123' }
            });
        });

        it('reads the newest credential row for that store', async () => {
            ownedStore();
            mockDb.on('store_credentials', { data: [{ email: 'a@b.c', password_encrypted: encrypt('x') }], error: null });

            await request(app).get(`/api/branches/${STORE_ID}/credentials`);

            const [call] = mockDb.callsFor('store_credentials');
            expect(filterArgs(call, 'eq')).toContainEqual(['store_id', STORE_ID]);
            expect(call.filters).toContainEqual({ name: 'order', args: ['created_at', { ascending: false }] });
            expect(call.filters).toContainEqual({ name: 'limit', args: [1] });
        });

        it('refuses anyone who is not the store owner', async () => {
            mockDb.on('stores', { data: { id: STORE_ID, owner_id: 'someone-else' }, error: null });

            const res = await request(app).get(`/api/branches/${STORE_ID}/credentials`);

            expect(res.status).toBe(403);
            expect(res.body).toEqual({ error: 'Not authorized' });
            expect(mockDb.callsFor('store_credentials')).toHaveLength(0);
        });

        it('returns 404 for an unknown store', async () => {
            mockDb.on('stores', { data: null, error: null });

            const res = await request(app).get(`/api/branches/${STORE_ID}/credentials`);

            expect(res.status).toBe(404);
            expect(res.body).toEqual({ error: 'Store not found' });
        });

        it('returns 404 when the store has no stored credentials', async () => {
            ownedStore();
            mockDb.on('store_credentials', { data: [], error: null });

            const res = await request(app).get(`/api/branches/${STORE_ID}/credentials`);

            expect(res.status).toBe(404);
            expect(res.body).toEqual({ error: 'No credentials stored for this store' });
        });

        it('reports a null password for a legacy row it cannot decrypt', async () => {
            ownedStore();
            mockDb.on('store_credentials', { data: [{ email: 'a@b.c', password_encrypted: 'bGVnYWN5WE9S' }], error: null });

            const res = await request(app).get(`/api/branches/${STORE_ID}/credentials`);

            expect(res.status).toBe(200);
            expect(res.body.data).toEqual({ email: 'a@b.c', password: null });
        });

        it('never returns the stored ciphertext to the client', async () => {
            ownedStore();
            const ciphertext = encrypt('secret123');
            mockDb.on('store_credentials', { data: [{ email: 'a@b.c', password_encrypted: ciphertext }], error: null });

            const res = await request(app).get(`/api/branches/${STORE_ID}/credentials`);

            expect(JSON.stringify(res.body)).not.toContain(ciphertext);
        });

        it('returns 500 when the store lookup throws', async () => {
            mockDb.on('stores', () => { throw new Error('db down'); });

            const res = await request(app).get(`/api/branches/${STORE_ID}/credentials`);

            expect(res.status).toBe(500);
            expect(res.body).toEqual({ error: 'db down' });
        });
    });

    describe('POST /upload-image', () => {
        const png = Buffer.from('89504e470d0a1a0a', 'hex');

        function ownedStore() {
            return mockDb.on('stores', (state) =>
                state.op === 'select' ? { data: { id: STORE_ID, owner_id: OWNER.id }, error: null } : { data: null, error: null });
        }

        it('uploads the file and saves the public URL on the store', async () => {
            ownedStore();

            const res = await request(app).post('/api/branches/upload-image')
                .field('store_id', STORE_ID)
                .attach('image', png, 'logo.png');

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.imageUrl).toContain('store_images');

            expect(mockDb.storage.from).toHaveBeenCalledWith('store_images');
            const [storeUpdate] = mockDb.callsForOp('stores', 'update');
            expect(storeUpdate.payload).toEqual({ image_url: res.body.imageUrl });
            expect(filterArgs(storeUpdate, 'eq')).toContainEqual(['id', STORE_ID]);
        });

        it('namespaces the object under the store id and keeps the file extension', async () => {
            const upload = jest.fn(async () => ({ data: { path: 'p' }, error: null }));
            mockDb.setStorage('store_images', { upload });
            ownedStore();

            await request(app).post('/api/branches/upload-image')
                .field('store_id', STORE_ID)
                .attach('image', png, 'my.logo.png');

            const [path, buffer, options] = upload.mock.calls[0];
            expect(path).toMatch(new RegExp(`^${STORE_ID}/\\d+_\\d+\\.png$`));
            expect(Buffer.isBuffer(buffer)).toBe(true);
            expect(options).toMatchObject({ upsert: true });
        });

        it('lets a store member upload as well as the owner', async () => {
            mockDb
                .on('stores', (state) => (state.op === 'select' ? { data: { owner_id: 'someone-else' }, error: null } : { data: null, error: null }))
                .on('store_members', { data: { id: 'member-1' }, error: null });

            const res = await request(app).post('/api/branches/upload-image')
                .field('store_id', STORE_ID)
                .attach('image', png, 'logo.png');

            expect(res.status).toBe(200);
        });

        it('rejects a user who is neither owner nor member', async () => {
            mockDb
                .on('stores', { data: { owner_id: 'someone-else' }, error: null })
                .on('store_members', { data: null, error: null });

            const res = await request(app).post('/api/branches/upload-image')
                .field('store_id', STORE_ID)
                .attach('image', png, 'logo.png');

            expect(res.status).toBe(403);
            expect(mockDb.storage.from).not.toHaveBeenCalled();
        });

        it('requires both a store id and a file', async () => {
            const noStore = await request(app).post('/api/branches/upload-image').attach('image', png, 'logo.png');
            expect(noStore.status).toBe(400);
            expect(noStore.body).toEqual({ error: 'Store ID is required' });

            const noFile = await request(app).post('/api/branches/upload-image').field('store_id', STORE_ID);
            expect(noFile.status).toBe(400);
            expect(noFile.body).toEqual({ error: 'No image file uploaded' });
        });

        it('returns 404 when the store does not exist', async () => {
            mockDb.on('stores', { data: null, error: null });

            const res = await request(app).post('/api/branches/upload-image')
                .field('store_id', STORE_ID)
                .attach('image', png, 'logo.png');

            expect(res.status).toBe(404);
        });

        it('returns 500 when the storage upload fails', async () => {
            mockDb.setStorage('store_images', { upload: async () => ({ data: null, error: { message: 'bucket full' } }) });
            ownedStore();

            const res = await request(app).post('/api/branches/upload-image')
                .field('store_id', STORE_ID)
                .attach('image', png, 'logo.png');

            expect(res.status).toBe(500);
            expect(res.body).toEqual({ error: 'bucket full' });
        });

        it('returns 500 when saving the URL on the store fails', async () => {
            mockDb.on('stores', (state) =>
                state.op === 'select'
                    ? { data: { owner_id: OWNER.id }, error: null }
                    : { data: null, error: { message: 'store locked' } });

            const res = await request(app).post('/api/branches/upload-image')
                .field('store_id', STORE_ID)
                .attach('image', png, 'logo.png');

            expect(res.status).toBe(500);
            expect(res.body).toEqual({ error: 'store locked' });
        });
    });

    describe('DELETE /delete', () => {
        function ownedStoreWith(overrides = {}) {
            mockDb.on('stores', (state) =>
                state.op === 'select'
                    ? { data: { id: STORE_ID, owner_id: OWNER.id, name: 'ร้านทดสอบ' }, error: null }
                    : { data: null, error: null });
            mockDb.on('store_members', { data: overrides.members ?? [], error: null });
            mockDb.on('orders', (state) => (state.op === 'select' ? { data: overrides.orders ?? [], error: null } : { data: null, error: null }));
            mockDb.on('products', (state) => (state.op === 'select' ? { data: overrides.products ?? [], error: null } : { data: null, error: null }));
            mockDb.on('promotions', (state) => (state.op === 'select' ? { data: overrides.promotions ?? [], error: null } : { data: null, error: null }));
        }

        it('deletes the store and confirms with its name', async () => {
            ownedStoreWith();

            const res = await request(app).delete('/api/branches/delete').send({ store_id: STORE_ID });

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ success: true, message: 'Store "ร้านทดสอบ" deleted successfully' });
        });

        it('purges every store-scoped table before removing the store itself', async () => {
            ownedStoreWith();

            await request(app).delete('/api/branches/delete').send({ store_id: STORE_ID });

            const order = mockDb.calls.map((c) => `${c.table}:${c.op}`);
            const storeDelete = order.lastIndexOf('stores:delete');
            for (const table of [
                'store_members', 'store_credentials', 'ai_recommendations', 'notifications',
                'backup_logs', 'account_transactions', 'orders', 'promotions',
                'customers_info', 'products', 'product_categories', 'store_order_counters'
            ]) {
                expect(order.indexOf(`${table}:delete`)).toBeGreaterThan(-1);
                expect(order.indexOf(`${table}:delete`)).toBeLessThan(storeDelete);
            }
        });

        it('deletes the manager auth accounts linked to the store', async () => {
            ownedStoreWith({ members: [{ user_id: 'm1' }, { user_id: 'm2' }] });

            await request(app).delete('/api/branches/delete').send({ store_id: STORE_ID });

            expect(mockDb.auth.admin.deleteUser).toHaveBeenCalledWith('m1');
            expect(mockDb.auth.admin.deleteUser).toHaveBeenCalledWith('m2');
        });

        it('continues the purge when one manager account cannot be deleted', async () => {
            ownedStoreWith({ members: [{ user_id: 'm1' }] });
            mockDb.auth.admin.deleteUser.mockRejectedValue(new Error('user gone'));

            const res = await request(app).delete('/api/branches/delete').send({ store_id: STORE_ID });

            expect(res.status).toBe(200);
            expect(logSpy).toHaveBeenCalledWith('Could not delete user:', 'm1', 'user gone');
        });

        it('cascades order children before deleting the orders', async () => {
            ownedStoreWith({ orders: [{ id: 'o1' }, { id: 'o2' }] });

            await request(app).delete('/api/branches/delete').send({ store_id: STORE_ID });

            for (const table of ['payments', 'order_items', 'credit_accounts']) {
                expect(mockDb.callsForOp(table, 'delete')[0].filters)
                    .toContainEqual({ name: 'in', args: ['order_id', ['o1', 'o2']] });
            }
        });

        it('skips the order-children step when the store has no orders', async () => {
            ownedStoreWith({ orders: [] });

            await request(app).delete('/api/branches/delete').send({ store_id: STORE_ID });

            expect(mockDb.callsFor('payments')).toHaveLength(0);
            expect(mockDb.callsFor('order_items')).toHaveLength(0);
        });

        it('cascades product children and promotion items', async () => {
            ownedStoreWith({ products: [{ id: 'p1' }], promotions: [{ id: 'promo-1' }] });

            await request(app).delete('/api/branches/delete').send({ store_id: STORE_ID });

            expect(mockDb.callsForOp('inventory_transactions', 'delete')[0].filters)
                .toContainEqual({ name: 'in', args: ['product_id', ['p1']] });
            expect(mockDb.callsForOp('product_batches', 'delete')[0].filters)
                .toContainEqual({ name: 'in', args: ['product_id', ['p1']] });
            expect(mockDb.callsForOp('promotion_items', 'delete')[0].filters)
                .toContainEqual({ name: 'in', args: ['promotion_id', ['promo-1']] });
        });

        it('removes soft-deleted products too, leaving no orphans behind', async () => {
            ownedStoreWith({ products: [{ id: 'p1' }] });

            await request(app).delete('/api/branches/delete').send({ store_id: STORE_ID });

            const [lookup] = mockDb.callsFor('products');
            expect(lookup.filters).not.toContainEqual({ name: 'is', args: ['deleted_at', null] });

            const [del] = mockDb.callsForOp('products', 'delete');
            expect(del.filters).not.toContainEqual({ name: 'is', args: ['deleted_at', null] });
            expect(filterArgs(del, 'eq')).toContainEqual(['store_id', STORE_ID]);
        });

        it('returns 404 for an unknown store and 403 for a non-owner', async () => {
            mockDb.on('stores', { data: null, error: null });
            const missing = await request(app).delete('/api/branches/delete').send({ store_id: STORE_ID });
            expect(missing.status).toBe(404);

            mockDb.on('stores', { data: { owner_id: 'other' }, error: null });
            const forbidden = await request(app).delete('/api/branches/delete').send({ store_id: STORE_ID });
            expect(forbidden.status).toBe(403);
            expect(forbidden.body).toEqual({ error: 'Not authorized - only owner can delete' });
        });

        it('returns 500 when the final store delete fails', async () => {
            ownedStoreWith();
            mockDb.on('stores', (state) =>
                state.op === 'select'
                    ? { data: { owner_id: OWNER.id, name: 'ร้าน' }, error: null }
                    : { data: null, error: { message: 'FK still referenced' } });

            const res = await request(app).delete('/api/branches/delete').send({ store_id: STORE_ID });

            expect(res.status).toBe(500);
            expect(res.body).toEqual({ error: 'FK still referenced' });
        });
    });
});
