const request = require('supertest');
const { registerCustomerDebtRoutes } = require('../../routes/customerDebtRoutes');
const { creditPaymentValidators } = require('../../middleware/validators');
const { createMockSupabase, filterArgs } = require('../helpers/mockSupabase');
const { createTestApp, allowAccess, denyAccess, STORE_ID, storeHeader } = require('../helpers/testApp');

describe('routes/customerDebtRoutes', () => {
    let supabaseAdmin;
    let signUrlIfNeeded;
    let deleteNotificationGlobal;

    beforeEach(() => {
        supabaseAdmin = createMockSupabase();
        signUrlIfNeeded = jest.fn(async (url) => (url ? `signed:${url}` : null));
        deleteNotificationGlobal = jest.fn(async () => true);
    });

    const app = (checkStoreAccess = allowAccess, validators = creditPaymentValidators) =>
        createTestApp(registerCustomerDebtRoutes, {
            supabaseAdmin,
            creditPaymentValidators: validators,
            checkStoreAccess,
            signUrlIfNeeded,
            deleteNotificationGlobal
        });

    describe('GET /api/customers/search', () => {
        it('returns matching customers with signed image URLs', async () => {
            supabaseAdmin.on('customers_info', {
                data: [{ id: 'c1', name: 'สมชาย', phone: '0812345678', image_url: 'store-1/c1.jpg' }],
                error: null
            });

            const res = await request(app()).get('/api/customers/search?q=สม').set(storeHeader);

            expect(res.status).toBe(200);
            expect(res.body.data[0].image_url).toBe('signed:store-1/c1.jpg');
            expect(signUrlIfNeeded).toHaveBeenCalledWith('store-1/c1.jpg', 'customers');
        });

        it('searches name and phone, capped at 5 results and scoped to the store', async () => {
            supabaseAdmin.on('customers_info', { data: [], error: null });

            await request(app()).get('/api/customers/search?q=081').set(storeHeader);

            const [call] = supabaseAdmin.callsFor('customers_info');
            expect(call.filters).toContainEqual({ name: 'or', args: ['name.ilike.%081%,phone.ilike.%081%'] });
            expect(call.filters).toContainEqual({ name: 'limit', args: [5] });
            expect(filterArgs(call, 'eq')).toContainEqual(['store_id', STORE_ID]);
        });

        it('short-circuits on a query shorter than 2 characters', async () => {
            for (const url of ['/api/customers/search', '/api/customers/search?q=a']) {
                // eslint-disable-next-line no-await-in-loop
                const res = await request(app()).get(url).set(storeHeader);
                expect(res.body).toEqual({ success: true, data: [] });
            }
            expect(supabaseAdmin.from).not.toHaveBeenCalled();
        });

        it('requires a store header even though the query runs first', async () => {
            const res = await request(app()).get('/api/customers/search?q=สม');

            expect(res.status).toBe(400);
            expect(res.body).toEqual({ success: false, error: 'Store ID required' });
        });

        it('rejects a user without store access', async () => {
            const res = await request(app(denyAccess)).get('/api/customers/search?q=สม').set(storeHeader);

            expect(res.status).toBe(403);
        });

        it('tolerates a customer with no image', async () => {
            supabaseAdmin.on('customers_info', { data: [{ id: 'c1', image_url: null }], error: null });

            const res = await request(app()).get('/api/customers/search?q=สม').set(storeHeader);

            expect(res.body.data[0].image_url).toBeNull();
        });

        it('returns 500 when the search fails', async () => {
            supabaseAdmin.on('customers_info', { data: null, error: { message: 'bad ilike' } });

            const res = await request(app()).get('/api/customers/search?q=สม').set(storeHeader);

            expect(res.status).toBe(500);
            expect(res.body).toEqual({ success: false, error: 'bad ilike' });
        });
    });

    describe('GET /api/customers/with-debt', () => {
        const accounts = [
            { customer_id: 'c1', remaining_amount: '100', customers_info: { name: 'A', phone: '1', image_url: 'a.jpg', due_date: '2025-03-10' } },
            { customer_id: 'c1', remaining_amount: '50.5', customers_info: { name: 'A', phone: '1', image_url: 'a.jpg', due_date: '2025-03-10' } },
            { customer_id: 'c2', remaining_amount: '20', customers_info: { name: 'B', phone: '2', image_url: null, due_date: '2025-01-01' } }
        ];

        it('groups accounts per customer and sums the outstanding debt', async () => {
            supabaseAdmin.on('credit_accounts', { data: accounts, error: null });

            const res = await request(app()).get('/api/customers/with-debt').set(storeHeader);

            expect(res.status).toBe(200);
            const byId = Object.fromEntries(res.body.data.map((c) => [c.id, c]));
            expect(byId.c1.total_debt).toBeCloseTo(150.5);
            expect(byId.c1.accounts).toHaveLength(2);
            expect(byId.c2.total_debt).toBe(20);
        });

        it('sorts customers by due date, oldest first', async () => {
            supabaseAdmin.on('credit_accounts', { data: accounts, error: null });

            const res = await request(app()).get('/api/customers/with-debt').set(storeHeader);

            expect(res.body.data.map((c) => c.id)).toEqual(['c2', 'c1']);
        });

        it('pushes customers with no due date to the end', async () => {
            supabaseAdmin.on('credit_accounts', {
                data: [
                    { customer_id: 'c1', remaining_amount: '10', customers_info: { due_date: null } },
                    { customer_id: 'c2', remaining_amount: '10', customers_info: { due_date: '2025-05-05' } }
                ],
                error: null
            });

            const res = await request(app()).get('/api/customers/with-debt').set(storeHeader);

            expect(res.body.data.map((c) => c.id)).toEqual(['c2', 'c1']);
        });

        it('only reads unsettled statuses, scoped to the store', async () => {
            supabaseAdmin.on('credit_accounts', { data: [], error: null });

            await request(app()).get('/api/customers/with-debt').set(storeHeader);

            const [call] = supabaseAdmin.callsFor('credit_accounts');
            expect(call.filters).toContainEqual({ name: 'in', args: ['status', ['unpaid', 'partial', 'overdue']] });
            expect(filterArgs(call, 'eq')).toContainEqual(['customers_info.store_id', STORE_ID]);
        });

        it('treats a null remaining_amount as zero', async () => {
            supabaseAdmin.on('credit_accounts', {
                data: [{ customer_id: 'c1', remaining_amount: null, customers_info: { due_date: '2025-01-01' } }],
                error: null
            });

            const res = await request(app()).get('/api/customers/with-debt').set(storeHeader);

            expect(res.body.data[0].total_debt).toBe(0);
        });

        it('requires a store header and store access', async () => {
            expect((await request(app()).get('/api/customers/with-debt')).status).toBe(400);
            expect((await request(app(denyAccess)).get('/api/customers/with-debt').set(storeHeader)).status).toBe(403);
        });

        it('returns 500 when the query fails', async () => {
            supabaseAdmin.on('credit_accounts', { data: null, error: { message: 'join failed' } });

            const res = await request(app()).get('/api/customers/with-debt').set(storeHeader);

            expect(res.status).toBe(500);
        });
    });

    describe('GET /api/customers/:id/pending-bills', () => {
        it('returns the unsettled bills oldest first', async () => {
            const bills = [{ id: 'ca-1' }];
            supabaseAdmin.on('credit_accounts', { data: bills, error: null });

            const res = await request(app()).get('/api/customers/c1/pending-bills').set(storeHeader);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ success: true, data: bills });

            const [call] = supabaseAdmin.callsFor('credit_accounts');
            expect(filterArgs(call, 'eq')).toContainEqual(['customer_id', 'c1']);
            expect(filterArgs(call, 'eq')).toContainEqual(['customers_info.store_id', STORE_ID]);
            expect(call.filters).toContainEqual({ name: 'in', args: ['status', ['unpaid', 'partial', 'overdue']] });
            expect(call.filters).toContainEqual({ name: 'order', args: ['created_at', { ascending: true }] });
        });

        it('requires a store header and store access before querying', async () => {
            expect((await request(app()).get('/api/customers/c1/pending-bills')).status).toBe(400);
            expect((await request(app(denyAccess)).get('/api/customers/c1/pending-bills').set(storeHeader)).status).toBe(403);
            expect(supabaseAdmin.from).not.toHaveBeenCalled();
        });

        it('returns 500 when the query fails', async () => {
            supabaseAdmin.on('credit_accounts', { data: null, error: { message: 'boom' } });

            const res = await request(app()).get('/api/customers/c1/pending-bills').set(storeHeader);

            expect(res.status).toBe(500);
        });
    });

    describe('POST /api/credit-payments', () => {
        const body = { customer_id: 'c1', amount: 120, payment_method: 'cash' };

        /**
         * Serve the pending-bill list on the first credit_accounts read, a debt count
         * on the second, and let updates fall through.
         */
        function withAccounts(accounts, remainingDebtCount = 0) {
            let reads = 0;
            return supabaseAdmin.on('credit_accounts', (state) => {
                if (state.op !== 'select') return { data: null, error: null };
                reads += 1;
                return reads === 1
                    ? { data: accounts, error: null }
                    : { count: remainingDebtCount, data: null, error: null };
            });
        }

        it('applies the payment to the oldest bill first and records it', async () => {
            withAccounts([
                { id: 'ca-1', order_id: 'ord-1', remaining_amount: '100', paid_amount: '0', customers_info: { name: 'สมชาย' } },
                { id: 'ca-2', order_id: 'ord-2', remaining_amount: '80', paid_amount: '0', customers_info: { name: 'สมชาย' } }
            ]);
            supabaseAdmin.on('payments', { data: { id: 'pay-1' }, error: null });

            const res = await request(app()).post('/api/credit-payments').set(storeHeader).send(body);

            expect(res.status).toBe(200);
            const payments = supabaseAdmin.callsForOp('payments', 'insert');
            expect(payments.map((p) => p.payload[0].amount)).toEqual([100, 20]);
            expect(payments[0].payload[0]).toMatchObject({ order_id: 'ord-1', method: 'cash' });
        });

        it('closes a fully paid bill and leaves the partially paid one open', async () => {
            withAccounts([
                { id: 'ca-1', order_id: 'ord-1', remaining_amount: '100', paid_amount: '0', customers_info: {} },
                { id: 'ca-2', order_id: 'ord-2', remaining_amount: '80', paid_amount: '10', customers_info: {} }
            ]);
            supabaseAdmin.on('payments', { data: { id: 'pay-1' }, error: null });

            await request(app()).post('/api/credit-payments').set(storeHeader).send(body);

            const updates = supabaseAdmin.callsForOp('credit_accounts', 'update');
            expect(updates[0].payload).toEqual({ paid_amount: 100, remaining_amount: 0, status: 'paid' });
            expect(updates[1].payload).toEqual({ paid_amount: 30, remaining_amount: 60, status: 'partial' });

            const orderUpdates = supabaseAdmin.callsForOp('orders', 'update');
            expect(orderUpdates[0].payload).toEqual({ payment_status: 'paid' });
            expect(orderUpdates[1].payload).toEqual({ payment_status: 'partial' });
        });

        it('treats a residue below one satang as fully paid (float epsilon)', async () => {
            withAccounts([{ id: 'ca-1', order_id: 'ord-1', remaining_amount: '120.005', paid_amount: '0', customers_info: {} }]);
            supabaseAdmin.on('payments', { data: { id: 'pay-1' }, error: null });

            await request(app()).post('/api/credit-payments').set(storeHeader).send(body);

            expect(supabaseAdmin.callsForOp('credit_accounts', 'update')[0].payload.status).toBe('paid');
        });

        it('stops once the payment is exhausted, leaving later bills untouched', async () => {
            withAccounts([
                { id: 'ca-1', order_id: 'ord-1', remaining_amount: '120', paid_amount: '0', customers_info: {} },
                { id: 'ca-2', order_id: 'ord-2', remaining_amount: '80', paid_amount: '0', customers_info: {} }
            ]);
            supabaseAdmin.on('payments', { data: { id: 'pay-1' }, error: null });

            await request(app()).post('/api/credit-payments').set(storeHeader).send(body);

            expect(supabaseAdmin.callsForOp('payments', 'insert')).toHaveLength(1);
            expect(supabaseAdmin.callsForOp('credit_accounts', 'update')).toHaveLength(1);
        });

        it('mirrors every payment into the general ledger as income', async () => {
            withAccounts([{ id: 'ca-1', order_id: 'ord-1', remaining_amount: '120', paid_amount: '0', customers_info: { name: 'สมชาย' } }]);
            supabaseAdmin.on('payments', { data: { id: 'pay-1' }, error: null });

            await request(app()).post('/api/credit-payments').set(storeHeader).send(body);

            const [ledger] = supabaseAdmin.callsForOp('account_transactions', 'insert');
            expect(ledger.payload[0]).toMatchObject({
                store_id: STORE_ID,
                trans_type: 'income',
                category: 'debt_payment',
                description: 'รับชำระหนี้ - สมชาย',
                amount: 120,
                payment_method: 'cash',
                reference_order_id: 'ord-1'
            });
            expect(ledger.payload[0].trans_date).toBe(new Date().toISOString().split('T')[0]);
        });

        it('falls back to a generic ledger description when the customer name is missing', async () => {
            withAccounts([{ id: 'ca-1', order_id: 'ord-1', remaining_amount: '120', paid_amount: '0', customers_info: {} }]);
            supabaseAdmin.on('payments', { data: { id: 'pay-1' }, error: null });

            await request(app()).post('/api/credit-payments').set(storeHeader).send(body);

            expect(supabaseAdmin.callsForOp('account_transactions', 'insert')[0].payload[0].description)
                .toBe('รับชำระหนี้ - ลูกค้า');
        });

        it('clears the overdue notifications once the customer is debt-free', async () => {
            withAccounts([{ id: 'ca-1', order_id: 'ord-1', remaining_amount: '120', paid_amount: '0', customers_info: {} }], 0);
            supabaseAdmin.on('payments', { data: { id: 'pay-1' }, error: null });

            await request(app()).post('/api/credit-payments').set(storeHeader).send(body);

            expect(deleteNotificationGlobal).toHaveBeenCalledWith(
                STORE_ID, ['payment_overdue', 'payment_due_soon'], 'c1', 'customer'
            );
        });

        it('keeps the notifications while debt remains', async () => {
            withAccounts([{ id: 'ca-1', order_id: 'ord-1', remaining_amount: '500', paid_amount: '0', customers_info: {} }], 1);
            supabaseAdmin.on('payments', { data: { id: 'pay-1' }, error: null });

            await request(app()).post('/api/credit-payments').set(storeHeader).send(body);

            expect(deleteNotificationGlobal).not.toHaveBeenCalled();
        });

        it('reports "No pending bills" without writing anything', async () => {
            withAccounts([]);

            const res = await request(app()).post('/api/credit-payments').set(storeHeader).send(body);

            expect(res.body).toEqual({ success: true, message: 'No pending bills' });
            expect(supabaseAdmin.callsFor('payments')).toHaveLength(0);
            expect(deleteNotificationGlobal).not.toHaveBeenCalled();
        });

        it('runs the credit payment validators before the handler', async () => {
            const res = await request(app()).post('/api/credit-payments').set(storeHeader)
                .send({ ...body, payment_method: 'bitcoin' });

            expect(res.status).toBe(400);
            expect(res.body.error).toBe('Validation Error');
            expect(supabaseAdmin.from).not.toHaveBeenCalled();
        });

        it('requires a store header and store access', async () => {
            const noValidators = [];
            expect((await request(app(allowAccess, noValidators)).post('/api/credit-payments').send(body)).status).toBe(400);
            expect((await request(app(denyAccess, noValidators)).post('/api/credit-payments').set(storeHeader).send(body)).status).toBe(403);
        });

        it('returns 500 when creating the payment record fails', async () => {
            withAccounts([{ id: 'ca-1', order_id: 'ord-1', remaining_amount: '120', paid_amount: '0', customers_info: {} }]);
            supabaseAdmin.on('payments', { data: null, error: { message: 'insert failed' } });

            const res = await request(app()).post('/api/credit-payments').set(storeHeader).send(body);

            expect(res.status).toBe(500);
            expect(res.body).toEqual({ success: false, error: 'insert failed' });
        });

        it('returns 500 when the pending-bill lookup fails', async () => {
            supabaseAdmin.on('credit_accounts', { data: null, error: { message: 'select failed' } });

            const res = await request(app()).post('/api/credit-payments').set(storeHeader).send(body);

            expect(res.status).toBe(500);
        });
    });
});
