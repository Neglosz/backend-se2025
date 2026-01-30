require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const authMiddleware = require('./middleware/auth')

const rateLimiter = require('./middleware/rateLimiter');
const { productValidators, categoryValidators, creditPaymentValidators } = require('./middleware/validators');
const { createClient } = require('@supabase/supabase-js');

const branchesRoutes = require('./routes/branches');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1); // Enable trust proxy for Render/Load Balancers
app.use(cors());
app.use(express.json());
app.use(helmet());

// Temporary Migration Endpoint: Claim Orphans
app.post('/api/admin/claim-orphans', authMiddleware, async (req, res) => {
    try {
        const storeId = req.headers['x-store-id'];
        const userId = req.user.id;

        if (!storeId) return res.status(400).json({ error: 'Store ID required' });

        // Simple security check: Ensure user is connected to this store
        // (In a real migration, we might want stricter checks, but this is an emergency fix)
        // const hasAccess = await checkStoreAccess(storeId, userId); 
        // if (!hasAccess) return res.status(403).json({ error: 'Unauthorized' });

        const tables = ['products', 'product_categories', 'customers_info', 'orders', 'credit_accounts'];
        const results = {};

        for (const table of tables) {
            const { data, error } = await supabaseAdmin
                .from(table)
                .update({ store_id: storeId })
                .is('store_id', null)
                .select();

            if (error) console.error(`Error migrating ${table}:`, error);
            results[table] = data ? data.length : 0;
        }

        res.json({ success: true, migrated: results });
    } catch (e) {
        console.error("Migration Error:", e);
        res.status(500).json({ error: e.message });
    }
});

// DEBUG ENDPOINT: Check Store/Product Status (Safe, Read-Only)
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

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

// Admin client bypasses RLS - use for backend operations
const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function checkStoreAccess(storeId, userId) {
    if (!storeId || !userId) return false;

    // 1. Check if Owner
    const { data: store } = await supabaseAdmin
        .from('stores')
        .select('owner_id')
        .eq('id', storeId)
        .single();

    if (store && store.owner_id === userId) return true;

    // 2. Check if Member/Manager
    const { data: member } = await supabaseAdmin
        .from('store_members')
        .select('role')
        .eq('store_id', storeId)
        .eq('user_id', userId)
        .single();

    if (member) return true;

    return false;
}

function convertDateFormat(ddmmyy) {
    const [day, month, year] = ddmmyy.split('/');
    return `${year}-${month}-${day}`;
}
app.use('/api', authMiddleware);
app.use('/api', rateLimiter); // Apply rate limiting to all API routes
// ==================== STOCK ENDPOINTS ====================

