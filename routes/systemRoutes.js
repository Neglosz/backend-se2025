const registerSystemRoutes = ({ app, authMiddleware, supabaseAdmin }) => {
app.post('/api/admin/migrate-add-tendered', authMiddleware, async (req, res) => {
    try {
        res.json({ message: "Use the agent tool to migrate." });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


app.get('/api/debug/whoami', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const headerStoreId = req.headers['x-store-id'];

        // 1. Get Stores owned by this user
        const { data: stores } = await supabaseAdmin.from('stores').select('*').eq('owner_id', userId);

        // 2. Count products in the requested store (if any)
        let storeProductCount = 0;
        if (headerStoreId) {
            const { count } = await supabaseAdmin
                .from('products')
                .select('*', { count: 'exact', head: true })
                .eq('store_id', headerStoreId);
            storeProductCount = count;
        }

        // 3. Count orphans (products with NO store)
        const { count: orphanCount } = await supabaseAdmin
            .from('products')
            .select('*', { count: 'exact', head: true })
            .is('store_id', null);

        res.json({
            success: true,
            user: { id: userId, email: req.user.email },
            headerStoreId,
            ownedStores: stores,
            stats: {
                inThisStore: storeProductCount,
                orphans: orphanCount
            }
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
};

module.exports = { registerSystemRoutes };
