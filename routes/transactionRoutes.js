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

        const { error } = await supabaseAdmin
            .from('account_transactions')
            .delete()
            .eq('id', id)
            .eq('store_id', storeId); // Security

        if (error) throw error;

        res.json({ success: true });
    } catch (error) {
        console.error('Delete Transaction Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});
};

module.exports = { registerTransactionRoutes };
