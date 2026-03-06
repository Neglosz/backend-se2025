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
                    .eq('store_id', headerStoreId)
                    .is('deleted_at', null);
                storeProductCount = count;
            }

            // 3. Count orphans (products with NO store)
            const { count: orphanCount } = await supabaseAdmin
                .from('products')
                .select('*', { count: 'exact', head: true })
                .is('store_id', null)
                .is('deleted_at', null);

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

    app.post('/api/admin/purge-deleted-products', authMiddleware, async (req, res) => {
        try {
            // 1. Purge Soft-Deleted Products (Older than 30 days)
            const thirtyDaysAgo = new Date();
            thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

            const { data: toDelete } = await supabaseAdmin
                .from('products')
                .select('id')
                .not('deleted_at', 'is', null)
                .lt('deleted_at', thirtyDaysAgo.toISOString());

            let deletedProductsCount = 0;
            if (toDelete && toDelete.length > 0) {
                const ids = toDelete.map(p => p.id);

                // ลบข้อมูลที่เกี่ยวข้องก่อน (ลำดับสำคัญ!)
                await supabaseAdmin.from('promotion_items').delete().in('product_id', ids);
                await supabaseAdmin.from('inventory_transactions').delete().in('product_id', ids);
                await supabaseAdmin.from('product_batches').delete().in('product_id', ids);
                // ลบสินค้าจริง
                await supabaseAdmin.from('products').delete().in('id', ids);
                
                deletedProductsCount = ids.length;
            }

            // 2. Auto-purge empty batches older than 2 years (Data Archiving/Purging)
            const twoYearsAgo = new Date();
            twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);

            const { data: oldBatches } = await supabaseAdmin
                .from('product_batches')
                .select('id')
                .eq('remaining_qty', 0)
                .lt('created_at', twoYearsAgo.toISOString())
                .limit(500); // Limit chunks to prevent memory issues

            let deletedBatchesCount = 0;
            if (oldBatches && oldBatches.length > 0) {
                const batchIds = oldBatches.map(b => b.id);
                
                // 2.1 Set batch_id to NULL in related tables to prevent FK constraint errors
                await supabaseAdmin.from('order_items').update({ batch_id: null }).in('batch_id', batchIds);
                await supabaseAdmin.from('inventory_transactions').update({ batch_id: null }).in('batch_id', batchIds);
                
                // 2.2 Delete the old empty batches
                await supabaseAdmin.from('product_batches').delete().in('id', batchIds);
                deletedBatchesCount = batchIds.length;
            }

            res.json({ 
                success: true, 
                deleted: deletedProductsCount, 
                deletedProducts: deletedProductsCount,
                deletedBatches: deletedBatchesCount 
            });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

};

module.exports = { registerSystemRoutes };
