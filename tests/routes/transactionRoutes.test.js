const request = require('supertest');
const { registerTransactionRoutes } = require('../../routes/transactionRoutes');
const { createMockSupabase, filterArgs } = require('../helpers/mockSupabase');
const { createTestApp, allowAccess, denyAccess, STORE_ID, storeHeader } = require('../helpers/testApp');

describe('routes/transactionRoutes', () => {
    let supabaseAdmin;
    let errorSpy;

    beforeEach(() => {
        supabaseAdmin = createMockSupabase();
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => errorSpy.mockRestore());

    const app = (checkStoreAccess = allowAccess) =>
        createTestApp(registerTransactionRoutes, { supabaseAdmin, checkStoreAccess });

    describe('GET /api/transactions', () => {
        it('returns the store transactions', async () => {
            const rows = [{ id: 't1', amount: 100 }];
            supabaseAdmin.on('account_transactions', { data: rows, error: null });

            const res = await request(app()).get('/api/transactions').set(storeHeader);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ success: true, data: rows });
        });

        it('scopes to the store, sorts newest first and defaults to 50 rows', async () => {
            supabaseAdmin.on('account_transactions', { data: [], error: null });

            await request(app()).get('/api/transactions').set(storeHeader);

            const [call] = supabaseAdmin.callsFor('account_transactions');
            expect(filterArgs(call, 'eq')).toContainEqual(['store_id', STORE_ID]);
            expect(call.filters).toContainEqual({ name: 'order', args: ['trans_date', { ascending: false }] });
            expect(call.filters).toContainEqual({ name: 'order', args: ['created_at', { ascending: false }] });
            expect(call.filters).toContainEqual({ name: 'limit', args: [50] });
        });

        it('honours an explicit numeric limit from the query string', async () => {
            supabaseAdmin.on('account_transactions', { data: [], error: null });

            await request(app()).get('/api/transactions?limit=200').set(storeHeader);

            expect(supabaseAdmin.callsFor('account_transactions')[0].filters)
                .toContainEqual({ name: 'limit', args: [200] });
        });

        it('filters by trans_type, but treats "all" as no filter', async () => {
            supabaseAdmin.on('account_transactions', { data: [], error: null });

            await request(app()).get('/api/transactions?type=expense').set(storeHeader);
            await request(app()).get('/api/transactions?type=all').set(storeHeader);

            const [typed, all] = supabaseAdmin.callsFor('account_transactions');
            expect(filterArgs(typed, 'eq')).toContainEqual(['trans_type', 'expense']);
            expect(filterArgs(all, 'eq').some(([col]) => col === 'trans_type')).toBe(false);
        });

        it('applies startDate and endDate as an inclusive range', async () => {
            supabaseAdmin.on('account_transactions', { data: [], error: null });

            await request(app()).get('/api/transactions?startDate=2025-01-01&endDate=2025-01-31').set(storeHeader);

            const [call] = supabaseAdmin.callsFor('account_transactions');
            expect(filterArgs(call, 'gte')).toContainEqual(['trans_date', '2025-01-01']);
            expect(filterArgs(call, 'lte')).toContainEqual(['trans_date', '2025-01-31']);
        });

        it('applies only the bound that was supplied', async () => {
            supabaseAdmin.on('account_transactions', { data: [], error: null });

            await request(app()).get('/api/transactions?startDate=2025-01-01').set(storeHeader);

            const [call] = supabaseAdmin.callsFor('account_transactions');
            expect(filterArgs(call, 'gte')).toHaveLength(1);
            expect(filterArgs(call, 'lte')).toHaveLength(0);
        });

        it('rejects a missing store header and an unauthorized user', async () => {
            expect((await request(app()).get('/api/transactions')).status).toBe(400);
            expect((await request(app(denyAccess)).get('/api/transactions').set(storeHeader)).status).toBe(403);
            expect(supabaseAdmin.from).not.toHaveBeenCalled();
        });

        it('returns 500 when the query fails', async () => {
            supabaseAdmin.on('account_transactions', { data: null, error: { message: 'timeout' } });

            const res = await request(app()).get('/api/transactions').set(storeHeader);

            expect(res.status).toBe(500);
            expect(res.body).toEqual({ success: false, error: 'timeout' });
        });
    });

    describe('POST /api/transactions', () => {
        const body = {
            trans_date: '2025-03-01',
            trans_type: 'expense',
            category: 'utilities',
            description: 'ค่าไฟ',
            amount: 1200,
            payment_method: 'cash'
        };

        it('inserts the transaction against the header store and returns the row', async () => {
            supabaseAdmin.on('account_transactions', { data: { id: 't9', ...body }, error: null });

            const res = await request(app()).post('/api/transactions').set(storeHeader).send(body);

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(supabaseAdmin.callsFor('account_transactions')[0].payload[0]).toEqual({
                store_id: STORE_ID, ...body
            });
        });

        it('defaults trans_date to today when the client omits it', async () => {
            supabaseAdmin.on('account_transactions', { data: {}, error: null });

            await request(app()).post('/api/transactions').set(storeHeader).send({ ...body, trans_date: undefined });

            const row = supabaseAdmin.callsFor('account_transactions')[0].payload[0];
            expect(row.trans_date).toBe(new Date().toISOString().split('T')[0]);
        });

        it('rejects a missing store header and an unauthorized user', async () => {
            expect((await request(app()).post('/api/transactions').send(body)).status).toBe(400);
            expect((await request(app(denyAccess)).post('/api/transactions').set(storeHeader).send(body)).status).toBe(403);
            expect(supabaseAdmin.from).not.toHaveBeenCalled();
        });

        it('returns 500 when the insert fails', async () => {
            supabaseAdmin.on('account_transactions', { data: null, error: { message: 'check constraint' } });

            const res = await request(app()).post('/api/transactions').set(storeHeader).send(body);

            expect(res.status).toBe(500);
            expect(res.body).toEqual({ success: false, error: 'check constraint' });
        });
    });

    describe('DELETE /api/transactions/:id', () => {
        /** Answer the initial fetch with `txn`, then let later chains succeed. */
        function withTxn(txn) {
            let served = false;
            return supabaseAdmin.on('account_transactions', () => {
                if (!served) { served = true; return { data: txn, error: txn ? null : { message: 'not found' } }; }
                return { data: null, error: null };
            });
        }

        it('deletes a plain transaction scoped to the store', async () => {
            withTxn({ id: 't1', category: 'utilities', amount: 100 });

            const res = await request(app()).delete('/api/transactions/t1').set(storeHeader);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ success: true });

            const del = supabaseAdmin.callsForOp('account_transactions', 'delete')[0];
            expect(filterArgs(del, 'eq')).toContainEqual(['id', 't1']);
            expect(filterArgs(del, 'eq')).toContainEqual(['store_id', STORE_ID]);
        });

        it('returns 404 when the transaction does not belong to the store', async () => {
            withTxn(null);

            const res = await request(app()).delete('/api/transactions/t1').set(storeHeader);

            expect(res.status).toBe(404);
            expect(res.body).toEqual({ success: false, error: 'Transaction not found' });
            expect(supabaseAdmin.callsForOp('account_transactions', 'delete')).toHaveLength(0);
        });

        it('rolls a debt payment back onto the credit account and the order', async () => {
            withTxn({ id: 't1', category: 'debt_payment', reference_order_id: 'ord-1', amount: '300' });
            supabaseAdmin
                .on('credit_accounts', (state) => state.op === 'select'
                    ? { data: { id: 'ca-1', paid_amount: '500', remaining_amount: '200' }, error: null }
                    : { data: null, error: null })
                .on('payments', (state) => state.op === 'select' ? { data: [{ id: 'pay-1' }], error: null } : { data: null, error: null });

            const res = await request(app()).delete('/api/transactions/t1').set(storeHeader);

            expect(res.status).toBe(200);

            const creditUpdate = supabaseAdmin.callsForOp('credit_accounts', 'update')[0];
            expect(creditUpdate.payload).toEqual({ paid_amount: 200, remaining_amount: 500, status: 'partial' });
            expect(filterArgs(creditUpdate, 'eq')).toContainEqual(['id', 'ca-1']);

            const orderUpdate = supabaseAdmin.callsForOp('orders', 'update')[0];
            expect(orderUpdate.payload).toEqual({ payment_status: 'partial' });
            expect(filterArgs(orderUpdate, 'eq')).toContainEqual(['id', 'ord-1']);
        });

        it('marks the debt unpaid again when the rollback clears the whole paid amount', async () => {
            withTxn({ id: 't1', category: 'debt_payment', reference_order_id: 'ord-1', amount: '500' });
            supabaseAdmin
                .on('credit_accounts', (state) => state.op === 'select'
                    ? { data: { id: 'ca-1', paid_amount: '500', remaining_amount: '0' }, error: null }
                    : { data: null, error: null })
                .on('payments', { data: [], error: null });

            await request(app()).delete('/api/transactions/t1').set(storeHeader);

            expect(supabaseAdmin.callsForOp('credit_accounts', 'update')[0].payload).toEqual({
                paid_amount: 0, remaining_amount: 500, status: 'unpaid'
            });
            expect(supabaseAdmin.callsForOp('orders', 'update')[0].payload).toEqual({ payment_status: 'pending' });
        });

        it('never lets paid_amount go negative when the rollback exceeds what was paid', async () => {
            withTxn({ id: 't1', category: 'debt_payment', reference_order_id: 'ord-1', amount: '900' });
            supabaseAdmin
                .on('credit_accounts', (state) => state.op === 'select'
                    ? { data: { id: 'ca-1', paid_amount: '100', remaining_amount: '0' }, error: null }
                    : { data: null, error: null })
                .on('payments', { data: [], error: null });

            await request(app()).delete('/api/transactions/t1').set(storeHeader);

            expect(supabaseAdmin.callsForOp('credit_accounts', 'update')[0].payload.paid_amount).toBe(0);
        });

        it('deletes the newest matching payment record for that order and amount', async () => {
            withTxn({ id: 't1', category: 'debt_payment', reference_order_id: 'ord-1', amount: '300' });
            supabaseAdmin
                .on('credit_accounts', { data: null, error: null })
                .on('payments', (state) => state.op === 'select' ? { data: [{ id: 'pay-7' }], error: null } : { data: null, error: null });

            await request(app()).delete('/api/transactions/t1').set(storeHeader);

            const [lookup] = supabaseAdmin.callsFor('payments');
            expect(filterArgs(lookup, 'eq')).toContainEqual(['order_id', 'ord-1']);
            expect(filterArgs(lookup, 'eq')).toContainEqual(['amount', 300]);
            expect(lookup.filters).toContainEqual({ name: 'order', args: ['paid_at', { ascending: false }] });
            expect(lookup.filters).toContainEqual({ name: 'limit', args: [1] });

            expect(filterArgs(supabaseAdmin.callsForOp('payments', 'delete')[0], 'eq')).toContainEqual(['id', 'pay-7']);
        });

        it('still deletes the transaction when no credit account or payment is linked', async () => {
            withTxn({ id: 't1', category: 'debt_payment', reference_order_id: 'ord-1', amount: '300' });
            supabaseAdmin.on('credit_accounts', { data: null, error: null }).on('payments', { data: [], error: null });

            const res = await request(app()).delete('/api/transactions/t1').set(storeHeader);

            expect(res.status).toBe(200);
            expect(supabaseAdmin.callsForOp('credit_accounts', 'update')).toHaveLength(0);
            expect(supabaseAdmin.callsForOp('payments', 'delete')).toHaveLength(0);
            expect(supabaseAdmin.callsForOp('account_transactions', 'delete')).toHaveLength(1);
        });

        it('skips the rollback for a debt_payment with no linked order', async () => {
            withTxn({ id: 't1', category: 'debt_payment', reference_order_id: null, amount: '300' });

            await request(app()).delete('/api/transactions/t1').set(storeHeader);

            expect(supabaseAdmin.callsFor('credit_accounts')).toHaveLength(0);
            expect(supabaseAdmin.callsFor('payments')).toHaveLength(0);
        });

        it('rejects a missing store header and an unauthorized user', async () => {
            expect((await request(app()).delete('/api/transactions/t1')).status).toBe(400);
            expect((await request(app(denyAccess)).delete('/api/transactions/t1').set(storeHeader)).status).toBe(403);
            expect(supabaseAdmin.from).not.toHaveBeenCalled();
        });

        it('returns 500 when the final delete fails', async () => {
            let served = false;
            supabaseAdmin.on('account_transactions', () => {
                if (!served) { served = true; return { data: { id: 't1', category: 'utilities' }, error: null }; }
                return { data: null, error: { message: 'FK violation' } };
            });

            const res = await request(app()).delete('/api/transactions/t1').set(storeHeader);

            expect(res.status).toBe(500);
            expect(res.body).toEqual({ success: false, error: 'FK violation' });
        });
    });
});
