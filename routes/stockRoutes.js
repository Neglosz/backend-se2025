const registerStockRoutes = ({
    app,
    supabaseAdmin,
    checkStoreAccess,
    upsertNotificationGlobal
}) => {
    app.get('/api/stock/stats', async (req, res) => {
        try {
            const storeId = req.headers['x-store-id'];
            const userId = req.user.id;

            if (!storeId) {
                return res.status(400).json({ success: false, error: 'Store ID required' });
            }

            if (!await checkStoreAccess(storeId, userId)) {
                return res.status(403).json({ success: false, error: 'ไม่มีสิทธิ์เข้าถึงข้อมูลของร้าน' });
            }

            // Count total products for this store
            const { count: totalProducts } = await supabaseAdmin
                .from('products')
                .select('*', { count: 'exact', head: true })
                .eq('store_id', storeId);

            // Count batches expiring within 30 days
            const thirtyDaysFromNow = new Date(new Date().getTime() + 7 * 60 * 60 * 1000);
            thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);
            const nowTh = new Date(new Date().getTime() + 7 * 60 * 60 * 1000);
            const today = nowTh.toISOString().split('T')[0];
            const expireLimit = thirtyDaysFromNow.toISOString().split('T')[0];

            const { data: nearExpiryBatches } = await supabaseAdmin
                .from('product_batches')
                .select(`
                id,
                products!inner(store_id)
            `)
                .eq('products.store_id', storeId)
                .gte('expire_date', today)
                .lte('expire_date', expireLimit)
                .gt('remaining_qty', 0);

            // Count expired batches
            const { data: expiredBatches } = await supabaseAdmin
                .from('product_batches')
                .select(`
                id,
                products!inner(store_id)
            `)
                .eq('products.store_id', storeId)
                .lt('expire_date', today)
                .gt('remaining_qty', 0);

            // Count products with stock below threshold
            const { data: lowStockProducts } = await supabaseAdmin
                .from('products')
                .select('id')
                .eq('store_id', storeId)
                .gt('low_stock_threshold', 0)
                .filter('stock_qty', 'lte', 'low_stock_threshold');

            // Count out of stock products
            const { count: outOfStockCount } = await supabaseAdmin
                .from('products')
                .select('*', { count: 'exact', head: true })
                .eq('store_id', storeId)
                .eq('stock_qty', 0);

            // Alternative query for low stock (RPC might be needed for complex comparison)
            // For now, fetch and filter in JS
            const { data: allProducts } = await supabaseAdmin
                .from('products')
                .select('id, stock_qty, low_stock_threshold')
                .eq('store_id', storeId)
                .gt('low_stock_threshold', 0);

            const lowStockCount = allProducts?.filter(p =>
                parseFloat(p.stock_qty) <= parseFloat(p.low_stock_threshold) && parseFloat(p.stock_qty) > 0
            ).length || 0;

            res.json({
                success: true,
                data: {
                    total: totalProducts || 0,
                    nearExpiry: nearExpiryBatches?.length || 0,
                    lowStock: lowStockCount,
                    expired: expiredBatches?.length || 0,
                    outOfStock: outOfStockCount || 0
                }
            });
        } catch (error) {
            console.error('Stock Stats Error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Get expired items (batch-level)
    app.get('/api/stock/expired', async (req, res) => {
        try {
            const storeId = req.headers['x-store-id'];
            const userId = req.user.id;

            if (!storeId) {
                return res.status(400).json({ success: false, error: 'Store ID required' });
            }

            if (!await checkStoreAccess(storeId, userId)) {
                return res.status(403).json({ success: false, error: 'Unauthorized access to store' });
            }

            const nowTh = new Date(new Date().getTime() + 7 * 60 * 60 * 1000);
            const today = nowTh.toISOString().split('T')[0];

            const { data, error } = await supabaseAdmin
                .from('product_batches')
                .select(`
                id,
                batch_no,
                expire_date,
                remaining_qty,
                products!inner(
                    id,
                    name,
                    image_url,
                    store_id,
                    unit_type
                )
            `)
                .eq('products.store_id', storeId)
                .lt('expire_date', today)
                .gt('remaining_qty', 0)
                .order('expire_date', { ascending: true })
                .limit(20);

            if (error) throw error;

            const formattedData = data?.map(batch => ({
                id: batch.id,
                productId: batch.products.id,
                name: batch.products.name,
                quantity: batch.remaining_qty,
                expireDate: batch.expire_date,
                batchNo: batch.batch_no,
                image: batch.products.image_url,
                unit: batch.products.unit_type
            })) || [];

            res.json({ success: true, data: formattedData });
        } catch (error) {
            console.error('Expired Error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Get out of stock items
    app.get('/api/stock/out-of-stock', async (req, res) => {
        try {
            const storeId = req.headers['x-store-id'];
            const userId = req.user.id;

            if (!storeId) {
                return res.status(400).json({ success: false, error: 'Store ID required' });
            }

            if (!await checkStoreAccess(storeId, userId)) {
                return res.status(403).json({ success: false, error: 'Unauthorized access to store' });
            }

            const { data, error } = await supabaseAdmin
                .from('products')
                .select('id, name, stock_qty, image_url, unit_type')
                .eq('store_id', storeId)
                .eq('stock_qty', 0)
                .order('name', { ascending: true })
                .limit(20);

            if (error) throw error;

            const formattedData = data?.map(p => ({
                id: p.id,
                name: p.name,
                quantity: p.stock_qty,
                image: p.image_url,
                unit: p.unit_type
            })) || [];

            res.json({ success: true, data: formattedData });
        } catch (error) {
            console.error('Out of Stock Error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Get near expiry items (batch-level)
    app.get('/api/stock/near-expiry', async (req, res) => {
        try {
            const storeId = req.headers['x-store-id'];
            const userId = req.user.id;

            if (!storeId) {
                return res.status(400).json({ success: false, error: 'Store ID required' });
            }

            if (!await checkStoreAccess(storeId, userId)) {
                return res.status(403).json({ success: false, error: 'Unauthorized access to store' });
            }

            const thirtyDaysFromNow = new Date(new Date().getTime() + 7 * 60 * 60 * 1000);
            thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);
            const nowTh = new Date(new Date().getTime() + 7 * 60 * 60 * 1000);
            const today = nowTh.toISOString().split('T')[0];
            const expireLimit = thirtyDaysFromNow.toISOString().split('T')[0];

            const { data, error } = await supabaseAdmin
                .from('product_batches')
                .select(`
                id,
                batch_no,
                expire_date,
                remaining_qty,
                products!inner(
                    id,
                    name,
                    image_url,
                    store_id,
                    unit_type
                )
            `)
                .eq('products.store_id', storeId)
                .gte('expire_date', today)
                .lte('expire_date', expireLimit)
                .gt('remaining_qty', 0)
                .order('expire_date', { ascending: true })
                .limit(10);

            if (error) throw error;

            // Format for frontend
            const formattedData = data?.map(batch => ({
                id: batch.id,
                productId: batch.products.id,
                name: batch.products.name,
                quantity: batch.remaining_qty,
                expireDate: batch.expire_date,
                batchNo: batch.batch_no,
                image: batch.products.image_url,
                unit: batch.products.unit_type
            })) || [];

            res.json({ success: true, data: formattedData });
        } catch (error) {
            console.error('Near Expiry Error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Get low stock items (product-level, based on threshold)
    app.get('/api/stock/low-stock', async (req, res) => {
        try {
            const storeId = req.headers['x-store-id'];
            const userId = req.user.id;

            if (!storeId) {
                return res.status(400).json({ success: false, error: 'Store ID required' });
            }

            if (!await checkStoreAccess(storeId, userId)) {
                return res.status(403).json({ success: false, error: 'Unauthorized access to store' });
            }

            const { data, error } = await supabaseAdmin
                .from('products')
                .select('id, name, stock_qty, low_stock_threshold, image_url, unit_type')
                .eq('store_id', storeId)
                .gt('low_stock_threshold', 0)
                .order('stock_qty', { ascending: true })
                .limit(20);

            if (error) throw error;

            // Filter products where stock_qty <= low_stock_threshold
            const lowStockItems = data?.filter(p =>
                parseFloat(p.stock_qty) <= parseFloat(p.low_stock_threshold) && parseFloat(p.stock_qty) > 0
            ).map(p => ({
                id: p.id,
                name: p.name,
                quantity: p.stock_qty,
                threshold: p.low_stock_threshold,
                image: p.image_url,
                unit: p.unit_type
            })) || [];

            res.json({ success: true, data: lowStockItems });
        } catch (error) {
            console.error('Low Stock Error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Generate stock notifications (call this periodically or on-demand)
    app.post('/api/stock/check-notifications', async (req, res) => {
        try {
            const storeId = req.headers['x-store-id'];
            const userId = req.user.id;

            if (!storeId) {
                return res.status(400).json({ success: false, error: 'Store ID required' });
            }

            if (!await checkStoreAccess(storeId, userId)) {
                return res.status(403).json({ success: false, error: 'Unauthorized access to store' });
            }

            // 1. Get all users for this store (Owner + Managers) - same as payment notifications
            const { data: store, error: storeError } = await supabaseAdmin
                .from('stores')
                .select('owner_id')
                .eq('id', storeId)
                .single();
            if (storeError) throw storeError;

            const { data: members, error: membersError } = await supabaseAdmin
                .from('store_members')
                .select('user_id')
                .eq('store_id', storeId);
            if (membersError) throw membersError;

            const allUserIds = [store.owner_id, ...members.map(m => m.user_id)];

            const today = new Date();
            const todayStr = today.toISOString().split('T')[0];
            const sevenDaysFromNow = new Date(today);
            sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);
            const sevenDaysStr = sevenDaysFromNow.toISOString().split('T')[0];

            const notifications = [];

            // 2. Check for EXPIRED batches (expire_date < today)
            const { data: expiredBatches } = await supabaseAdmin
                .from('product_batches')
                .select(`
                id, batch_no, expire_date, remaining_qty,
                products!inner(id, name, store_id)
            `)
                .eq('products.store_id', storeId)
                .lt('expire_date', todayStr)
                .gt('remaining_qty', 0);

            for (const batch of expiredBatches || []) {
                // Calculate how long ago it expired
                const expireDate = new Date(batch.expire_date);
                const daysExpired = Math.ceil((today - expireDate) / (1000 * 60 * 60 * 24));

                let expiredText;
                if (daysExpired === 1) {
                    expiredText = 'เมื่อวาน';
                } else if (daysExpired < 7) {
                    expiredText = `${daysExpired} วันที่แล้ว`;
                } else if (daysExpired < 30) {
                    expiredText = `${Math.ceil(daysExpired / 7)} สัปดาห์ที่แล้ว`;
                } else {
                    expiredText = `${Math.ceil(daysExpired / 30)} เดือนที่แล้ว`;
                }

                notifications.push({
                    type: 'stock_expired',
                    title: 'สินค้าหมดอายุ',
                    message: `${batch.products.name} (Lot #${batch.batch_no?.replace('LOT-', '') || batch.id.slice(0, 8)})\nหมดอายุ${expiredText} • ${batch.remaining_qty} ชิ้น`,
                    category: 'stock',
                    productName: batch.products.name,
                    payload: {
                        batch_id: batch.id,
                        product_id: batch.products.id,
                        expire_date: batch.expire_date,
                        remaining_qty: batch.remaining_qty
                    }
                });
            }

            // 3. Check for NEAR-EXPIRY batches (today <= expire_date <= 7 days)
            const { data: nearExpiryBatches } = await supabaseAdmin
                .from('product_batches')
                .select(`
                id, batch_no, expire_date, remaining_qty,
                products!inner(id, name, store_id, low_stock_threshold)
            `)
                .eq('products.store_id', storeId)
                .gte('expire_date', todayStr)
                .lte('expire_date', sevenDaysStr)
                .gt('remaining_qty', 0);

            for (const batch of nearExpiryBatches || []) {
                const expireDate = new Date(batch.expire_date);
                const daysLeft = Math.ceil((expireDate - today) / (1000 * 60 * 60 * 24));
                const threshold = parseFloat(batch.products.low_stock_threshold) || 0;
                const isBelowThreshold = threshold > 0 && parseFloat(batch.remaining_qty) <= threshold;

                let expiryText;
                if (daysLeft === 0) {
                    expiryText = 'หมดอายุวันนี้!';
                } else if (daysLeft === 1) {
                    expiryText = 'หมดอายุพรุ่งนี้';
                } else {
                    expiryText = `หมดอายุใน ${daysLeft} วัน`;
                }

                notifications.push({
                    type: 'stock_near_expiry',
                    title: 'สินค้าใกล้หมดอายุ',
                    message: `${batch.products.name}\n${expiryText} • เหลือ ${batch.remaining_qty} ชิ้น${isBelowThreshold ? ' (ต่ำกว่าเกณฑ์)' : ''}`,
                    category: 'stock',
                    productName: batch.products.name,
                    payload: {
                        batch_id: batch.id,
                        product_id: batch.products.id,
                        expire_date: batch.expire_date,
                        days_left: daysLeft,
                        remaining_qty: batch.remaining_qty
                    }
                });
            }

            // 4. Check for OUT-OF-STOCK products (stock_qty = 0)
            const { data: outOfStockProducts } = await supabaseAdmin
                .from('products')
                .select('id, name, stock_qty')
                .eq('store_id', storeId)
                .eq('stock_qty', 0);

            for (const product of outOfStockProducts || []) {
                notifications.push({
                    type: 'stock_out',
                    title: 'สินค้าหมด',
                    message: product.name,
                    category: 'stock',
                    productName: product.name,
                    payload: { product_id: product.id }
                });
            }

            // 5. Check for LOW-STOCK products (stock_qty <= threshold but > 0)
            const { data: lowStockProducts } = await supabaseAdmin
                .from('products')
                .select('id, name, stock_qty, low_stock_threshold')
                .eq('store_id', storeId)
                .gt('low_stock_threshold', 0)
                .gt('stock_qty', 0);

            for (const product of lowStockProducts || []) {
                if (parseFloat(product.stock_qty) <= parseFloat(product.low_stock_threshold)) {
                    notifications.push({
                        type: 'stock_low',
                        title: 'สินค้าใกล้หมด',
                        message: `${product.name}\nเหลือ ${product.stock_qty} ชิ้น`,
                        category: 'stock',
                        productName: product.name,
                        payload: {
                            product_id: product.id,
                            stock_qty: product.stock_qty,
                            threshold: product.low_stock_threshold
                        }
                    });
                }
            }

            // 6. Upsert notifications (uses the global helper for deduplication)
            let created = 0;

            for (const notif of notifications) {
                const refId = notif.payload.batch_id || notif.payload.product_id;
                const refType = notif.payload.batch_id ? 'batch' : 'product';
                const priority = notif.type === 'stock_expired' || notif.type === 'stock_out' ? 'critical' : 'medium';

                const isNew = await upsertNotificationGlobal(
                    storeId,
                    notif.type,
                    notif.title,
                    notif.message,
                    notif.category,
                    priority,
                    refId,
                    refType,
                    notif.payload
                );
                if (isNew) created++;
            }

            res.json({
                success: true,
                data: {
                    checked: notifications.length,
                    inserted: created,
                    expired: expiredBatches?.length || 0,
                    nearExpiry: nearExpiryBatches?.length || 0,
                    outOfStock: outOfStockProducts?.length || 0,
                    lowStock: lowStockProducts?.filter(p =>
                        parseFloat(p.stock_qty) <= parseFloat(p.low_stock_threshold)
                    ).length || 0
                }
            });
        } catch (error) {
            console.error('Check Notifications Error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });
};

module.exports = { registerStockRoutes };
