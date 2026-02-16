const registerCustomerCrudRoutes = ({ app, supabaseAdmin, checkStoreAccess }) => {
app.put('/api/customers/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, phone } = req.body;
        const storeId = req.headers['x-store-id'];
        const userId = req.user.id;

        if (!storeId) {
            return res.status(400).json({ success: false, error: 'Store ID required' });
        }

        if (!await checkStoreAccess(storeId, userId)) {
            return res.status(403).json({ success: false, error: 'Unauthorized access to store' });
        }

        const { data, error } = await supabaseAdmin
            .from('customers_info')
            .update({ name, phone })
            .eq('id', id)
            .eq('store_id', storeId) // Security: Ensure belongs to store
            .select()
            .single();
        if (error) throw error;

        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/api/customers/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const storeId = req.headers['x-store-id'];
        const userId = req.user.id;

        if (!storeId) {
            return res.status(400).json({ success: false, error: 'Store ID required' });
        }

        if (!await checkStoreAccess(storeId, userId)) {
            return res.status(403).json({ success: false, error: 'Unauthorized access to store' });
        }

        const { error } = await supabaseAdmin
            .from('customers_info')
            .delete()
            .eq('id', id)
            .eq('store_id', storeId); // Security: Ensure belongs to store
        if (error) throw error;

        res.json({ success: true, message: 'Customer deleted successfully' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});
};

module.exports = { registerCustomerCrudRoutes };