// Get stock overview stats
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
        const thirtyDaysFromNow = new Date();
        thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);
        const today = new Date().toISOString().split('T')[0];
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

        const today = new Date().toISOString().split('T')[0];

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
                    store_id
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
            image: batch.products.image_url
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
            .select('id, name, stock_qty, image_url')
            .eq('store_id', storeId)
            .eq('stock_qty', 0)
            .order('name', { ascending: true })
            .limit(20);

        if (error) throw error;

        const formattedData = data?.map(p => ({
            id: p.id,
            name: p.name,
            quantity: p.stock_qty,
            image: p.image_url
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

        const thirtyDaysFromNow = new Date();
        thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);
        const today = new Date().toISOString().split('T')[0];
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
                    store_id
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
            image: batch.products.image_url
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
            .select('id, name, stock_qty, low_stock_threshold, image_url')
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
            image: p.image_url
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

        // 6. Insert notifications for EACH user (same as payment notifications)
        let created = 0;
        for (const notif of notifications) {
            for (const userId of allUserIds) {
                // Check existing for this user/product/day to avoid spam
                const { data: existing } = await supabaseAdmin
                    .from('notifications')
                    .select('id')
                    .eq('user_id', userId)
                    .eq('store_id', storeId)
                    .eq('type', notif.type)
                    .ilike('message', `%${notif.productName}%`)
                    .eq('is_read', false)
                    .limit(1);

                if (!existing || existing.length === 0) {
                    await supabaseAdmin.from('notifications').insert([{
                        type: notif.type,
                        title: notif.title,
                        message: notif.message,
                        category: notif.category,
                        payload: notif.payload,
                        store_id: storeId,
                        user_id: userId,
                        is_read: false
                    }]);
                    created++;
                }
            }
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

// ==================== END STOCK ENDPOINTS ====================

app.use('/api/branches', branchesRoutes);

// Customer search for autocomplete
app.get('/api/customers/search', async (req, res) => {
    try {
        const { q } = req.query;
        const storeId = req.headers['x-store-id'];

        if (!q || q.length < 2) {
            return res.json({ success: true, data: [] });
        }

        let query = supabaseAdmin
            .from('customers_info')
            .select('id, name, phone, image_url')
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
        res.json({ success: true, data: data || [] });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/customers/with-debt', async (req, res) => {
    try {
        const storeId = req.headers['x-store-id'];

        let query = supabaseAdmin
            .from('credit_accounts')
            .select('*, customers_info!inner(id, name, phone, image_url), orders(order_no)')
            .in('status', ['unpaid', 'partial', 'overdue'])
            .order('due_date', { ascending: true });

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
                    image_url: account.customers_info?.image_url,
                    total_debt: 0,
                    accounts: []
                };
            }
            customerMap[customerId].total_debt += parseFloat(account.remaining_amount || 0);
            customerMap[customerId].accounts.push(account);
        }

        const customers = Object.values(customerMap);
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
            .order('due_date', { ascending: true });
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

        // Fetch all unpaid/partial bills for this customer, ordered by due_date ASC (oldest first)
        const { data: accounts, error: fetchError } = await supabaseAdmin
            .from('credit_accounts')
            .select('*, customers_info!inner(store_id)')
            .eq('customer_id', customer_id)
            .eq('customers_info.store_id', storeId)
            .in('status', ['unpaid', 'partial', 'overdue'])
            .order('due_date', { ascending: true }); // Pay oldest first

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

        res.json({ success: true, data: payments });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
})

app.get('/api/notifications', async (req, res) => {
    try {
        const { category } = req.query;
        const userId = req.user.id; // Get user ID from header

        let query = supabaseAdmin.from('notifications').select('*'); // Use supabaseAdmin for consistent access

        // Critical: Filter by user_id if provided
        if (userId) {
            query = query.eq('user_id', userId);
        } else {
            // Fallback for backward compatibility or error if strict
            // For now, if no user_id, might return empty or all (security risk in multi-tenant, but assuming headers are sent)
            // Better to return empty if no user_id to be safe
            return res.json({ success: true, data: [] });
        }

        if (category) {
            query = query.eq('category', category);
        }
        const { data, error } = await query.order('created_at', { ascending: false });
        if (error) throw error;
        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/notifications/unread-count', async (req, res) => {
    try {
        const userId = req.user.id;
        if (!userId) {
            return res.json({ success: true, count: 0 });
        }

        const { count, error } = await supabaseAdmin
            .from('notifications')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', userId)
            .eq('is_read', false);

        if (error) throw error;
        res.json({ success: true, count });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/check-due-notifications', async (req, res) => {
    try {
        const storeId = req.headers['x-store-id'];
        const userId = req.user.id;

        if (!storeId) {
            return res.status(400).json({ success: false, error: 'Store ID required' });
        }

        if (!await checkStoreAccess(storeId, userId)) {
            return res.status(403).json({ success: false, error: 'Unauthorized access to store' });
        }

        // 1. Get all users for this store (Owner + Managers)
        // Get Store Owner
        const { data: store, error: storeError } = await supabaseAdmin
            .from('stores')
            .select('owner_id')
            .eq('id', storeId)
            .single();
        if (storeError) throw storeError;

        // Get Store Managers
        const { data: members, error: membersError } = await supabaseAdmin
            .from('store_members')
            .select('user_id')
            .eq('store_id', storeId);
        if (membersError) throw membersError;

        const allUserIds = [store.owner_id, ...members.map(m => m.user_id)];

        // 2. Get unpaid/partial debts for this store
        const { data: accounts } = await supabaseAdmin
            .from('credit_accounts')
            .select('*, customers_info!inner(name, phone, store_id)')
            .in('status', ['unpaid', 'partial'])
            .eq('customers_info.store_id', storeId); // Filter by store

        if (!accounts || accounts.length === 0) {
            return res.json({ success: true, created: 0 });
        }

        // 3. Group by customer and find latest due date
        const customerDebts = {};
        for (const account of accounts) {
            const customerId = account.customer_id;
            if (!customerDebts[customerId]) {
                customerDebts[customerId] = {
                    name: account.customers_info.name,
                    phone: account.customers_info.phone,
                    total_debt: 0,
                    dates: []
                };
            }
            customerDebts[customerId].total_debt += parseFloat(account.remaining_amount);
            customerDebts[customerId].dates.push(new Date(account.due_date));
        }

        let created = 0;
        const today = new Date();
        const todayStr = today.toISOString().split('T')[0];

        // 4. Check each customer status
        for (const customerId in customerDebts) {
            const data = customerDebts[customerId];
            const maxDueDate = new Date(Math.max.apply(null, data.dates));
            const diffDays = Math.ceil((maxDueDate - today) / (1000 * 60 * 60 * 24));

            // Logic: Overdue (< 0) or Near Due (<= 3)
            if (diffDays < 0 || diffDays <= 3) {
                const title = diffDays < 0
                    ? `เกินกำหนดชำระ ${Math.abs(diffDays)} วัน`
                    : `ครบกำหนดชำระอีก ${diffDays} วัน`;
                const message = `คุณ ${data.name}\nยอดรวม ฿${data.total_debt.toFixed(2)}`;

                // 5. Create notification for EACH user
                for (const userId of allUserIds) {
                    // Check existing for this user/customer/day to avoid spam
                    const { data: existing } = await supabaseAdmin
                        .from('notifications')
                        .select('id')
                        .eq('user_id', userId)
                        .eq('store_id', storeId)
                        .ilike('message', `%${data.name}%`) // Simple duplicate check
                        .eq('is_read', false)
                        .single();

                    if (!existing) {
                        await supabaseAdmin.from('notifications').insert([{
                            title,
                            message,
                            category: 'payment',
                            payload: { phone: data.phone },
                            store_id: storeId,
                            user_id: userId, // Individual copy
                            is_read: false
                        }]);
                        created++;
                    }
                }
            }
        }

        res.json({ success: true, created });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});


app.put('/api/notifications/mark-read', async (req, res) => {
    try {
        const { ids } = req.body;
        const userId = req.user.id;

        if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

        const { error } = await supabaseAdmin
            .from('notifications')
            .update({ is_read: true })
            .in('id', ids)
            .eq('user_id', userId); // Security Check
        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/api/notifications/:id/read', async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

        const { error } = await supabaseAdmin
            .from('notifications')
            .update({ is_read: true })
            .eq('id', id)
            .eq('user_id', userId); // Security Check
        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/api/notifications/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

        const { error } = await supabaseAdmin
            .from('notifications')
            .delete()
            .eq('id', id)
            .eq('user_id', userId); // Security Check
        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

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

app.post('/api/credit-sales', async (req, res) => {
    try {
        const { customer_name, customer_phone, due_date, amount, items, customer_id, is_new_customer, customer_image } = req.body;
        const storeId = req.headers['x-store-id'];

        let customer;

        // Use existing customer if customer_id provided
        if (customer_id) {
            const { data: existingCustomer } = await supabaseAdmin
                .from('customers_info')
                .select('*')
                .eq('id', customer_id)
                .single();
            customer = existingCustomer;

            // Update image if provided and different (or just update to be sure)
            if (customer_image && customer.image_url !== customer_image) {
                const { data: updatedCustomer, error: updateError } = await supabaseAdmin
                    .from('customers_info')
                    .update({ image_url: customer_image })
                    .eq('id', customer_id)
                    .select()
                    .single();

                if (!updateError) {
                    customer = updatedCustomer;
                }
            }
        } else {
            // Search by phone within the same store
            const { data: existingCustomer } = await supabaseAdmin
                .from('customers_info')
                .select('*')
                .eq('phone', customer_phone)
                .eq('store_id', storeId)
                .single();

            if (existingCustomer) {
                customer = existingCustomer;
            } else {
                // Create new customer with store_id
                const { data: newCustomer, error: customerError } = await supabaseAdmin
                    .from('customers_info')
                    .insert([{
                        name: customer_name,
                        phone: customer_phone,
                        store_id: storeId,
                        image_url: customer_image || null,
                    }])
                    .select()
                    .single();
                if (customerError) throw customerError;
                customer = newCustomer;
            }
        }

        const orderNo = `ORD${Date.now().toString().slice(-8)}`;
        const { data: order, error: orderError } = await supabaseAdmin
            .from('orders')
            .insert([{
                order_no: orderNo,
                customer_id: customer.id,
                total_amount: amount,
                payment_status: 'pending',
                payment_type: 'credit_sale',
                store_id: storeId,
            }])
            .select()
            .single();
        if (orderError) throw orderError;

        const { data: creditAccount, error: creditError } = await supabaseAdmin
            .from('credit_accounts')
            .insert([{
                order_id: order.id,
                customer_id: customer.id,
                total_debt: amount,
                paid_amount: 0,
                remaining_amount: amount,
                due_date: convertDateFormat(due_date),
                status: 'unpaid'
            }])
            .select()
            .single();
        if (creditError) throw creditError;

        res.json({
            success: true,
            data: {
                customer,
                order,
                credit_account: creditAccount
            }
        });
    } catch (error) {
        console.error('Credit sale error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});


// NOTE: Image uploads are now handled directly by the frontend to Supabase Storage
// The /uploads endpoint is no longer needed for new images
// Legacy images in uploads/ folder will still be served for backwards compatibility
app.use('/uploads', require('express').static('uploads'));



// Get paginated products with optional search
app.get('/api/products', async (req, res) => {
    try {
        const storeId = req.headers['x-store-id'];
        const userId = req.user.id;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const search = req.query.search || '';
        const categoryId = req.query.categoryId || null;
        const offset = (page - 1) * limit;

        if (!storeId) {
            return res.status(400).json({ success: false, error: 'Store ID required' });
        }

        if (!await checkStoreAccess(storeId, userId)) {
            return res.status(403).json({ success: false, error: 'Unauthorized access to store' });
        }

        let query = supabaseAdmin
            .from('products')
            .select('id, barcode, name, price, stock_qty, image_url, category_id, is_weightable, unit_type')
            .order('name', { ascending: true })
            .eq('store_id', storeId);

        if (categoryId) {
            query = query.eq('category_id', categoryId);
        }

        if (search) {
            query = query.or(`name.ilike.%${search}%,barcode.ilike.%${search}%`);
        }

        // Apply pagination LAST
        query = query.range(offset, offset + limit - 1);

        const { data, error } = await query;

        if (error) throw error;

        res.json({ success: true, data, page, limit });
    } catch (error) {
        console.error('Get products error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Lookup product by barcode - returns product info if exists
app.get('/api/products/barcode/:barcode', async (req, res) => {
    try {
        const { barcode } = req.params;
        const storeId = req.headers['x-store-id'];
        const userId = req.user.id;

        if (!storeId) {
            return res.status(400).json({ success: false, error: 'Store ID required' });
        }

        if (!await checkStoreAccess(storeId, userId)) {
            return res.status(403).json({ success: false, error: 'Unauthorized access to store' });
        }

        let query = supabaseAdmin
            .from('products')
            .select(`
                *,
                product_categories(id, name)
            `)
            .eq('barcode', barcode)
            .eq('store_id', storeId);

        const { data, error } = await query.single();

        if (error && error.code === 'PGRST116') {
            // Not found - this is fine, means it's a new product
            return res.json({ success: true, exists: false, data: null });
        }
        if (error) throw error;

        // Get all batches for this product
        const { data: batches } = await supabaseAdmin
            .from('product_batches')
            .select('*')
            .eq('product_id', data.id)
            .order('expire_date', { ascending: true });

        res.json({
            success: true,
            exists: true,
            data: { ...data, batches: batches || [] }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Add stock to existing product (create new batch)
app.post('/api/products/:id/add-batch', async (req, res) => {
    try {
        const { id } = req.params;
        const { quantity, costPrice, salePrice, expireDate } = req.body;
        const qty = parseFloat(quantity) || 0;
        const cost = parseFloat(costPrice) || 0;
        const sale = parseFloat(salePrice) || 0;

        if (qty <= 0) {
            return res.status(400).json({ success: false, error: 'กรุณากรอกจำนวนสินค้า' });
        }

        // 1. Create new batch
        const batchNo = `LOT-${Date.now()}`;
        const { data: batch, error: batchError } = await supabaseAdmin
            .from('product_batches')
            .insert([{
                product_id: id,
                batch_no: batchNo,
                qty: qty,
                remaining_qty: qty,
                expire_date: expireDate ? convertDateFormat(expireDate) : null
            }])
            .select()
            .single();

        if (batchError) throw batchError;

        // 2. Update product stock_qty (accumulate) and optionally update prices
        const { data: product, error: productError } = await supabaseAdmin
            .from('products')
            .select('stock_qty, cost_price, price')
            .eq('id', id)
            .single();

        if (productError) throw productError;

        const newStockQty = (parseFloat(product.stock_qty) || 0) + qty;
        const updateData = { stock_qty: newStockQty };

        // Update cost price if provided
        if (cost > 0) {
            updateData.cost_price = cost;
        }

        // Update sale price if provided (applies to ALL batches - just updates product price)
        if (sale > 0) {
            updateData.price = sale;
        }

        await supabaseAdmin
            .from('products')
            .update(updateData)
            .eq('id', id);

        res.json({
            success: true,
            data: {
                batch,
                newStockQty,
                addedQty: qty,
                newSalePrice: sale > 0 ? sale : product.price
            }
        });

    } catch (error) {
        console.error("Add Batch Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/product-categories', async (req, res) => {
    try {
        const storeId = req.headers['x-store-id'];
        const userId = req.user.id;

        if (!storeId) {
            return res.status(400).json({ success: false, error: 'Store ID required' });
        }

        if (!await checkStoreAccess(storeId, userId)) {
            return res.status(403).json({ success: false, error: 'Unauthorized access to store' });
        }

        let query = supabaseAdmin.from('product_categories').select('*').order('name').eq('store_id', storeId);

        const { data, error } = await query;
        if (error) throw error;
        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Create new category
app.post('/api/product-categories', categoryValidators, async (req, res) => {
    try {
        const { name } = req.body;
        const storeId = req.headers['x-store-id'];
        const userId = req.user.id;

        if (!storeId) {
            return res.status(400).json({ success: false, error: 'Store ID required' });
        }

        if (!await checkStoreAccess(storeId, userId)) {
            return res.status(403).json({ success: false, error: 'Unauthorized access to store' });
        }


        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, error: 'Category name is required' });
        }

        const { data, error } = await supabaseAdmin
            .from('product_categories')
            .insert([{ name: name.trim(), store_id: storeId }])
            .select()
            .single();

        if (error) throw error;
        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Update category
app.put('/api/product-categories/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name } = req.body;
        const storeId = req.headers['x-store-id'];
        const userId = req.user.id;

        if (!storeId) {
            return res.status(400).json({ success: false, error: 'Store ID required' });
        }

        if (!await checkStoreAccess(storeId, userId)) {
            return res.status(403).json({ success: false, error: 'Unauthorized access to store' });
        }

        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, error: 'Category name is required' });
        }

        // Build update query with store_id check for security
        let query = supabaseAdmin
            .from('product_categories')
            .update({ name: name.trim() })
            .eq('id', id);

        if (storeId) {
            query = query.eq('store_id', storeId);
        }

        const { data, error } = await query.select().single();

        if (error) throw error;
        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Delete category
app.delete('/api/product-categories/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const storeId = req.headers['x-store-id'];

        // Check if category is used by any products
        const { data: products } = await supabaseAdmin
            .from('products')
            .select('id')
            .eq('category_id', id)
            .limit(1);

        if (products && products.length > 0) {
            return res.status(400).json({
                success: false,
                error: 'ไม่สามารถลบหมวดหมู่ได้ เนื่องจากมีสินค้าในหมวดหมู่นี้อยู่'
            });
        }

        // Delete with store_id check for security
        let query = supabaseAdmin
            .from('product_categories')
            .delete()
            .eq('id', id);

        if (storeId) {
            query = query.eq('store_id', storeId);
        }

        const { error } = await query;

        if (error) throw error;
        res.json({ success: true, message: 'Category deleted successfully' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Add new product - now accepts JSON with Supabase Storage URL
app.post('/api/products', async (req, res) => {
    try {
        // Now receives JSON body instead of multipart/form-data
        const { code, name, categoryId, quantity, costPrice, salePrice, lowStockThreshold, unitType, expireDate, imageUrl } = req.body;
        const storeId = req.headers['x-store-id'];

        // Validate required fields
        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, error: 'กรุณากรอกชื่อสินค้า' });
        }

        // 1. Insert Product
        const { data: product, error: productError } = await supabaseAdmin
            .from('products')
            .insert([{
                barcode: code || null,
                name: name.trim(),
                category_id: categoryId || null,
                stock_qty: parseFloat(quantity) || 0,
                cost_price: parseFloat(costPrice) || 0,
                price: parseFloat(salePrice) || 0,
                low_stock_threshold: parseFloat(lowStockThreshold) || 0,
                unit_type: unitType || 'ชิ้น',
                store_id: storeId,
                image_url: imageUrl || null, // Supabase Storage URL from frontend
                is_weightable: false
            }])
            .select()
            .single();

        if (productError) throw productError;

        // 2. Insert Batch (if quantity > 0)
        const qty = parseFloat(quantity) || 0;
        if (qty > 0) {
            const batchNo = `LOT-${Date.now()}`;
            const { error: batchError } = await supabaseAdmin
                .from('product_batches')
                .insert([{
                    product_id: product.id,
                    batch_no: batchNo,
                    qty: qty,
                    remaining_qty: qty,
                    expire_date: expireDate ? convertDateFormat(expireDate) : null
                }]);

            if (batchError) {
                console.error("Batch creation failed:", batchError);
            }
        }

        res.json({ success: true, data: product });

    } catch (error) {
        console.error("Add Product Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});



// Global 404 Handler
app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Endpoint not found' });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});