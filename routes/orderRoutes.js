const registerOrderRoutes = ({ app, supabaseAdmin, checkStoreAccess }) => {
    app.get('/api/orders', async (req, res) => {
        try {
            const storeId = req.headers['x-store-id'];
            const userId = req.user.id;
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 20;
            const offset = (page - 1) * limit;

            // Filters
            const { startDate, endDate, status, sort, paymentMethod } = req.query;

            if (!storeId) return res.status(400).json({ success: false, error: 'Store ID required' });
            if (!await checkStoreAccess(storeId, userId)) return res.status(403).json({ success: false, error: 'Unauthorized' });

            let query = supabaseAdmin
                .from('orders')
                .select(`
                id,
                order_no,
                total_amount,
                created_at,
                payment_status,
                payment_type,
                customers_info(name),
                payments(method)
            `, { count: 'exact' })
                .eq('store_id', storeId);

            // --- Apply Filters ---

            // 1. Date Range
            if (startDate) {
                query = query.gte('created_at', startDate);
            }
            if (endDate) {
                query = query.lte('created_at', endDate);
            }

            // 2. Status
            if (status) {
                if (status === 'paid') {
                    query = query.eq('payment_status', 'paid');
                } else if (status === 'unpaid') {
                    query = query.in('payment_status', ['pending', 'partial', 'cancelled']);
                }
                else if (status === 'pending') {
                    query = query.eq('payment_status', 'pending');
                }
            }

            // 3. Payment Method (Cash, QR, Credit)
            if (paymentMethod) {
                if (paymentMethod === 'credit') {
                    query = query.eq('payment_type', 'credit_sale');
                } else if (paymentMethod === 'cash') {
                    // Filter where associated payment is cash
                    // Note: This requires !inner join behavior to filter parent rows
                    // Re-define select to use inner join for filtering
                    query = supabaseAdmin
                        .from('orders')
                        .select(`
                        id,
                        order_no,
                        total_amount,
                        created_at,
                        payment_status,
                        payment_type,
                        customers_info(name),
                        payments!inner(method)
                    `, { count: 'exact' })
                        .eq('store_id', storeId)
                        .eq('payments.method', 'cash');

                    // Re-apply date filters if needed (duplication, but necessary if query object reset)
                    if (startDate) query = query.gte('created_at', startDate);
                    if (endDate) query = query.lte('created_at', endDate);

                } else if (paymentMethod === 'qr') {
                    query = supabaseAdmin
                        .from('orders')
                        .select(`
                        id,
                        order_no,
                        total_amount,
                        created_at,
                        payment_status,
                        payment_type,
                        customers_info(name),
                        payments!inner(method)
                    `, { count: 'exact' })
                        .eq('store_id', storeId)
                        .eq('payments.method', 'qr_promptpay');

                    if (startDate) query = query.gte('created_at', startDate);
                    if (endDate) query = query.lte('created_at', endDate);
                }
            }

            // 3. Sorting
            // sort: 'newest' | 'oldest' | 'highest' | 'lowest'
            if (sort === 'oldest') {
                query = query.order('created_at', { ascending: true });
            } else if (sort === 'highest') {
                query = query.order('total_amount', { ascending: false });
            } else if (sort === 'lowest') {
                query = query.order('total_amount', { ascending: true });
            } else {
                // Default: Newest
                query = query.order('created_at', { ascending: false });
            }

            // Pagination
            query = query.range(offset, offset + limit - 1);

            const { data: orders, count, error } = await query;

            if (error) throw error;

            const formatted = orders.map(o => {
                // Determine method for display
                let method = 'other';
                if (o.payment_type === 'credit_sale') method = 'credit';
                else if (o.payments && o.payments.length > 0) {
                    if (o.payments[0].method === 'cash') method = 'cash';
                    else if (o.payments[0].method === 'qr_promptpay') method = 'qr';
                }

                return {
                    id: o.id,
                    orderNo: o.order_no,
                    customer: o.customers_info?.name || 'ลูกค้าทั่วไป',
                    amount: parseFloat(o.total_amount),
                    time: new Date(o.created_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }),
                    date: new Date(o.created_at).toLocaleDateString('th-TH'),
                    paymentStatus: o.payment_status,
                    paymentType: o.payment_type,
                    method: method // cash, qr, credit, other
                };
            });

            res.json({ success: true, data: formatted, total: count, page, limit });
        } catch (error) {
            console.error('Get Orders Error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Cancel Order (called when deleting a linked sales transaction)
    app.patch('/api/orders/:id/cancel', async (req, res) => {
        try {
            const { id } = req.params;
            const storeId = req.headers['x-store-id'];
            const userId = req.user.id;

            if (!storeId) return res.status(400).json({ success: false, error: 'Store ID required' });
            if (!await checkStoreAccess(storeId, userId)) return res.status(403).json({ success: false, error: 'Unauthorized' });

            const { error } = await supabaseAdmin
                .from('orders')
                .update({ payment_status: 'cancelled' })
                .eq('id', id)
                .eq('store_id', storeId);

            if (error) throw error;

            res.json({ success: true });
        } catch (error) {
            console.error('Cancel Order Error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Get Single Order Details (for Receipt)
    app.get('/api/orders/:id', async (req, res) => {
        try {
            const { id } = req.params;
            const storeId = req.headers['x-store-id'];
            const userId = req.user.id;

            if (!storeId) return res.status(400).json({ success: false, error: 'Store ID required' });
            if (!await checkStoreAccess(storeId, userId)) return res.status(403).json({ success: false, error: 'Unauthorized' });

            // Get Order + Items + Store Info + Payments
            const { data: order, error } = await supabaseAdmin
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
                ),
                payments (method, amount, paid_at, tendered_amount, change_amount)
            `)
                .eq('id', id)
                .eq('store_id', storeId) // Security check
                .single();

            if (error) throw error;

            // Determine Payment Method Display
            let paymentMethodDisplay = 'เงินสด';
            let received = parseFloat(order.total_amount);
            let change = 0;

            if (order.payment_type === 'credit_sale') {
                paymentMethodDisplay = 'เครดิต (ค้างจ่าย)';
                received = 0;
            } else if (order.payments && order.payments.length > 0) {
                const p = order.payments[0];
                if (p.method === 'qr_promptpay') {
                    paymentMethodDisplay = 'สแกน QR';
                } else if (p.method === 'credit') {
                    paymentMethodDisplay = 'บัตรเครดิต';
                } else {
                    paymentMethodDisplay = 'เงินสด';
                }

                // Use dedicated columns if available
                if (p.tendered_amount !== null && p.tendered_amount !== undefined) {
                    received = parseFloat(p.tendered_amount);
                    change = parseFloat(p.change_amount || 0);
                }
            }

            const total = parseFloat(order.total_amount);

            const formatted = {
                receiptNo: order.order_no,
                date: new Date(order.created_at).toLocaleDateString('th-TH', {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                }),
                paymentMethod: paymentMethodDisplay,
                items: order.order_items.map(item => ({
                    name: item.products?.name || 'สินค้า',
                    quantity: item.qty,
                    price: item.price_per_unit,
                    unit: item.unit || 'ชิ้น',
                    weight: item.weight || null
                })),
                total: total,
                received: received,
                change: change,
                store: order.stores
            };

            res.json({ success: true, data: formatted });
        } catch (error) {
            console.error('Get Order Details Error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });
};

module.exports = { registerOrderRoutes };
