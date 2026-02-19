const registerSalesRoutes = ({
    app,
    supabaseAdmin,
    checkStoreAccess,
    upsertNotificationGlobal,
    convertDateFormat
}) => {
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

            // Use client-provided timestamp if available (for offline sync), otherwise use now
            const orderDate = req.body.client_created_at || new Date().toISOString();

            const { data: order, error: orderError } = await supabaseAdmin
                .from('orders')
                .insert([{
                    order_no: orderNo,
                    customer_id: customerId || null,
                    total_amount: totalAmount,
                    payment_status: paymentMethod === 'credit' ? 'pending' : 'paid',
                    payment_type: paymentMethod === 'credit' ? 'credit_sale' : 'cash_sale',
                    store_id: storeId,
                    created_at: orderDate, // Override created_at with actual sale time
                    client_created_at: orderDate, // Keep track of client time explicitly
                    synced: true // Mark as synced since it reached the server
                }])
                .select()
                .single();

            if (orderError) throw orderError;

            // 2. Process Items & Deduct Stock
            const orderItems = [];

            for (const item of items) {
                // 1. Determine Unit & Conversion
                // If unit_code is present (weighted item), use it to convert to base unit (kg) for stock
                // If not (normal item), use 1:1
                const unitCode = item.unit_code;
                const unitLabel = item.unit || item.unit_type || 'ชิ้น'; // Fallback to 'ชิ้น'

                let conversion = 1;
                if (unitCode === 'g') conversion = 0.001;
                else if (unitCode === 'h') conversion = 0.1;
                // else default 1 (kg or pieces)

                let qtyToDeduct = parseFloat(item.quantity) * conversion;
                const productId = item.product_id || item.id; // product_id for weight items, id for normal
                const price = parseFloat(item.price); // This is price per UNIT (e.g. per gram)

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
                    // Qty recorded is the original item.quantity (e.g. 500 g)
                    const subtotal = item.quantity * price;
                    await supabaseAdmin.from('order_items').insert([{
                        order_id: order.id,
                        product_id: productId,
                        qty: item.quantity, // Record 500
                        unit: unitLabel,    // Record "กรัม"
                        price_per_unit: price,
                        subtotal: subtotal,
                        batch_id: null,
                        promotion_id: item.promotion?.id || null,
                        cost_price_at_sale: item.cost_price || null,
                        weight: item.isWeight ? item.quantity : null
                    }]);
                } else {
                    for (const batch of batches) {
                        if (remainingToFulfill <= 0) break;

                        const availableInBatch = parseFloat(batch.remaining_qty);
                        const deductAmount = Math.min(remainingToFulfill, availableInBatch); // In KG

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
                            qty: deductAmount, // Store specific stock unit (kg)
                            reference_type: 'sale',
                            reference_id: order.id,
                            notes: `Sale Order: ${orderNo} (${unitLabel})`
                        }]);

                        // Insert Order Item (Split by batch)
                        // We need to convert deductAmount (KG) back to Item Unit (e.g. Grams) for the receipt/record
                        const recordedQty = deductAmount / conversion;
                        const subtotal = recordedQty * price;

                        await supabaseAdmin.from('order_items').insert([{
                            order_id: order.id,
                            product_id: productId,
                            qty: recordedQty,
                            unit: unitLabel,
                            price_per_unit: price,
                            subtotal: subtotal,
                            batch_id: batch.id,
                            promotion_id: item.promotion?.id || null,
                            cost_price_at_sale: item.cost_price || null,
                            weight: item.isWeight ? recordedQty : null
                        }]);

                        remainingToFulfill -= deductAmount;
                    }

                    // If still remaining (more sold than in batches), record the rest as null batch
                    if (remainingToFulfill > 0) {
                        const recordedQty = remainingToFulfill / conversion;
                        const subtotal = recordedQty * price;
                        await supabaseAdmin.from('order_items').insert([{
                            order_id: order.id,
                            product_id: productId,
                            qty: recordedQty,
                            unit: unitLabel,
                            price_per_unit: price,
                            subtotal: subtotal,
                            batch_id: null,
                            promotion_id: item.promotion?.id || null,
                            cost_price_at_sale: item.cost_price || null,
                            weight: item.isWeight ? recordedQty : null
                        }]);
                    }
                }

                // 2.3 Update Main Product Stock & Check for Notifications
                const { data: product } = await supabaseAdmin
                    .from('products')
                    .select('stock_qty, low_stock_threshold, name')
                    .eq('id', productId)
                    .single();

                const currentStock = parseFloat(product?.stock_qty || 0);
                const threshold = parseFloat(product?.low_stock_threshold || 0);
                const newStock = currentStock - qtyToDeduct;

                await supabaseAdmin
                    .from('products')
                    .update({ stock_qty: newStock })
                    .eq('id', productId);

                // REALTIME STOCK CHECK (Event-Driven)
                if (newStock <= 0) {
                    await upsertNotificationGlobal(
                        storeId,
                        'stock_out',
                        'สินค้าหมด',
                        product.name,
                        'stock',
                        'high', // Priority
                        productId,
                        'product',
                        { product_id: productId }
                    );
                } else if (threshold > 0 && newStock <= threshold) {
                    await upsertNotificationGlobal(
                        storeId,
                        'stock_low',
                        'สินค้าใกล้หมด',
                        `${product.name}\nเหลือ ${newStock} ชิ้น`,
                        'stock',
                        'medium', // Priority
                        productId,
                        'product',
                        { product_id: productId, stock_qty: newStock, threshold: threshold }
                    );
                }
            }

            // 3. Record Payment (if not credit sale or if partial/full payment made)
            if (paymentMethod !== 'credit') {
                const changeAmount = (receivedAmount || totalAmount) - totalAmount;

                const { error: paymentError } = await supabaseAdmin
                    .from('payments')
                    .insert([{
                        order_id: order.id,
                        method: paymentMethod === 'qr' ? 'qr_promptpay' : 'cash',
                        amount: totalAmount,
                        paid_at: new Date().toISOString(),
                        // Use dedicated columns for better data integrity
                        tendered_amount: receivedAmount || totalAmount,
                        change_amount: changeAmount > 0 ? changeAmount : 0
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
                    products (name),
                    unit,
                    weight,
                    promotion_id,
                    cost_price_at_sale
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

                // Handle Image Upload (if Base64)
                let finalImageUrl = customer_image;
                if (customer_image && customer_image.startsWith('data:image')) {
                    try {
                        const base64Data = customer_image.split(',')[1];
                        const buffer = Buffer.from(base64Data, 'base64');
                        const fileName = `${storeId}/customer-${Date.now()}.jpg`;

                        const { error: uploadError } = await supabaseAdmin
                            .storage
                            .from('customers')
                            .upload(fileName, buffer, {
                                contentType: 'image/jpeg',
                                upsert: true
                            });

                        if (uploadError) throw uploadError;

                        const { data: publicUrlData } = supabaseAdmin
                            .storage
                            .from('customers')
                            .getPublicUrl(fileName);

                        finalImageUrl = publicUrlData.publicUrl;
                    } catch (e) {
                        console.error("Customer Image Upload Error:", e);
                        // Fallback to null or keep original if upload fails? 
                        // Let's keep original string if it fails, though it's huge.
                        // Better to set null if upload fails to avoid DB error with huge string
                        finalImageUrl = null;
                    }
                }

                // Update image if provided and different
                if (finalImageUrl && customer.image_url !== finalImageUrl) {
                    const { data: updatedCustomer, error: updateError } = await supabaseAdmin
                        .from('customers_info')
                        .update({ image_url: finalImageUrl })
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

                    // Handle Image Upload for New Customer
                    let finalImageUrl = customer_image;
                    if (customer_image && customer_image.startsWith('data:image')) {
                        try {
                            const base64Data = customer_image.split(',')[1];
                            const buffer = Buffer.from(base64Data, 'base64');
                            const fileName = `${storeId}/customer-${Date.now()}.jpg`;

                            const { error: uploadError } = await supabaseAdmin
                                .storage
                                .from('customers')
                                .upload(fileName, buffer, {
                                    contentType: 'image/jpeg',
                                    upsert: true
                                });

                            if (uploadError) throw uploadError;

                            const { data: publicUrlData } = supabaseAdmin
                                .storage
                                .from('customers')
                                .getPublicUrl(fileName);

                            finalImageUrl = publicUrlData.publicUrl;
                        } catch (e) {
                            console.error("New Customer Image Upload Error:", e);
                            finalImageUrl = null;
                        }
                    }

                    // Create new customer with store_id
                    const { data: newCustomer, error: customerError } = await supabaseAdmin
                        .from('customers_info')
                        .insert([{
                            name: customer_name,
                            phone: customer_phone,
                            store_id: storeId,
                            image_url: finalImageUrl || null,
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
                    // 1. Determine Unit & Conversion (Same as Normal Sale)
                    const unitCode = item.unit_code;
                    const unitLabel = item.unit || item.unit_type || 'ชิ้น';

                    let conversion = 1;
                    if (unitCode === 'g') conversion = 0.001;
                    else if (unitCode === 'h') conversion = 0.1;

                    let qtyToDeduct = parseFloat(item.quantity) * conversion;
                    const productId = item.product_id || item.id;
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
                        const subtotal = item.quantity * price;
                        await supabaseAdmin.from('order_items').insert([{
                            order_id: order.id,
                            product_id: productId,
                            qty: item.quantity,
                            unit: unitLabel,
                            price_per_unit: price,
                            subtotal: subtotal,
                            batch_id: null,
                            promotion_id: item.promotion?.id || null,
                            cost_price_at_sale: item.cost_price || null,
                            weight: item.isWeight ? item.quantity : null
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
                                notes: `Credit Sale: ${orderNo} (${unitLabel})`
                            }]);

                            // Insert Order Item
                            const recordedQty = deductAmount / conversion;
                            const subtotal = recordedQty * price;

                            await supabaseAdmin.from('order_items').insert([{
                                order_id: order.id,
                                product_id: productId,
                                qty: recordedQty,
                                unit: unitLabel,
                                price_per_unit: price,
                                subtotal: subtotal,
                                batch_id: batch.id,
                                promotion_id: item.promotion?.id || null,
                                cost_price_at_sale: item.cost_price || null,
                                weight: item.isWeight ? recordedQty : null
                            }]);

                            remainingToFulfill -= deductAmount;
                        }

                        if (remainingToFulfill > 0) {
                            const recordedQty = remainingToFulfill / conversion;
                            const subtotal = recordedQty * price;

                            await supabaseAdmin.from('order_items').insert([{
                                order_id: order.id,
                                product_id: productId,
                                qty: recordedQty,
                                unit: unitLabel,
                                price_per_unit: price,
                                subtotal: subtotal,
                                batch_id: null,
                                promotion_id: item.promotion?.id || null,
                                cost_price_at_sale: item.cost_price || null,
                                weight: item.isWeight ? recordedQty : null
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

            // NEW: Update Customer's Global Due Date
            if (due_date) {
                const { error: updateDueError } = await supabaseAdmin
                    .from('customers_info')
                    .update({ due_date: convertDateFormat(due_date) })
                    .eq('id', customer.id);

                if (updateDueError) {
                    console.error('Failed to update customer due_date:', updateDueError);
                    // Continue despite error, as sale is more important
                }
            }

            const { data: creditAccount, error: creditError } = await supabaseAdmin
                .from('credit_accounts')
                .insert([{
                    order_id: order.id,
                    customer_id: customer.id,
                    total_debt: amount,
                    paid_amount: 0,
                    remaining_amount: amount,
                    // due_date: convertDateFormat(due_date), // REMOVED per user request
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

};

module.exports = { registerSalesRoutes };
