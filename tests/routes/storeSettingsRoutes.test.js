const request = require('supertest');
const { registerStoreSettingsRoutes } = require('../../routes/storeSettingsRoutes');
const { createMockSupabase, filterArgs } = require('../helpers/mockSupabase');
const { createTestApp, allowAccess, denyAccess, STORE_ID, storeHeader } = require('../helpers/testApp');

const OWNER_ID = 'user-1';

describe('routes/storeSettingsRoutes', () => {
    let supabaseAdmin;
    let encrypt;
    let decrypt;
    let promptpay;
    let errorSpy;

    beforeEach(() => {
        supabaseAdmin = createMockSupabase();
        encrypt = jest.fn((v) => (v ? `enc(${v})` : null));
        decrypt = jest.fn((v) => (v ? String(v).replace(/^enc\(|\)$/g, '') : null));
        promptpay = jest.fn(() => '00020101021129370016A0000006770101110113006681234567');
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => errorSpy.mockRestore());

    const app = (checkStoreAccess = allowAccess) =>
        createTestApp(registerStoreSettingsRoutes, { supabaseAdmin, encrypt, decrypt, promptpay, checkStoreAccess });

    describe('GET /api/stores/settings', () => {
        it('returns the full PromptPay id to the store owner', async () => {
            supabaseAdmin.on('stores', {
                data: { owner_id: OWNER_ID, promptpay_id_enc: 'enc(0812345678)', promptpay_type: 'phone', promptpay_name: 'ร้านทดสอบ' },
                error: null
            });

            const res = await request(app()).get('/api/stores/settings').set(storeHeader);

            expect(res.status).toBe(200);
            expect(res.body.data).toEqual({
                promptpay_id: '0812345678',
                promptpay_type: 'phone',
                promptpay_name: 'ร้านทดสอบ',
                role: 'owner'
            });
        });

        it('masks a phone PromptPay id for a non-owner member', async () => {
            supabaseAdmin
                .on('stores', { data: { owner_id: 'someone-else', promptpay_id_enc: 'enc(0812345678)', promptpay_type: 'phone' }, error: null })
                .on('store_members', { data: { role: 'manager' }, error: null });

            const res = await request(app()).get('/api/stores/settings').set(storeHeader);

            expect(res.body.data.role).toBe('manager');
            expect(res.body.data.promptpay_id).toBe('081-xxx-5678');
            expect(res.body.data.promptpay_id).not.toBe('0812345678');
        });

        it('masks an id_card PromptPay id for a non-owner member', async () => {
            supabaseAdmin
                .on('stores', { data: { owner_id: 'other', promptpay_id_enc: 'enc(1234567890123)', promptpay_type: 'id_card' }, error: null })
                .on('store_members', { data: { role: 'manager' }, error: null });

            const res = await request(app()).get('/api/stores/settings').set(storeHeader);

            expect(res.body.data.promptpay_id).toBe('x-xxxx-xxxxx-123');
        });

        it('falls back to a fully masked placeholder when the id is too short for its type', async () => {
            supabaseAdmin
                .on('stores', { data: { owner_id: 'other', promptpay_id_enc: 'enc(0812)', promptpay_type: 'phone' }, error: null })
                .on('store_members', { data: { role: 'staff' }, error: null });

            const res = await request(app()).get('/api/stores/settings').set(storeHeader);

            expect(res.body.data.promptpay_id).toBe('xxx-xxx-xxxx');
        });

        it('returns an empty id when the store has no PromptPay configured', async () => {
            supabaseAdmin.on('stores', { data: { owner_id: OWNER_ID, promptpay_id_enc: null }, error: null });

            const res = await request(app()).get('/api/stores/settings').set(storeHeader);

            expect(res.status).toBe(200);
            expect(res.body.data.promptpay_id).toBe('');
        });

        it('rejects a user who is neither owner nor member', async () => {
            supabaseAdmin
                .on('stores', { data: { owner_id: 'other' }, error: null })
                .on('store_members', { data: null, error: null });

            const res = await request(app()).get('/api/stores/settings').set(storeHeader);

            expect(res.status).toBe(403);
            expect(res.body).toEqual({ success: false, error: 'Unauthorized' });
        });

        it('rejects a request with no store header before touching the database', async () => {
            const res = await request(app()).get('/api/stores/settings');

            expect(res.status).toBe(400);
            expect(supabaseAdmin.from).not.toHaveBeenCalled();
        });

        it('returns 404 when the store row is missing', async () => {
            supabaseAdmin
                .on('stores', { data: null, error: null })
                .on('store_members', { data: { role: 'manager' }, error: null });

            const res = await request(app()).get('/api/stores/settings').set(storeHeader);

            expect(res.status).toBe(404);
            expect(res.body).toEqual({ success: false, error: 'Store not found' });
            // The member lookup is never reached - there is no store to be a member of.
            expect(supabaseAdmin.callsFor('store_members')).toHaveLength(0);
        });

        it('returns 500 when the lookup throws', async () => {
            supabaseAdmin.on('stores', () => { throw new Error('db down'); });

            const res = await request(app()).get('/api/stores/settings').set(storeHeader);

            expect(res.status).toBe(500);
            expect(res.body).toEqual({ success: false, error: 'db down' });
        });
    });

    describe('PUT /api/stores/settings', () => {
        const body = { promptpay_id: '0812345678', promptpay_type: 'phone', promptpay_name: 'ร้านทดสอบ' };

        it('encrypts the PromptPay id before writing it', async () => {
            supabaseAdmin.on('stores', (state) =>
                state.op === 'select' ? { data: { owner_id: OWNER_ID }, error: null } : { data: null, error: null });

            const res = await request(app()).put('/api/stores/settings').set(storeHeader).send(body);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ success: true, message: 'Settings updated successfully' });
            expect(encrypt).toHaveBeenCalledWith('0812345678');

            const update = supabaseAdmin.callsForOp('stores', 'update')[0];
            expect(update.payload).toEqual({
                promptpay_id_enc: 'enc(0812345678)',
                promptpay_type: 'phone',
                promptpay_name: 'ร้านทดสอบ'
            });
            expect(filterArgs(update, 'eq')).toContainEqual(['id', STORE_ID]);
        });

        it('never stores the raw PromptPay id', async () => {
            supabaseAdmin.on('stores', (state) =>
                state.op === 'select' ? { data: { owner_id: OWNER_ID }, error: null } : { data: null, error: null });

            await request(app()).put('/api/stores/settings').set(storeHeader).send(body);

            expect(JSON.stringify(supabaseAdmin.callsForOp('stores', 'update')[0].payload)).not.toContain('"0812345678"');
        });

        it('refuses a manager - owner only', async () => {
            supabaseAdmin.on('stores', { data: { owner_id: 'someone-else' }, error: null });

            const res = await request(app()).put('/api/stores/settings').set(storeHeader).send(body);

            expect(res.status).toBe(403);
            expect(res.body).toEqual({ success: false, error: 'Only Store Owner can edit payment settings' });
            expect(supabaseAdmin.callsForOp('stores', 'update')).toHaveLength(0);
        });

        it('refuses when the store does not exist', async () => {
            supabaseAdmin.on('stores', { data: null, error: null });

            const res = await request(app()).put('/api/stores/settings').set(storeHeader).send(body);

            expect(res.status).toBe(403);
        });

        it('rejects a request with no store header', async () => {
            const res = await request(app()).put('/api/stores/settings').send(body);

            expect(res.status).toBe(400);
            expect(supabaseAdmin.from).not.toHaveBeenCalled();
        });

        it('stores null when the owner clears the PromptPay id', async () => {
            supabaseAdmin.on('stores', (state) =>
                state.op === 'select' ? { data: { owner_id: OWNER_ID }, error: null } : { data: null, error: null });

            await request(app()).put('/api/stores/settings').set(storeHeader).send({ ...body, promptpay_id: '' });

            expect(supabaseAdmin.callsForOp('stores', 'update')[0].payload.promptpay_id_enc).toBeNull();
        });

        it('returns 500 when the update fails', async () => {
            supabaseAdmin.on('stores', (state) =>
                state.op === 'select' ? { data: { owner_id: OWNER_ID }, error: null } : { data: null, error: { message: 'write failed' } });

            const res = await request(app()).put('/api/stores/settings').set(storeHeader).send(body);

            expect(res.status).toBe(500);
            expect(res.body).toEqual({ success: false, error: 'write failed' });
        });
    });

    describe('POST /api/sales/qr-payload', () => {
        it('builds a PromptPay payload from the decrypted id and the amount', async () => {
            supabaseAdmin.on('stores', { data: { promptpay_id_enc: 'enc(0812345678)', promptpay_type: 'phone' }, error: null });

            const res = await request(app()).post('/api/sales/qr-payload').set(storeHeader).send({ amount: '125.50' });

            expect(res.status).toBe(200);
            expect(promptpay).toHaveBeenCalledWith('0812345678', { amount: 125.5 });
            expect(res.body).toEqual({ success: true, payload: promptpay.mock.results[0].value });
        });

        it('lets a manager generate a QR (access check, not owner check)', async () => {
            const check = jest.fn(async () => true);
            supabaseAdmin.on('stores', { data: { promptpay_id_enc: 'enc(0812345678)' }, error: null });

            const res = await request(app(check)).post('/api/sales/qr-payload').set(storeHeader).send({ amount: 10 });

            expect(check).toHaveBeenCalledWith(STORE_ID, OWNER_ID);
            expect(res.status).toBe(200);
        });

        it('rejects a user without store access', async () => {
            const res = await request(app(denyAccess)).post('/api/sales/qr-payload').set(storeHeader).send({ amount: 10 });

            expect(res.status).toBe(403);
            expect(supabaseAdmin.from).not.toHaveBeenCalled();
        });

        it('rejects a request with no store header', async () => {
            const res = await request(app()).post('/api/sales/qr-payload').send({ amount: 10 });

            expect(res.status).toBe(400);
        });

        it('returns 400 when the store has not set up PromptPay', async () => {
            supabaseAdmin.on('stores', { data: { promptpay_id_enc: null }, error: null });

            const res = await request(app()).post('/api/sales/qr-payload').set(storeHeader).send({ amount: 10 });

            expect(res.status).toBe(400);
            expect(res.body).toEqual({ success: false, error: 'Store has not set up PromptPay yet' });
            expect(promptpay).not.toHaveBeenCalled();
        });

        it('returns 400 when the store row is missing', async () => {
            supabaseAdmin.on('stores', { data: null, error: null });

            const res = await request(app()).post('/api/sales/qr-payload').set(storeHeader).send({ amount: 10 });

            expect(res.status).toBe(400);
        });

        it('returns 500 when the stored id cannot be decrypted', async () => {
            supabaseAdmin.on('stores', { data: { promptpay_id_enc: 'corrupted' }, error: null });
            decrypt.mockReturnValue(null);

            const res = await request(app()).post('/api/sales/qr-payload').set(storeHeader).send({ amount: 10 });

            expect(res.status).toBe(500);
            expect(res.body).toEqual({ success: false, error: 'Decryption failed' });
            expect(promptpay).not.toHaveBeenCalled();
        });

        it('returns 500 when payload generation throws', async () => {
            supabaseAdmin.on('stores', { data: { promptpay_id_enc: 'enc(0812345678)' }, error: null });
            promptpay.mockImplementation(() => { throw new Error('invalid target'); });

            const res = await request(app()).post('/api/sales/qr-payload').set(storeHeader).send({ amount: 10 });

            expect(res.status).toBe(500);
            expect(res.body).toEqual({ success: false, error: 'invalid target' });
        });

        it('passes NaN through to the QR library when the amount is not a number', async () => {
            // Documented gap: the handler does not validate `amount` before parseFloat.
            supabaseAdmin.on('stores', { data: { promptpay_id_enc: 'enc(0812345678)' }, error: null });

            await request(app()).post('/api/sales/qr-payload').set(storeHeader).send({ amount: 'abc' });

            expect(promptpay).toHaveBeenCalledWith('0812345678', { amount: NaN });
        });
    });
});
