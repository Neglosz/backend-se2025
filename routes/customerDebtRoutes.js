const registerCustomerDebtRoutes = ({
    app,
    supabaseAdmin,
    creditPaymentValidators,
    checkStoreAccess,
    signUrlIfNeeded,
    deleteNotificationGlobal
}) => {
app.get('/api/customers/search', async (req, res) => {
    try {
        const { q } = req.query;
        const storeId = req.headers['x-store-id'];

        if (!q || q.length < 2) {
            return res.json({ success: true, data: [] });
        }

        let query = supabaseAdmin
            .from('customers_info')
            .select('id, name, phone, image_url, due_date')
            .or(`name.ilike.%${q}%,phone.ilike.%${q}%`)
            .limit(5);

        // Filter by store_id if provided
        if (storeId) {
            if (!await checkStoreAccess(storeId, req.user.id)) {
                return res.status(403).json({ success: false, error: 'Unauthorized access to store' });
            }
            query = query.eq('store_id', storeId);
        } else {
            return res.status(400).json({ success: false, error: 'Store ID required' });
        }

        const { data, error } = await query;
        if (error) throw error;

        // Sign images
        const signedData = await Promise.all((data || []).map(async (c) => ({
            ...c,
            image_url: await signUrlIfNeeded(c.image_url, 'customers')
        })));

        res.json({ success: true, data: signedData });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/customers/with-debt', async (req, res) => {
    try {
        const storeId = req.headers['x-store-id'];

        let query = supabaseAdmin
            .from('credit_accounts')
            .select('*, customers_info!inner(id, name, phone, image_url, due_date), orders(order_no)')
            .in('status', ['unpaid', 'partial', 'overdue']);
        // .order('due_date', { ascending: true }); // Removed: Sort by customer due_date below

        // Filter by store_id if provided
        if (storeId) {
            if (!await checkStoreAccess(storeId, req.user.id)) {
                return res.status(403).json({ success: false, error: 'Unauthorized access to store' });
            }
            query = query.eq('customers_info.store_id', storeId);
        } else {
            return res.status(400).json({ success: false, error: 'Store ID required' });
        }

        const { data, error } = await query;
        if (error) throw error;
        const customerMap = {};
        for (const account of data) {
            const customerId = account.customer_id;
            if (!customerMap[customerId]) {
                customerMap[customerId] = {
                    id: customerId,
                    name: account.customers_info?.name,
                    phone: account.customers_info?.phone,
                    image_url: await signUrlIfNeeded(account.customers_info?.image_url, 'customers'),
                    due_date: account.customers_info?.due_date, // NEW
                    total_debt: 0,
                    accounts: []
                };
            }
            customerMap[customerId].total_debt += parseFloat(account.remaining_amount || 0);
            customerMap[customerId].accounts.push(account);
        }

        const customers = Object.values(customerMap).sort((a, b) => {
            // Sort customers by due_date ASC
            if (!a.due_date) return 1;
            if (!b.due_date) return -1;
            return new Date(a.due_date) - new Date(b.due_date);
        });
        res.json({ success: true, data: customers });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/customers/:id/pending-bills', async (req, res) => {
    try {
        const { id } = req.params;
        const storeId = req.headers['x-store-id'];

        if (!storeId) {
            return res.status(400).json({ success: false, error: 'Store ID required' });
        }

        if (!await checkStoreAccess(storeId, req.user.id)) {
            return res.status(403).json({ success: false, error: 'Unauthorized access to store' });
        }

        // Use supabaseAdmin to bypass RLS, but optionally verify store_id if needed.
        // For now, trusting customer_id as it comes from the UI which is already filtered.
        const { data, error } = await supabaseAdmin
            .from('credit_accounts')
            .select('*, customers_info!inner(store_id)')
            .eq('customer_id', id)
            .eq('customers_info.store_id', storeId)
            .in('status', ['unpaid', 'partial', 'overdue'])
            .order('created_at', { ascending: true }); // Changed from due_date
        if (error) throw error;

        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/credit-payments', creditPaymentValidators, async (req, res) => {
    try {
        const { customer_id, amount, payment_method } = req.body;
        const storeId = req.headers['x-store-id'];

        if (!storeId) {
            return res.status(400).json({ success: false, error: 'Store ID required' });
        }

        if (!await checkStoreAccess(storeId, req.user.id)) {
            return res.status(403).json({ success: false, error: 'Unauthorized access to store' });
        }

        let remainingPayment = parseFloat(amount);

        // Fetch all unpaid/partial bills for this customer, ordered by created_at ASC (oldest first)
        const { data: accounts, error: fetchError } = await supabaseAdmin
            .from('credit_accounts')
            .select('*, customers_info!inner(store_id)')
            .eq('customer_id', customer_id)
            .eq('customers_info.store_id', storeId)
            .in('status', ['unpaid', 'partial', 'overdue'])
            .order('created_at', { ascending: true }); // Changed from due_date

        if (fetchError) throw fetchError;

        if (!accounts || accounts.length === 0) {
            return res.json({ success: true, message: 'No pending bills' });
        }

        const payments = [];

        for (const account of accounts) {
            if (remainingPayment <= 0) break;

            const toPay = Math.min(remainingPayment, parseFloat(account.remaining_amount));

            // Create payment record
            const { data: payment, error: paymentError } = await supabaseAdmin
                .from('payments')
                .insert([{
                    order_id: account.order_id,
                    method: payment_method,
                    amount: toPay
                }])
                .select()
                .single();

            if (paymentError) throw paymentError;
            payments.push(payment);

            // AUTO-SYNC: Record Income in General Ledger
            await supabaseAdmin.from('account_transactions').insert([{
                store_id: storeId,
                trans_date: new Date().toISOString().split('T')[0],
                trans_type: 'income',
                category: 'debt_payment',
                description: `รับชำระหนี้ (ลูกค้าเก่า)`,
                amount: toPay,
                payment_method: payment_method,
                reference_order_id: account.order_id
            }]);

            // Update account status
            const newPaid = parseFloat(account.paid_amount) + toPay;
            const newRemaining = parseFloat(account.remaining_amount) - toPay;
            const newStatus = newRemaining <= 0.01 ? 'paid' : 'partial'; // Use epsilon for float comparison

            await supabaseAdmin
                .from('credit_accounts')
                .update({
                    paid_amount: newPaid,
                    remaining_amount: newRemaining,
                    status: newStatus
                })
                .eq('id', account.id);

            // Sync order status
            if (newStatus === 'paid') {
                await supabaseAdmin
                    .from('orders')
                    .update({ payment_status: 'paid' })
                    .eq('id', account.order_id);
            } else if (newStatus === 'partial') {
                await supabaseAdmin
                    .from('orders')
                    .update({ payment_status: 'partial' })
                    .eq('id', account.order_id);
            }

            remainingPayment -= toPay;
        }

        // AUTO-RESOLVE: Check if customer is now debt-free
        const { count: remainingDebtCount } = await supabaseAdmin
            .from('credit_accounts')
            .select('id', { count: 'exact', head: true })
            .eq('customer_id', customer_id)
            .in('status', ['unpaid', 'partial', 'overdue']);

        if (remainingDebtCount === 0) {
            await deleteNotificationGlobal(storeId, ['payment_overdue', 'payment_due_soon'], customer_id, 'customer');
        }

        res.json({ success: true, data: payments });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
})
};

module.exports = { registerCustomerDebtRoutes };
