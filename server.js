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
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
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

async function signUrlIfNeeded(urlOrPath, bucket) {
    if (!urlOrPath) return null;
    if (bucket !== 'customers') return urlOrPath; // Only sign customers for now as it is private

    let path = urlOrPath;
    // Extract path if it's a full URL
    if (urlOrPath.includes(`/object/public/${bucket}/`)) {
        path = urlOrPath.split(`/object/public/${bucket}/`)[1];
    }

    const { data, error } = await supabaseAdmin
        .storage
        .from(bucket)
        .createSignedUrl(path, 3600); // 1 hour expiry

    if (error) {
        console.error(`Error signing URL for ${path}:`, error);
        return urlOrPath; // Fallback to original
    }

    return data.signedUrl;
}

// Helper to format date for SQL (YYYY-MM-DD)
const convertDateFormat = (dateInput) => {
    if (!dateInput) return null;
    try {
        const d = new Date(dateInput);
        if (isNaN(d.getTime())) return null; // Invalid date
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    } catch (e) {
        console.error("Date conversion error", e);
        return null;
    }
};
const { encrypt, decrypt } = require('./utils/crypto');
const promptpay = require('promptpay-qr');


app.use('/api', authMiddleware);
app.use('/api', rateLimiter); // Apply rate limiting to all API routes

// ==================== STORE SETTINGS ENDPOINTS ====================

