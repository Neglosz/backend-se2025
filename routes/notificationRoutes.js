const registerNotificationRoutes = ({
    app,
    supabaseAdmin,
    checkStoreAccess,
    upsertNotificationGlobal
}) => {
    app.get('/api/notifications', async (req, res) => {
        try {
            const { category } = req.query;
            const userId = req.user.id;
            const storeId = req.headers['x-store-id'];

            let query = supabaseAdmin.from('notifications').select('*');

            if (userId) {
                query = query.eq('user_id', userId);
            } else {
                return res.json({ success: true, data: [] });
            }

            // Filter by store_id if provided in headers
            if (storeId) {
                query = query.eq('store_id', storeId);
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
            const storeId = req.headers['x-store-id'];

            if (!userId) {
                return res.json({ success: true, count: 0 });
            }

            let query = supabaseAdmin
                .from('notifications')
                .select('*', { count: 'exact', head: true })
                .eq('user_id', userId)
                .eq('is_read', false);

            // Filter by store_id if provided in headers
            if (storeId) {
                query = query.eq('store_id', storeId);
            }

            const { count, error } = await query;

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
            // 2. Get unpaid/partial debts for this store
            const { data: accounts } = await supabaseAdmin
                .from('credit_accounts')
                .select('*, customers_info!inner(name, phone, store_id, due_date)') // Add due_date
                .in('status', ['unpaid', 'partial'])
                .eq('customers_info.store_id', storeId); // Filter by store

            if (!accounts || accounts.length === 0) {
                return res.json({ success: true, created: 0 });
            }

            // 3. Group by customer and find due date (from customer info)
            const customerDebts = {};
            for (const account of accounts) {
                const customerId = account.customer_id;
                if (!customerDebts[customerId]) {
                    customerDebts[customerId] = {
                        name: account.customers_info.name,
                        phone: account.customers_info.phone,
                        total_debt: 0,
                        due_date: account.customers_info.due_date // Use customer due date
                    };
                }
                customerDebts[customerId].total_debt += parseFloat(account.remaining_amount);
            }

            const today = new Date();
            const startOfDay = new Date(today);
            startOfDay.setHours(0, 0, 0, 0);

            // 4. Check each customer status
            for (const customerId in customerDebts) {
                const data = customerDebts[customerId];
                if (!data.due_date) continue; // Skip if no due date set

                const maxDueDate = new Date(data.due_date);
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

    // ==================== AUTOMATED NOTIFICATION SCHEDULER ====================

    // Reusable function to process notifications for a SPECIFIC store
    const processStoreNotifications = async (storeId) => {
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

        try {
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

                const isNew = await upsertNotificationGlobal(
                    storeId,
                    'stock_expired', 'สินค้าหมดอายุ',
                    `${batch.products.name} (Lot #${batch.batch_no?.replace('LOT-', '') || batch.id.slice(0, 8)})\nหมดอายุ${expiredText} • ${batch.remaining_qty} ชิ้น`,
                    'stock', 'critical', batch.id, 'batch',
                    { batch_id: batch.id, product_id: batch.products.id, expire_date: batch.expire_date }
                );
                if (isNew) results.expired++;
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

                const isNew = await upsertNotificationGlobal(
                    storeId,
                    'stock_near_expiry', 'สินค้าใกล้หมดอายุ',
                    `${batch.products.name}\n${expiryText} • เหลือ ${batch.remaining_qty} ชิ้น`,
                    'stock', daysLeft <= 2 ? 'high' : 'medium', batch.id, 'batch',
                    { batch_id: batch.id, product_id: batch.products.id, expire_date: batch.expire_date, days_left: daysLeft }
                );
                if (isNew) results.nearExpiry++;
            }

            // 3. Check Payments (Grouped by Customer, using LATEST due date)
            const { data: allDebts } = await supabaseAdmin
                .from('credit_accounts')
                .select('id, customer_id, remaining_amount, customers_info!inner(id, name, phone, store_id, due_date)')
                .eq('customers_info.store_id', storeId)
                .gt('remaining_amount', 0)
                .in('status', ['unpaid', 'partial', 'overdue']);

            // Grouping logic
            const customerGroup = {};
            for (const acc of allDebts || []) {
                const cid = acc.customer_id;
                if (!customerGroup[cid]) {
                    customerGroup[cid] = {
                        customer_id: cid,
                        name: acc.customers_info.name,
                        phone: acc.customers_info.phone,
                        total_amount: 0,
                        latest_due: acc.customers_info.due_date, // Use Customer's Due Date
                        bill_ids: []
                    };
                }
                customerGroup[cid].total_amount += Number(acc.remaining_amount);
                customerGroup[cid].bill_ids.push(acc.id);
            }

            for (const cid in customerGroup) {
                const data = customerGroup[cid];
                const dueDate = new Date(data.latest_due);
                const todayMidnight = new Date(todayStr).getTime();
                const dueMidnight = new Date(dueDate.toISOString().split('T')[0]).getTime();

                const diffTime = dueMidnight - todayMidnight;
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

                // Only notify if within range (Overdue OR Due within 3 days)
                if (diffDays <= 3) {
                    let type = '';
                    let title = '';
                    let message = '';
                    let priority = 'medium';

                    if (diffDays < 0) {
                        const daysOverdue = Math.abs(diffDays);
                        type = 'payment_overdue';
                        title = 'ลูกหนี้เกินกำหนดชำระ';
                        message = `${data.name}\nยอดรวม ฿${data.total_amount.toLocaleString()} • เกินกำหนด ${daysOverdue} วัน`;
                        priority = 'critical';
                    } else if (diffDays === 0) {
                        type = 'payment_due_soon';
                        title = 'ครบกำหนดชำระวันนี้';
                        message = `${data.name}\nยอดรวม ฿${data.total_amount.toLocaleString()} • ครบกำหนดวันนี้`;
                        priority = 'high';
                    } else {
                        type = 'payment_due_soon';
                        title = 'ใกล้ครบกำหนดชำระ';
                        message = `${data.name}\nยอดรวม ฿${data.total_amount.toLocaleString()} • อีก ${diffDays} วันครบกำหนด`;
                        priority = 'medium';
                    }

                    const payload = {
                        customer_id: data.customer_id,
                        phone: data.phone,
                        amount: data.total_amount,
                        latest_due: data.latest_due,
                        days_diff: diffDays
                    };

                    // Use the new global helper
                    const isNew = await upsertNotificationGlobal(
                        storeId, type, title, message, 'payment', priority, data.customer_id, 'customer', payload
                    );
                    if (isNew) {
                        if (type === 'payment_overdue') results.paymentOverdue++;
                        if (type === 'payment_due_soon') results.paymentDueSoon++;
                    }
                }
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

                const isNew = await upsertNotificationGlobal(
                    storeId,
                    'promo_ending', 'โปรโมชั่นใกล้หมดอายุ',
                    `${promo.name}\n${endText}`,
                    'stock', 'medium', promo.id, 'promotion',
                    { promotion_id: promo.id, end_date: promo.end_date, days_left: daysLeft }
                );
                if (isNew) results.promoEnding++;
            }

            // 6. AUTO-RESOLVE: Cleanup notifications for issues that are fixed
            // Get all active alerts for this store
            const { data: activeNotifs } = await supabaseAdmin
                .from('notifications')
                .select('id, type, reference_id')
                .eq('store_id', storeId)
                .in('type', ['stock_expired', 'stock_near_expiry', 'payment_overdue', 'payment_due_soon', 'stock_low', 'stock_out']);

            const activeBatchIds = new Set([
                ...(expiredBatches || []).map(b => b.id),
                ...(nearExpiryBatches || []).map(b => b.id)
            ]);
            const activeCustomerIds = new Set(Object.keys(customerGroup));

            // For stock_low and stock_out, we need to check current stock levels
            const { data: currentProducts } = await supabaseAdmin
                .from('products')
                .select('id, stock_qty, low_stock_threshold')
                .eq('store_id', storeId)
                .is('deleted_at', null);

            const problematicProductIds = new Set();
            (currentProducts || []).forEach(p => {
                const qty = parseFloat(p.stock_qty);
                const threshold = parseFloat(p.low_stock_threshold);
                if (qty === 0 || (threshold > 0 && qty <= threshold)) {
                    problematicProductIds.add(p.id);
                }
            });

            const idsToDelete = [];

            for (const notif of activeNotifs || []) {
                let isResolved = false;

                if (notif.type === 'stock_expired' || notif.type === 'stock_near_expiry') {
                    if (!activeBatchIds.has(notif.reference_id)) isResolved = true;
                } else if (notif.type === 'payment_overdue' || notif.type === 'payment_due_soon') {
                    if (!activeCustomerIds.has(notif.reference_id)) isResolved = true;
                } else if (notif.type === 'stock_low' || notif.type === 'stock_out') {
                    if (!problematicProductIds.has(notif.reference_id)) isResolved = true;
                }

                if (isResolved) {
                    idsToDelete.push(notif.id);
                }
            }

            if (idsToDelete.length > 0) {
                await supabaseAdmin
                    .from('notifications')
                    .delete()
                    .in('id', idsToDelete);
                results.cleaned += idsToDelete.length;
            }

            // 7. Cleanup old notifications (> 30 days) (Existing logic)
            const { count: expiredCleaned } = await supabaseAdmin
                .from('notifications')
                .delete({ count: 'exact' })
                .lt('expires_at', today.toISOString());

            results.cleaned += (expiredCleaned || 0);
            // 8. Auto-purge soft-deleted products older than 30 days
            const thirtyDaysAgo = new Date();
            thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
            const { data: toDelete } = await supabaseAdmin
                .from('products')
                .select('id')
                .eq('store_id', storeId)
                .not('deleted_at', 'is', null)
                .lt('deleted_at', thirtyDaysAgo.toISOString());
            if (toDelete && toDelete.length > 0) {
                const ids = toDelete.map(p => p.id);
                await supabaseAdmin.from('promotion_items').delete().in('product_id', ids);
                await supabaseAdmin.from('inventory_transactions').delete().in('product_id', ids);
                await supabaseAdmin.from('product_batches').delete().in('product_id', ids);
                await supabaseAdmin.from('products').delete().in('id', ids);
                results.cleaned += ids.length;
            }
            return results;

        } catch (error) {
            console.error(`Error processing store ${storeId}:`, error);
            return results;
        }
    };

    // Scheduler Function
    const startAutoScheduler = () => {
        console.log("Starting Auto-Notification Scheduler...");

        const runChecks = async () => {
            console.log(`[${new Date().toISOString()}] Running automated checks...`);
            try {
                // Get all active stores
                const { data: stores } = await supabaseAdmin
                    .from('stores')
                    .select('id')
                    .eq('is_active', true);

                for (const store of stores || []) {
                    await processStoreNotifications(store.id);
                }
            } catch (error) {
                console.error("Scheduler Error:", error);
            }
        };

        // Run immediately on start
        runChecks();

        // Then run every 24 hours (86400000 ms) - Daily Safety Net
        setInterval(runChecks, 86400000);
    };

    // Start the scheduler
    startAutoScheduler();

    // ========================================================================

    // 🔔 DAILY NOTIFICATION CHECK (Manual Trigger via API)
    app.post('/api/notifications/daily-check', async (req, res) => {
        try {
            const storeId = req.headers['x-store-id'];
            if (!storeId) {
                return res.status(400).json({ success: false, error: 'x-store-id header required' });
            }

            const results = await processStoreNotifications(storeId);

            res.json({
                success: true,
                message: 'Manual check completed',
                results
            });
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
};

module.exports = { registerNotificationRoutes };
