const registerProductRoutes = ({
    app,
    supabaseAdmin,
    categoryValidators,
    checkStoreAccess,
    convertDateFormat,
    deleteNotificationGlobal
}) => {
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
                .select('id, barcode, name, price, cost_price, stock_qty, image_url, category_id, is_weightable, unit_type')
                .order('name', { ascending: true })
                .eq('store_id', storeId)
                .is('deleted_at', null);

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

            // --- Attach Active Promotions ---
            if (data && data.length > 0) {
                const productIds = data.map(p => p.id);
                const today = new Date().toISOString().split('T')[0];

                const { data: promos, error: promoError } = await supabaseAdmin
                    .from('promotion_items')
                    .select(`
                    product_id,
                    promotions!inner (
                        id, name, type, discount_value, 
                        min_qty_required, free_qty, 
                        start_date, end_date, min_spend
                    )
                `)
                    .in('product_id', productIds)
                    .eq('promotions.is_active', true)
                    .lte('promotions.start_date', today)
                    .gte('promotions.end_date', today);

                if (!promoError && promos) {
                    // Map promotions to products
                    const promoMap = {};
                    promos.forEach(item => {
                        promoMap[item.product_id] = item.promotions;
                    });

                    data.forEach(p => {
                        const promo = promoMap[p.id];
                        if (promo) {
                            p.original_price = p.price;
                            p.is_promotion = true;
                            p.promotion = {
                                id: promo.id,
                                name: promo.name,
                                type: promo.type,
                                discount_value: promo.discount_value,
                                min_qty: promo.min_qty_required,
                                free_qty: promo.free_qty,
                                min_spend: promo.min_spend || null
                            };

                            if (promo.type === 'discount_percent') {
                                const discountPercent = parseFloat(promo.discount_value);
                                p.discount_percent = discountPercent;
                                p.price = Math.round(p.price * (1 - discountPercent / 100));
                            } else if (promo.type === 'buy_x_get_y') {
                                // Price stays same, logic handled in cart
                            } else if (promo.type === 'discount_amount') {
                                const discountAmt = parseFloat(promo.discount_value);
                                p.price = Math.max(0, p.price - discountAmt);
                            } else if (promo.type === 'bundle') {
                                //Bundle: price stay same, logic in cart
                            }
                        } else {
                            p.is_promotion = false;
                            p.discount_percent = 0;
                            p.original_price = p.price;
                        }
                    });
                }
            }
            // --------------------------------

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
                .eq('store_id', storeId)
                .is('deleted_at', null);

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

            // Check for active promotion (Detailed)
            let promotion = null;
            let finalPrice = data.price;
            let discountPercent = 0;

            const today = new Date().toISOString().split('T')[0];

            const { data: promoItems, error: promoError } = await supabaseAdmin
                .from('promotion_items')
                .select(`
                promotions!inner (
                    id, name, type, discount_value, 
                    min_qty_required, free_qty, 
                    start_date, end_date, min_spend
                )
            `)
                .eq('product_id', data.id)
                .eq('promotions.is_active', true)
                .lte('promotions.start_date', today)
                .gte('promotions.end_date', today)
                .limit(1);

            console.log('[DEBUG] Promo query result:', JSON.stringify(promoItems), 'error:', promoError);
            if (!promoError && promoItems && promoItems.length > 0) {
                const p = promoItems[0].promotions;

                if (p.type === 'discount_percent') {
                    discountPercent = parseFloat(p.discount_value);
                    finalPrice = Math.round(data.price * (1 - discountPercent / 100));
                } else if (p.type === 'buy_x_get_y') {
                    // For B1G1, unit price is same, logic handles in cart
                } else if (p.type === 'discount_amount') {
                    finalPrice = Math.max(0, data.price - parseFloat(p.discount_value));
                } else if (p.type === 'bundle') {
                    //Bundle: price same, discount at checkout
                }

                promotion = {
                    id: p.id,
                    name: p.name,
                    type: p.type,
                    discount_value: p.discount_value,
                    min_qty: p.min_qty_required,
                    free_qty: p.free_qty,
                    min_spend: p.min_spend || null
                };
            }

            res.json({
                success: true,
                exists: true,
                data: {
                    ...data,
                    batches: batches || [],
                    price: finalPrice, // Discounted price if percentage
                    original_price: data.price,
                    discount_percent: discountPercent,
                    is_promotion: !!promotion,
                    promotion: promotion // Full promotion object
                }
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
            const storeId = req.headers['x-store-id']; // Needed for notification cleanup
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
                .select('stock_qty, cost_price, price, low_stock_threshold')
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

            // AUTO-RESOLVE: Stock added -> Clear "Stock Out" and "Low Stock" alerts
            // If stock is now healthy (or user just wants to clear alerts by restocking)
            if (storeId) {
                await deleteNotificationGlobal(storeId, ['stock_out', 'stock_low'], id, 'product');
            }

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
                .is('deleted_at', null)
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

    // Update product price (used by AI pricing recommendation)
    app.put('/api/products/:id/price', async (req, res) => {
        try {
            const { id } = req.params;
            const { newPrice } = req.body;
            const storeId = req.headers['x-store-id'];

            if (!newPrice || isNaN(newPrice) || parseFloat(newPrice) < 0) {
                return res.status(400).json({ success: false, error: 'ราคาไม่ถูกต้อง' });
            }

            const { data, error } = await supabaseAdmin
                .from('products')
                .update({ price: parseFloat(newPrice) })
                .eq('id', id)
                .eq('store_id', storeId)
                .select('id, name, price, cost_price, stock_qty')
                .single();

            if (error) throw error;
            if (!data) return res.status(404).json({ success: false, error: 'ไม่พบสินค้า' });

            res.json({ success: true, data });
        } catch (error) {
            console.error('Update Product Price Error:', error);
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
                    unit_type: unitType || 'ชิ้น',
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
};

module.exports = { registerProductRoutes };
