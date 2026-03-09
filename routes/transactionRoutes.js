const registerTransactionRoutes = ({ app, supabaseAdmin, checkStoreAccess }) => {
app.get('/api/transactions', async (req, res) => {
    try {
        const storeId = req.headers['x-store-id'];
        const userId = req.user.id;
        const { type, startDate, endDate, limit = 50 } = req.query;

        if (!storeId) return res.status(400).json({ success: false, error: 'Store ID required' });
        if (!await checkStoreAccess(storeId, userId)) return res.status(403).json({ success: false, error: 'Unauthorized' });

        let query = supabaseAdmin
            .from('account_transactions')
            .select('*')
            .eq('store_id', storeId)
            .order('trans_date', { ascending: false })
            .order('created_at', { ascending: false })
            .limit(parseInt(limit));

        if (type && type !== 'all') {
            query = query.eq('trans_type', type);
        }

        if (startDate) query = query.gte('trans_date', startDate);
        if (endDate) query = query.lte('trans_date', endDate);

        const { data, error } = await query;
        if (error) throw error;

        res.json({ success: true, data });
    } catch (error) {
        console.error('Get Transactions Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Create Transaction (Expense or Extra Income)
app.post('/api/transactions', async (req, res) => {
    try {
        const storeId = req.headers['x-store-id'];
        const userId = req.user.id;
        const { trans_date, trans_type, category, description, amount, payment_method } = req.body;

        if (!storeId) return res.status(400).json({ success: false, error: 'Store ID required' });
        if (!await checkStoreAccess(storeId, userId)) return res.status(403).json({ success: false, error: 'Unauthorized' });

        const { data, error } = await supabaseAdmin
            .from('account_transactions')
            .insert([{
                store_id: storeId,
                trans_date: trans_date || new Date().toISOString().split('T')[0],
                trans_type, // 'income' or 'expense'
                category,
                description,
                amount,
                payment_method
            }])
            .select()
            .single();

        if (error) throw error;

        res.json({ success: true, data });
    } catch (error) {
        console.error('Create Transaction Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Delete/Void Transaction
app.delete('/api/transactions/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const storeId = req.headers['x-store-id'];
        const userId = req.user.id;

        if (!storeId) return res.status(400).json({ success: false, error: 'Store ID required' });
        if (!await checkStoreAccess(storeId, userId)) return res.status(403).json({ success: false, error: 'Unauthorized' });

        // Fetch the transaction first to check category and get amount
        const { data: txn, error: fetchError } = await supabaseAdmin
            .from('account_transactions')
            .select('*')
            .eq('id', id)
            .eq('store_id', storeId)
            .single();

        if (fetchError || !txn) return res.status(404).json({ success: false, error: 'Transaction not found' });

        // If debt_payment → rollback credit_accounts and payments
        if (txn.category === 'debt_payment' && txn.reference_order_id) {
            const orderId = txn.reference_order_id;
            const paidBack = parseFloat(txn.amount);

            // Fetch linked credit_account
            const { data: creditAccount } = await supabaseAdmin
                .from('credit_accounts')
                .select('*')
                .eq('order_id', orderId)
                .single();

            if (creditAccount) {
                const newPaid = Math.max(0, parseFloat(creditAccount.paid_amount) - paidBack);
                const newRemaining = parseFloat(creditAccount.remaining_amount) + paidBack;
                const newStatus = newPaid <= 0 ? 'unpaid' : 'partial';

                await supabaseAdmin
                    .from('credit_accounts')
                    .update({ paid_amount: newPaid, remaining_amount: newRemaining, status: newStatus })
                    .eq('id', creditAccount.id);

                await supabaseAdmin
                    .from('orders')
                    .update({ payment_status: newStatus === 'unpaid' ? 'pending' : 'partial' })
                    .eq('id', orderId);
            }

            // Delete the linked payment record (most recent matching amount for this order)
            const { data: linkedPayments } = await supabaseAdmin
                .from('payments')
                .select('id')
                .eq('order_id', orderId)
                .eq('amount', paidBack)
                .order('paid_at', { ascending: false })
                .limit(1);

            if (linkedPayments && linkedPayments.length > 0) {
                await supabaseAdmin.from('payments').delete().eq('id', linkedPayments[0].id);
            }
        }

        // Delete the account_transaction
        const { error } = await supabaseAdmin
            .from('account_transactions')
            .delete()
            .eq('id', id)
            .eq('store_id', storeId);

        if (error) throw error;

        res.json({ success: true });
    } catch (error) {
        console.error('Delete Transaction Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});
};

module.exports = { registerTransactionRoutes };