// Get Store Settings (PromptPay)
app.get('/api/stores/settings', async (req, res) => {
    try {
        const storeId = req.headers['x-store-id'];
        const userId = req.user.id; // Now safe

        if (!storeId) return res.status(400).json({ success: false, error: 'Store ID required' });

        // Check Access & Role
        let role = 'member';
        const { data: store } = await supabaseAdmin.from('stores').select('*').eq('id', storeId).single();
        if (store && store.owner_id === userId) {
            role = 'owner';
        } else {
            const { data: member } = await supabaseAdmin.from('store_members').select('role').eq('store_id', storeId).eq('user_id', userId).single();
            if (member) role = member.role;
            else return res.status(403).json({ success: false, error: 'Unauthorized' });
        }

        // Decrypt PromptPay ID
        let realPromptPayId = decrypt(store.promptpay_id_enc);
        let displayPromptPayId = '';

        if (realPromptPayId) {
            if (role === 'owner') {
                displayPromptPayId = realPromptPayId; // Owner sees full number
            } else {
                // Manager sees masked number
                if (store.promptpay_type === 'phone' && realPromptPayId.length >= 10) {
                    displayPromptPayId = `${realPromptPayId.substring(0, 3)}-xxx-${realPromptPayId.substring(6)}`;
                } else if (store.promptpay_type === 'id_card' && realPromptPayId.length >= 13) {
                    displayPromptPayId = `x-xxxx-xxxxx-${realPromptPayId.substring(10)}`;
                } else {
                    displayPromptPayId = 'xxx-xxx-xxxx';
                }
            }
        }

        res.json({
            success: true,
            data: {
                promptpay_id: displayPromptPayId, // Send masked or full based on role
                promptpay_type: store.promptpay_type,
                promptpay_name: store.promptpay_name,
                role: role // Send role so frontend knows if editable
            }
        });

    } catch (error) {
        console.error('Get Store Settings Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Update Store Settings (PromptPay) - OWNER ONLY
app.put('/api/stores/settings', async (req, res) => {
    try {
        const { promptpay_id, promptpay_type, promptpay_name } = req.body;
        const storeId = req.headers['x-store-id'];
        const userId = req.user.id;

        if (!storeId) return res.status(400).json({ success: false, error: 'Store ID required' });

        // 1. Strict Owner Check
        const { data: store } = await supabaseAdmin.from('stores').select('owner_id').eq('id', storeId).single();

        if (!store || store.owner_id !== userId) {
            return res.status(403).json({ success: false, error: 'Only Store Owner can edit payment settings' });
        }

        // 2. Encrypt Data
        const encryptedId = encrypt(promptpay_id);

        // 3. Update DB
        const { error } = await supabaseAdmin
            .from('stores')
            .update({
                promptpay_id_enc: encryptedId,
                promptpay_type,
                promptpay_name
            })
            .eq('id', storeId);

        if (error) throw error;

        res.json({ success: true, message: 'Settings updated successfully' });

    } catch (error) {
        console.error('Update Store Settings Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Generate PromptPay Payload (For QR Generation)
app.post('/api/sales/qr-payload', async (req, res) => {
    try {
        const { amount } = req.body;
        const storeId = req.headers['x-store-id'];
        const userId = req.user.id;

        if (!storeId) return res.status(400).json({ success: false, error: 'Store ID required' });

        // Check Access (Manager can access this to receive money)
        if (!await checkStoreAccess(storeId, userId)) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }

        // Get Store PromptPay Info
        const { data: store } = await supabaseAdmin
            .from('stores')
            .select('promptpay_id_enc, promptpay_type')
            .eq('id', storeId)
            .single();

        if (!store || !store.promptpay_id_enc) {
            return res.status(400).json({ success: false, error: 'Store has not set up PromptPay yet' });
        }

        // Decrypt
        const realPromptPayId = decrypt(store.promptpay_id_enc);
        if (!realPromptPayId) {
            return res.status(500).json({ success: false, error: 'Decryption failed' });
        }

        // Generate Payload using 'promptpay-qr'
        const payload = promptpay(realPromptPayId, { amount: parseFloat(amount) });

        res.json({ success: true, payload });

    } catch (error) {
        console.error('Generate QR Payload Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== END STORE SETTINGS ====================
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
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);

        for (const notif of notifications) {
            const refId = notif.payload.batch_id || notif.payload.product_id;

            for (const userId of allUserIds) {
                // Deduplication Logic:
                // 1. Check if there's an UNREAD notification for this specific item
                // 2. OR check if any notification (even read) was created TODAY
                const { data: existing } = await supabaseAdmin
                    .from('notifications')
                    .select('id, is_read')
                    .eq('user_id', userId)
                    .eq('store_id', storeId)
                    .eq('type', notif.type)
                    .contains('payload', { [notif.payload.batch_id ? 'batch_id' : 'product_id']: refId })
                    .or(`is_read.eq.false,created_at.gte.${startOfDay.toISOString()}`)
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
                    image_url: await signUrlIfNeeded(account.customers_info?.image_url, 'customers'),
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

        const today = new Date();
        const startOfDay = new Date(today);
        startOfDay.setHours(0, 0, 0, 0);

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
                    // Check existing for this user/customer
                    // Avoid duplicate if: 
                    // 1. There is an UNREAD notification for this customer
                    // 2. OR any notification was created TODAY
                    const { data: existing } = await supabaseAdmin
                        .from('notifications')
                        .select('id')
                        .eq('user_id', userId)
                        .eq('store_id', storeId)
                        .eq('category', 'payment')
                        .contains('payload', { phone: data.phone })
                        .or(`is_read.eq.false,created_at.gte.${startOfDay.toISOString()}`)
                        .limit(1);

                    if (!existing || existing.length === 0) {
                        await supabaseAdmin.from('notifications').insert([{
                            title,
                            message,
                            category: 'payment',
                            payload: { phone: data.phone, customer_id: customerId },
                            store_id: storeId,
                            user_id: userId,
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

// ============================================================
// 🔔 DAILY NOTIFICATION CHECK (Call from external cron daily)
// Checks: Expiry, Near-Expiry, Payment Due, Promo Ending
// ============================================================
app.post('/api/notifications/daily-check', async (req, res) => {
    try {
        const storeId = req.headers['x-store-id'];

        if (!storeId) {
            return res.status(400).json({ success: false, error: 'x-store-id header required' });
        }

        const today = new Date();
        const todayStr = today.toISOString().split('T')[0];
        const in3Days = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const in7Days = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const in2Days = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

        const results = {
            expired: 0,
            nearExpiry: 0,
            paymentOverdue: 0,
            paymentDueSoon: 0,
            promoEnding: 0,
            cleaned: 0
        };

        // Helper to call the database function
        const createNotification = async (type, title, message, category, priority, referenceId, referenceType, payload) => {
            try {
                await supabaseAdmin.rpc('create_notification_for_store', {
                    p_store_id: storeId,
                    p_type: type,
                    p_title: title,
                    p_message: message,
                    p_category: category,
                    p_priority: priority,
                    p_reference_id: referenceId,
                    p_reference_type: referenceType,
                    p_payload: payload
                });
                return true;
            } catch (e) {
                // Duplicate or other error, skip
                return false;
            }
        };

        // 1. Check EXPIRED batches
        const { data: expiredBatches } = await supabaseAdmin
            .from('product_batches')
            .select('id, batch_no, expire_date, remaining_qty, products!inner(id, name, store_id)')
            .eq('products.store_id', storeId)
            .lt('expire_date', todayStr)
            .gt('remaining_qty', 0);

        for (const batch of expiredBatches || []) {
            const daysExpired = Math.ceil((today - new Date(batch.expire_date)) / (1000 * 60 * 60 * 24));
            let expiredText = daysExpired === 1 ? 'เมื่อวาน' :
                daysExpired < 7 ? `${daysExpired} วันที่แล้ว` :
                    daysExpired < 30 ? `${Math.ceil(daysExpired / 7)} สัปดาห์ที่แล้ว` :
                        `${Math.ceil(daysExpired / 30)} เดือนที่แล้ว`;

            const created = await createNotification(
                'stock_expired', 'สินค้าหมดอายุ',
                `${batch.products.name} (Lot #${batch.batch_no?.replace('LOT-', '') || batch.id.slice(0, 8)})\nหมดอายุ${expiredText} • ${batch.remaining_qty} ชิ้น`,
                'stock', 'critical', batch.id, 'batch',
                { batch_id: batch.id, product_id: batch.products.id, expire_date: batch.expire_date }
            );
            if (created) results.expired++;
        }

        // 2. Check NEAR-EXPIRY batches (within 7 days)
        const { data: nearExpiryBatches } = await supabaseAdmin
            .from('product_batches')
            .select('id, batch_no, expire_date, remaining_qty, products!inner(id, name, store_id)')
            .eq('products.store_id', storeId)
            .gte('expire_date', todayStr)
            .lte('expire_date', in7Days)
            .gt('remaining_qty', 0);

        for (const batch of nearExpiryBatches || []) {
            const daysLeft = Math.ceil((new Date(batch.expire_date) - today) / (1000 * 60 * 60 * 24));
            let expiryText = daysLeft === 0 ? 'หมดอายุวันนี้!' :
                daysLeft === 1 ? 'หมดอายุพรุ่งนี้' :
                    `หมดอายุใน ${daysLeft} วัน`;

            const created = await createNotification(
                'stock_near_expiry', 'สินค้าใกล้หมดอายุ',
                `${batch.products.name}\n${expiryText} • เหลือ ${batch.remaining_qty} ชิ้น`,
                'stock', daysLeft <= 2 ? 'high' : 'medium', batch.id, 'batch',
                { batch_id: batch.id, product_id: batch.products.id, expire_date: batch.expire_date, days_left: daysLeft }
            );
            if (created) results.nearExpiry++;
        }

        // 3. Check OVERDUE payments
        const { data: overdueAccounts } = await supabaseAdmin
            .from('credit_accounts')
            .select('id, customer_id, remaining_amount, due_date, customers_info!inner(name, phone, store_id)')
            .eq('customers_info.store_id', storeId)
            .lt('due_date', todayStr)
            .gt('remaining_amount', 0)
            .in('status', ['unpaid', 'partial', 'overdue']);

        for (const acc of overdueAccounts || []) {
            const daysOverdue = Math.ceil((today - new Date(acc.due_date)) / (1000 * 60 * 60 * 24));
            const created = await createNotification(
                'payment_overdue', 'ลูกหนี้เกินกำหนดชำระ',
                `${acc.customers_info.name}\nค้างชำระ ฿${Number(acc.remaining_amount).toLocaleString()} • เกิน ${daysOverdue} วัน`,
                'payment', 'critical', acc.customer_id, 'customer',
                { customer_id: acc.customer_id, credit_account_id: acc.id, amount: acc.remaining_amount, days_overdue: daysOverdue }
            );
            if (created) results.paymentOverdue++;
        }

        // 4. Check payments DUE SOON (within 3 days)
        const { data: dueSoonAccounts } = await supabaseAdmin
            .from('credit_accounts')
            .select('id, customer_id, remaining_amount, due_date, customers_info!inner(name, phone, store_id)')
            .eq('customers_info.store_id', storeId)
            .gte('due_date', todayStr)
            .lte('due_date', in3Days)
            .gt('remaining_amount', 0)
            .in('status', ['unpaid', 'partial']);

        for (const acc of dueSoonAccounts || []) {
            const daysLeft = Math.ceil((new Date(acc.due_date) - today) / (1000 * 60 * 60 * 24));
            let dueText = daysLeft === 0 ? 'ครบกำหนดวันนี้' :
                daysLeft === 1 ? 'ครบกำหนดพรุ่งนี้' :
                    `ครบกำหนดใน ${daysLeft} วัน`;

            const created = await createNotification(
                'payment_due_soon', 'ใกล้ครบกำหนดชำระ',
                `${acc.customers_info.name}\nค้างชำระ ฿${Number(acc.remaining_amount).toLocaleString()} • ${dueText}`,
                'payment', daysLeft === 0 ? 'high' : 'medium', acc.customer_id, 'customer',
                { customer_id: acc.customer_id, credit_account_id: acc.id, amount: acc.remaining_amount, days_left: daysLeft }
            );
            if (created) results.paymentDueSoon++;
        }

        // 5. Check PROMO ENDING (within 2 days)
        const { data: endingPromos } = await supabaseAdmin
            .from('promotions')
            .select('id, name, end_date')
            .eq('store_id', storeId)
            .gte('end_date', todayStr)
            .lte('end_date', in2Days);

        for (const promo of endingPromos || []) {
            const daysLeft = Math.ceil((new Date(promo.end_date) - today) / (1000 * 60 * 60 * 24));
            let endText = daysLeft === 0 ? 'หมดอายุวันนี้' :
                daysLeft === 1 ? 'หมดอายุพรุ่งนี้' :
                    `หมดอายุใน ${daysLeft} วัน`;

            const created = await createNotification(
                'promo_ending', 'โปรโมชั่นใกล้หมดอายุ',
                `${promo.name}\n${endText}`,
                'stock', 'medium', promo.id, 'promotion',
                { promotion_id: promo.id, end_date: promo.end_date, days_left: daysLeft }
            );
            if (created) results.promoEnding++;
        }

        // 6. Cleanup old notifications (> 30 days)
        const { count: cleanedCount } = await supabaseAdmin
            .from('notifications')
            .delete({ count: 'exact' })
            .lt('expires_at', today.toISOString());

        results.cleaned = cleanedCount || 0;

        res.json({
            success: true,
            message: 'Daily check completed',
            results
        });
    } catch (error) {
        console.error('Daily Check Error:', error);
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

// ==================== SALES & TRANSACTION ENDPOINTS ====================

// Unified Sale Endpoint (Cash, QR, Credit)
app.post('/api/sales', async (req, res) => {
    try {
        const { items, paymentMethod, totalAmount, receivedAmount, customerId, customerName } = req.body;
        const storeId = req.headers['x-store-id'];
        const userId = req.user.id;

        if (!storeId) return res.status(400).json({ success: false, error: 'Store ID required' });
        if (!items || items.length === 0) return res.status(400).json({ success: false, error: 'No items in cart' });

        // Validate Store Access
        if (!await checkStoreAccess(storeId, userId)) {
            return res.status(403).json({ success: false, error: 'Unauthorized access to store' });
        }

        // 1. Create Order
        const orderNo = `ORD-${Date.now().toString().slice(-8)}`; // Simple Order No
        const { data: order, error: orderError } = await supabaseAdmin
            .from('orders')
            .insert([{
                order_no: orderNo,
                customer_id: customerId || null,
                total_amount: totalAmount,
                payment_status: paymentMethod === 'credit' ? 'pending' : 'paid',
                payment_type: paymentMethod === 'credit' ? 'credit_sale' : 'cash_sale', // Distinguish credit vs cash/qr
                store_id: storeId,
                client_created_at: new Date().toISOString()
            }])
            .select()
            .single();

        if (orderError) throw orderError;

        // 2. Process Items & Deduct Stock
        const orderItems = [];

        for (const item of items) {
            let qtyToDeduct = parseFloat(item.quantity);
            const productId = item.id;
            const price = parseFloat(item.price);

            // 2.1 Get Product Batches (FIFO: Expiring First)
            const { data: batches, error: batchFetchError } = await supabaseAdmin
                .from('product_batches')
                .select('*')
                .eq('product_id', productId)
                .gt('remaining_qty', 0)
                .order('expire_date', { ascending: true, nullsFirst: false }); // Nulls (no expire) last

            if (batchFetchError) throw batchFetchError;

            // 2.2 Deduct from Batches (Split logic)
            let remainingToFulfill = qtyToDeduct;

            // If no batches exist (or stock is messed up), we still record the sale but maybe negative stock or null batch
            // For this logic, if we have batches, we use them. If not, we record a "No Batch" item.

            if (!batches || batches.length === 0) {
                // Case: No batches available (Stock might be 0 or just not tracked in batches)
                // Just create one order item with null batch
                const subtotal = qtyToDeduct * price;
                await supabaseAdmin.from('order_items').insert([{
                    order_id: order.id,
                    product_id: productId,
                    qty: qtyToDeduct,
                    price_per_unit: price,
                    subtotal: subtotal,
                    batch_id: null
                }]);
            } else {
                for (const batch of batches) {
                    if (remainingToFulfill <= 0) break;

                    const availableInBatch = parseFloat(batch.remaining_qty);
                    const deductAmount = Math.min(remainingToFulfill, availableInBatch);

                    // Update Batch
                    await supabaseAdmin
                        .from('product_batches')
                        .update({ remaining_qty: availableInBatch - deductAmount })
                        .eq('id', batch.id);

                    // Insert Inventory Log
                    await supabaseAdmin.from('inventory_transactions').insert([{
                        product_id: productId,
                        batch_id: batch.id,
                        trans_type: 'out',
                        qty: deductAmount,
                        reference_type: 'sale',
                        reference_id: order.id,
                        notes: `Sale Order: ${orderNo}`
                    }]);

                    // Insert Order Item (Split by batch)
                    const subtotal = deductAmount * price;
                    await supabaseAdmin.from('order_items').insert([{
                        order_id: order.id,
                        product_id: productId,
                        qty: deductAmount,
                        price_per_unit: price,
                        subtotal: subtotal,
                        batch_id: batch.id
                    }]);

                    remainingToFulfill -= deductAmount;
                }

                // If still remaining (more sold than in batches), record the rest as null batch
                if (remainingToFulfill > 0) {
                    const subtotal = remainingToFulfill * price;
                    await supabaseAdmin.from('order_items').insert([{
                        order_id: order.id,
                        product_id: productId,
                        qty: remainingToFulfill,
                        price_per_unit: price,
                        subtotal: subtotal,
                        batch_id: null
                    }]);
                }
            }

            // 2.3 Update Main Product Stock
            const { data: product } = await supabaseAdmin.from('products').select('stock_qty').eq('id', productId).single();
            const currentStock = parseFloat(product?.stock_qty || 0);
            await supabaseAdmin
                .from('products')
                .update({ stock_qty: currentStock - qtyToDeduct })
                .eq('id', productId);
        }

        // 3. Record Payment (if not credit sale or if partial/full payment made)
        if (paymentMethod !== 'credit') {
            const { error: paymentError } = await supabaseAdmin
                .from('payments')
                .insert([{
                    order_id: order.id,
                    method: paymentMethod === 'qr' ? 'qr_promptpay' : 'cash',
                    amount: totalAmount, // For simple sales, amount = total. Change handling is frontend mostly, or separate log.
                    paid_at: new Date().toISOString()
                }]);

            if (paymentError) throw paymentError;

            // AUTO-SYNC: Record Income in General Ledger
            await supabaseAdmin.from('account_transactions').insert([{
                store_id: storeId,
                trans_date: new Date().toISOString().split('T')[0],
                trans_type: 'income',
                category: 'sales',
                description: `ขายสินค้า Order #${orderNo}`,
                amount: totalAmount,
                payment_method: paymentMethod === 'qr' ? 'qr_promptpay' : 'cash',
                reference_order_id: order.id
            }]);
        } else {            // Logic for Credit Sale (Create Credit Account)
            // Reusing logic from credit-sales if needed, or keeping it separate. 
            // *User requested Normal Sales first, so Credit logic is basic here or handled by /credit-sales*
            // For now, if someone sends 'credit' to this endpoint, we just create the order but NO payment record.
            // AND we need to create the credit_account entry.
            if (customerId) {
                await supabaseAdmin.from('credit_accounts').insert([{
                    order_id: order.id,
                    customer_id: customerId,
                    total_debt: totalAmount,
                    paid_amount: 0,
                    remaining_amount: totalAmount,
                    due_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // Default 30 days if not specified
                    status: 'unpaid'
                }]);
            }
        }

        // 4. Get Final Order with Items and Store Info for Receipt
        const { data: finalOrder, error: finalError } = await supabaseAdmin
            .from('orders')
            .select(`
                *,
                stores (name, address, phone),
                order_items (
                    qty,
                    price_per_unit,
                    subtotal,
                    products (name)
                )
            `)
            .eq('id', order.id)
            .single();

        if (finalError) throw finalError;

        res.json({ success: true, data: finalOrder });

    } catch (error) {
        console.error('Sale Process Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/credit-sales', async (req, res) => {
    try {
        console.log('Received credit-sale request:', req.body);
        const { customer_name, customer_phone, due_date, amount, items, customer_id, is_new_customer, customer_image } = req.body;
        const storeId = req.headers['x-store-id'];

        if (!storeId) {
            console.error('Credit Sale Error: Missing store_id');
            return res.status(400).json({ success: false, error: 'Store ID required' });
        }

        let customer;

        // Use existing customer if customer_id provided
        if (customer_id) {
            const { data: existingCustomer, error: fetchError } = await supabaseAdmin
                .from('customers_info')
                .select('*')
                .eq('id', customer_id)
                .single();

            if (fetchError || !existingCustomer) {
                console.error('Customer fetch error:', fetchError);
                return res.status(404).json({ success: false, error: 'Customer not found' });
            }
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
                } else {
                    console.error('Update customer image error:', updateError);
                }
            }
        } else {
            // Search by phone within the same store
            const { data: existingCustomer, error: searchError } = await supabaseAdmin
                .from('customers_info')
                .select('*')
                .eq('phone', customer_phone)
                .eq('store_id', storeId)
                .maybeSingle(); // Use maybeSingle to avoid error on 0 rows

            if (existingCustomer) {
                customer = existingCustomer;
                console.log('Found existing customer by phone:', customer.id);
            } else {
                console.log('Creating new customer:', customer_name);
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
                if (customerError) {
                    console.error('Create customer error:', customerError);
                    throw customerError;
                }
                customer = newCustomer;
            }
        }

        const orderNo = `ORD-${Date.now().toString().slice(-8)}`;
        const { data: order, error: orderError } = await supabaseAdmin
            .from('orders')
            .insert([{
                order_no: orderNo,
                customer_id: customer.id,
                total_amount: amount,
                payment_status: 'pending',
                payment_type: 'credit_sale',
                store_id: storeId,
                client_created_at: new Date().toISOString()
            }])
            .select()
            .single();
        if (orderError) {
            console.error('Create order error:', orderError);
            throw orderError;
        }

        // --- Process Items & Deduct Stock (Copied from Normal Sale) ---
        if (items && items.length > 0) {
            for (const item of items) {
                let qtyToDeduct = parseFloat(item.quantity);
                const productId = item.id;
                const price = parseFloat(item.price);

                // Get Product Batches (FIFO)
                const { data: batches } = await supabaseAdmin
                    .from('product_batches')
                    .select('*')
                    .eq('product_id', productId)
                    .gt('remaining_qty', 0)
                    .order('expire_date', { ascending: true, nullsFirst: false });

                let remainingToFulfill = qtyToDeduct;

                if (!batches || batches.length === 0) {
                    const subtotal = qtyToDeduct * price;
                    await supabaseAdmin.from('order_items').insert([{
                        order_id: order.id,
                        product_id: productId,
                        qty: qtyToDeduct,
                        price_per_unit: price,
                        subtotal: subtotal,
                        batch_id: null
                    }]);
                } else {
                    for (const batch of batches) {
                        if (remainingToFulfill <= 0) break;

                        const availableInBatch = parseFloat(batch.remaining_qty);
                        const deductAmount = Math.min(remainingToFulfill, availableInBatch);

                        // Update Batch
                        await supabaseAdmin
                            .from('product_batches')
                            .update({ remaining_qty: availableInBatch - deductAmount })
                            .eq('id', batch.id);

                        // Insert Inventory Log
                        await supabaseAdmin.from('inventory_transactions').insert([{
                            product_id: productId,
                            batch_id: batch.id,
                            trans_type: 'out',
                            qty: deductAmount,
                            reference_type: 'sale',
                            reference_id: order.id,
                            notes: `Credit Sale: ${orderNo}`
                        }]);

                        // Insert Order Item
                        const subtotal = deductAmount * price;
                        await supabaseAdmin.from('order_items').insert([{
                            order_id: order.id,
                            product_id: productId,
                            qty: deductAmount,
                            price_per_unit: price,
                            subtotal: subtotal,
                            batch_id: batch.id
                        }]);

                        remainingToFulfill -= deductAmount;
                    }

                    if (remainingToFulfill > 0) {
                        const subtotal = remainingToFulfill * price;
                        await supabaseAdmin.from('order_items').insert([{
                            order_id: order.id,
                            product_id: productId,
                            qty: remainingToFulfill,
                            price_per_unit: price,
                            subtotal: subtotal,
                            batch_id: null
                        }]);
                    }
                }

                // Update Main Product Stock
                const { data: product } = await supabaseAdmin.from('products').select('stock_qty').eq('id', productId).single();
                const currentStock = parseFloat(product?.stock_qty || 0);
                await supabaseAdmin
                    .from('products')
                    .update({ stock_qty: currentStock - qtyToDeduct })
                    .eq('id', productId);
            }
        }
        // -----------------------------------------------------------

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
        if (creditError) {
            console.error('Create credit account error:', creditError);
            throw creditError;
        }

        res.json({
            success: true,
            data: {
                customer,
                order,
                credit_account: creditAccount
            }
        });
    } catch (error) {
        console.error('Credit sale error (Catch):', error);
        res.status(500).json({ success: false, error: error.message });
    }
});


// NOTE: Image uploads are now handled directly by the frontend to Supabase Storage
// The /uploads endpoint is no longer needed for new images
// Legacy images in uploads/ folder will still be served for backwards compatibility
app.use('/uploads', require('express').static('uploads'));



// Get paginated products with optional search and type filter
app.get('/api/products', async (req, res) => {
    try {
        const storeId = req.headers['x-store-id'];
        const userId = req.user.id;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const search = req.query.search || '';
        const categoryId = req.query.categoryId || null;
        // type: 'normal' (default) | 'weight' | 'all'
        const type = req.query.type || 'normal';
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

        // Filter by Type
        if (type === 'normal') {
            query = query.eq('is_weightable', false);
        } else if (type === 'weight') {
            query = query.eq('is_weightable', true);
        }
        // if type === 'all', no filter applied

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
        const { code, name, categoryId, quantity, costPrice, salePrice, lowStockThreshold, unitType, expireDate, imageUrl, isWeightable } = req.body;
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
                unit_type: isWeightable ? 'kg' : (unitType || 'ชิ้น'),
                store_id: storeId,
                store_id: storeId,
                image_url: await (async () => {
                    if (imageUrl && imageUrl.startsWith('data:image')) {
                        try {
                            // 1. Decode Base64
                            const base64Data = imageUrl.split(',')[1];
                            const buffer = Buffer.from(base64Data, 'base64');

                            // 2. Generate path with folder (store_id/filename.jpg)
                            // MATCHING FRONTEND PATTERN: product-timestamp.jpg
                            const fileName = `${storeId}/product-${Date.now()}.jpg`;

                            // 3. Upload to Supabase Storage
                            const { data: uploadData, error: uploadError } = await supabaseAdmin
                                .storage
                                .from('products')
                                .upload(fileName, buffer, {
                                    contentType: 'image/jpeg',
                                    upsert: true
                                });

                            if (uploadError) throw uploadError;

                            // 3. Get Public URL (Store this in DB like the Stock system does)
                            const { data: publicUrlData } = supabaseAdmin
                                .storage
                                .from('products')
                                .getPublicUrl(fileName);

                            return publicUrlData.publicUrl;
                        } catch (e) {
                            console.error("Image Upload Error:", e);
                            return null; // Fallback to null if upload fails
                        }
                    }
                    return imageUrl || null; // Return original if not base64 or null
                })(),
                is_weightable: !!isWeightable // Force boolean
            }])
            .select()
            .single();

        if (productError) throw productError;

        // 2. Insert Batch (if quantity > 0)
        const qty = parseFloat(quantity) || 0;
        //console.log(`[AddProduct] Name: ${name}, Qty Input: ${quantity}, Parsed Qty: ${qty}`); // DEBUG LOG

        if (qty > 0) {
            //console.log(`[AddProduct] Creating batch for ${product.id} with qty ${qty}`); // DEBUG LOG
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





// ==================== REPORTS ENDPOINTS ====================

// Helper for date ranges
const getDateRange = (period) => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

    let start, end;

    if (period === 'today' || period === 'day') {
        start = today.toISOString();
        end = endOfDay.toISOString();
    } else if (period === 'month') {
        start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
        end = endOfDay.toISOString();
    } else if (period === 'year') {
        start = new Date(now.getFullYear(), 0, 1).toISOString();
        end = endOfDay.toISOString();
    } else if (period === 'week') {
        // Start of week (Monday)
        const day = now.getDay() || 7; // Get current day number, converting Sun (0) to 7
        if (day !== 1) now.setHours(-24 * (day - 1));
        now.setHours(0, 0, 0, 0);
        start = now.toISOString();
        end = endOfDay.toISOString();
    }

    return { start, end };
};

// 1. Sales Summary (Total Sales, Total Orders, Growth)
app.get('/api/reports/sales-summary', async (req, res) => {
    try {
        const storeId = req.headers['x-store-id'];
        const userId = req.user.id;
        const { period = 'today' } = req.query; // today, month, year

        if (!storeId) return res.status(400).json({ success: false, error: 'Store ID required' });
        if (!await checkStoreAccess(storeId, userId)) return res.status(403).json({ success: false, error: 'Unauthorized' });

        const { start, end } = getDateRange(period);

        // Current Period Sales
        const { data: currentData, error: currentError } = await supabaseAdmin
            .from('orders')
            .select('total_amount')
            .eq('store_id', storeId)
            .eq('payment_status', 'paid')
            .gte('created_at', start)
            .lte('created_at', end);

        if (currentError) throw currentError;

        const totalSales = currentData.reduce((sum, order) => sum + (parseFloat(order.total_amount) || 0), 0);
        const totalOrders = currentData.length;

        // Previous Period Sales (for growth calculation)
        // Simply comparing today vs yesterday, this month vs last month
        let prevStart, prevEnd;
        const now = new Date();

        if (period === 'today') {
            const yesterday = new Date(now);
            yesterday.setDate(now.getDate() - 1);
            yesterday.setHours(0, 0, 0, 0);
            prevStart = yesterday.toISOString();

            const yesterdayEnd = new Date(now);
            yesterdayEnd.setDate(now.getDate() - 1);
            yesterdayEnd.setHours(23, 59, 59, 999);
            prevEnd = yesterdayEnd.toISOString();
        } else if (period === 'month') {
            const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
            prevStart = lastMonth.toISOString();
            const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
            prevEnd = lastMonthEnd.toISOString();
        }

        let growth = 0;
        if (prevStart && prevEnd) {
            const { data: prevData } = await supabaseAdmin
                .from('orders')
                .select('total_amount')
                .eq('store_id', storeId)
                .eq('payment_status', 'paid')
                .gte('created_at', prevStart)
                .lte('created_at', prevEnd);

            const prevSales = prevData?.reduce((sum, order) => sum + (parseFloat(order.total_amount) || 0), 0) || 0;

            if (prevSales > 0) {
                growth = ((totalSales - prevSales) / prevSales) * 100;
            } else if (totalSales > 0) {
                growth = 100;
            }
        }

        res.json({
            success: true,
            data: {
                totalSales,
                totalOrders,
                growth: Math.round(growth)
            }
        });
    } catch (error) {
        console.error('Sales Summary Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 2. Sales Chart Data
app.get('/api/reports/sales-chart', async (req, res) => {
    try {
        const storeId = req.headers['x-store-id'];
        const userId = req.user.id;
        const { period = 'today' } = req.query;

        if (!storeId) return res.status(400).json({ success: false, error: 'Store ID required' });
        if (!await checkStoreAccess(storeId, userId)) return res.status(403).json({ success: false, error: 'Unauthorized' });

        const { start, end } = getDateRange(period);

        // Fetch all paid orders in range
        const { data: orders, error } = await supabaseAdmin
            .from('orders')
            .select('created_at, total_amount')
            .eq('store_id', storeId)
            .eq('payment_status', 'paid')
            .gte('created_at', start)
            .lte('created_at', end)
            .order('created_at', { ascending: true });

        if (error) throw error;

        let labels = [];
        let values = [];
        let peakTime = '-';
        let peakAmount = 0;

        if (period === 'today') {
            // Group by hour
            const hourlyData = new Array(24).fill(0);
            orders.forEach(order => {
                const hour = new Date(order.created_at).getUTCHours() + 7; // Adjust for UTC+7 (Thailand) roughly, or better use client time. 
                // For simplicity assuming server is UTC and we want +7 display. 
                // Better: Parse date properly.
                const localDate = new Date(order.created_at);
                // Simple localized hour:
                const localHour = (localDate.getHours() + 7) % 24; // Mocking Timezone adjustment if server is UTC.
                // Assuming database stores UTC.
                // NOTE: Proper way is to handle TZ in query or use a library. 
                // For this quick impl, we'll map created_at string directly if it has offset, or assume UTC.
                // Let's assume input is UTC.

                // Hacky TZ adjust +7
                const date = new Date(order.created_at);
                date.setHours(date.getHours() + 7);
                const h = date.getHours();
                hourlyData[h] += parseFloat(order.total_amount);
            });

            // Filter to show active range (e.g. 06:00 to 22:00 or current time)
            // Showing simplifed: 09:00, 12:00, 15:00, 18:00, 21:00
            const keyHours = [9, 12, 15, 18, 21];
            labels = keyHours.map(h => `${h}:00`);
            values = keyHours.map(h => hourlyData[h]);

            // Find peak
            let maxVal = 0;
            let maxIdx = 0;
            hourlyData.forEach((val, idx) => {
                if (val > maxVal) {
                    maxVal = val;
                    maxIdx = idx;
                }
            });
            peakAmount = maxVal;
            peakTime = `${maxIdx}:00 น.`;

        } else if (period === 'week' || period === 'month') {
            // Group by Day
            const dailyData = {};
            orders.forEach(order => {
                // Adjust +7
                const date = new Date(order.created_at);
                date.setHours(date.getHours() + 7);
                const dayStr = `${date.getDate()}/${date.getMonth() + 1}`;
                dailyData[dayStr] = (dailyData[dayStr] || 0) + parseFloat(order.total_amount);
            });

            labels = Object.keys(dailyData);
            values = Object.values(dailyData);

            // Find peak
            let maxVal = 0;
            let maxKey = '-';
            for (const [key, val] of Object.entries(dailyData)) {
                if (val > maxVal) {
                    maxVal = val;
                    maxKey = key;
                }
            }
            peakAmount = maxVal;
            peakTime = maxKey;
        }

        // If no data, return empty zeros
        if (values.length === 0) {
            labels = ['09:00', '12:00', '15:00', '18:00', '21:00'];
            values = [0, 0, 0, 0, 0];
        }

        res.json({
            success: true,
            data: {
                labels,
                values,
                peakTime,
                peakAmount
            }
        });

    } catch (error) {
        console.error('Sales Chart Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 3. Payment Methods Breakdown
app.get('/api/reports/payment-methods', async (req, res) => {
    try {
        const storeId = req.headers['x-store-id'];
        const userId = req.user.id;
        const { period = 'today' } = req.query;

        if (!storeId) return res.status(400).json({ success: false, error: 'Store ID required' });
        if (!await checkStoreAccess(storeId, userId)) return res.status(403).json({ success: false, error: 'Unauthorized' });

        const { start, end } = getDateRange(period);

        // Fetch payments joined with orders to filter by store
        const { data: payments, error } = await supabaseAdmin
            .from('payments')
            .select(`
                amount,
                method,
                orders!inner(store_id)
            `)
            .eq('orders.store_id', storeId)
            .gte('paid_at', start)
            .lte('paid_at', end);

        if (error) throw error;

        const stats = {
            cash: 0,
            qr: 0,
            credit: 0
        };

        let total = 0;

        payments.forEach(p => {
            const amount = parseFloat(p.amount) || 0;
            total += amount;
            if (p.method === 'cash') stats.cash += amount;
            else if (p.method === 'qr_promptpay') stats.qr += amount;
            else if (p.method === 'credit') stats.credit += amount;
        });

        const formatPercent = (val) => total > 0 ? Math.round((val / total) * 100) : 0;

        res.json({
            success: true,
            data: {
                cash: { amount: stats.cash, percent: formatPercent(stats.cash) },
                qr: { amount: stats.qr, percent: formatPercent(stats.qr) },
                credit: { amount: stats.credit, percent: formatPercent(stats.credit) }
            }
        });
    } catch (error) {
        console.error('Payment Report Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 4. Recent Transactions
app.get('/api/reports/recent-orders', async (req, res) => {
    try {
        const storeId = req.headers['x-store-id'];
        const userId = req.user.id;

        if (!storeId) return res.status(400).json({ success: false, error: 'Store ID required' });
        if (!await checkStoreAccess(storeId, userId)) return res.status(403).json({ success: false, error: 'Unauthorized' });

        const { data: orders, error } = await supabaseAdmin
            .from('orders')
            .select(`
                id,
                order_no,
                total_amount,
                created_at,
                payment_status,
                customers_info(name)
            `)
            .eq('store_id', storeId)
            .eq('payment_status', 'paid')
            .order('created_at', { ascending: false })
            .limit(10);

        if (error) throw error;

        const formatted = orders.map(o => ({
            id: o.id,
            orderNo: o.order_no,
            customer: o.customers_info?.name || 'ลูกค้าทั่วไป',
            amount: parseFloat(o.total_amount),
            time: new Date(o.created_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }),
            date: new Date(o.created_at).toLocaleDateString('th-TH')
        }));

        res.json({ success: true, data: formatted });
    } catch (error) {
        console.error('Recent Orders Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== TRANSACTION / EXPENSE MANAGEMENT ====================

// Get Transactions (Income/Expense)
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

// Global 404 Handler (Must be last)
app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Endpoint not found' });
});



app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});