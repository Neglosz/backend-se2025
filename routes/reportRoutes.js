const registerReportRoutes = ({ app, supabaseAdmin, checkStoreAccess }) => {
    const TH_OFFSET_MS = 7 * 60 * 60 * 1000; // UTC+7

    // แปลง ISO string เป็นเวลาไทย (UTC+7) แล้วดึง hour
    const toThaiHour = (isoString) => {
        return (new Date(isoString).getUTCHours() + 7) % 24;
    };

    // แปลง ISO string เป็น "วัน/เดือน" ตามเวลาไทย
    const toThaiDateStr = (isoString) => {
        const thDate = new Date(new Date(isoString).getTime() + TH_OFFSET_MS);
        return `${thDate.getUTCDate()}/${thDate.getUTCMonth() + 1}`;
    };

    // คืนค่า "วันนี้" ตามเวลาไทย (UTC+7)
    const getThaiNow = () => new Date(Date.now() + TH_OFFSET_MS);

    const getDateRange = (period) => {
        const nowTH = getThaiNow();
        const y = nowTH.getUTCFullYear();
        const m = nowTH.getUTCMonth();
        const d = nowTH.getUTCDate();
        const dow = nowTH.getUTCDay(); // 0=Sun

        // เวลาเริ่มต้น/สิ้นสุดของวันนี้ในไทย → แปลงกลับเป็น UTC
        const todayStart = new Date(Date.UTC(y, m, d, 0, 0, 0) - TH_OFFSET_MS);
        const todayEnd   = new Date(Date.UTC(y, m, d, 23, 59, 59, 999) - TH_OFFSET_MS);

        let start, end;

        if (period === 'today' || period === 'day') {
            start = todayStart.toISOString();
            end   = todayEnd.toISOString();
        } else if (period === 'month') {
            start = new Date(Date.UTC(y, m, 1, 0, 0, 0) - TH_OFFSET_MS).toISOString();
            end   = todayEnd.toISOString();
        } else if (period === 'year') {
            start = new Date(Date.UTC(y, 0, 1, 0, 0, 0) - TH_OFFSET_MS).toISOString();
            end   = todayEnd.toISOString();
        } else if (period === 'week') {
            // จันทร์ของสัปดาห์นี้ (ไทย)
            const daysFromMonday = dow === 0 ? 6 : dow - 1;
            start = new Date(Date.UTC(y, m, d - daysFromMonday, 0, 0, 0) - TH_OFFSET_MS).toISOString();
            end   = todayEnd.toISOString();
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

            // Current Period Sales (รวม credit_sale ที่ยังค้างด้วย เพราะการขายเกิดขึ้นแล้ว)
            const { data: currentData, error: currentError } = await supabaseAdmin
                .from('orders')
                .select('total_amount')
                .eq('store_id', storeId)
                .neq('payment_status', 'cancelled')
                .gte('created_at', start)
                .lte('created_at', end);

            if (currentError) throw currentError;

            const totalSales = currentData.reduce((sum, order) => sum + (parseFloat(order.total_amount) || 0), 0);
            const totalOrders = currentData.length;

            // Previous Period Sales (for growth calculation) — ใช้เวลาไทย UTC+7
            let prevStart, prevEnd;
            const nowTH = getThaiNow();
            const y = nowTH.getUTCFullYear();
            const mo = nowTH.getUTCMonth();
            const d = nowTH.getUTCDate();

            if (period === 'today') {
                // เมื่อวาน (เวลาไทย)
                prevStart = new Date(Date.UTC(y, mo, d - 1, 0, 0, 0) - TH_OFFSET_MS).toISOString();
                prevEnd   = new Date(Date.UTC(y, mo, d - 1, 23, 59, 59, 999) - TH_OFFSET_MS).toISOString();
            } else if (period === 'week') {
                // สัปดาห์ก่อน (จันทร์-อาทิตย์)
                const dow = nowTH.getUTCDay();
                const daysFromMonday = dow === 0 ? 6 : dow - 1;
                prevStart = new Date(Date.UTC(y, mo, d - daysFromMonday - 7, 0, 0, 0) - TH_OFFSET_MS).toISOString();
                prevEnd   = new Date(Date.UTC(y, mo, d - daysFromMonday - 1, 23, 59, 59, 999) - TH_OFFSET_MS).toISOString();
            } else if (period === 'month') {
                // เดือนที่แล้ว
                prevStart = new Date(Date.UTC(y, mo - 1, 1, 0, 0, 0) - TH_OFFSET_MS).toISOString();
                prevEnd   = new Date(Date.UTC(y, mo, 0, 23, 59, 59, 999) - TH_OFFSET_MS).toISOString();
            }

            let growth = 0;
            if (prevStart && prevEnd) {
                const { data: prevData } = await supabaseAdmin
                    .from('orders')
                    .select('total_amount')
                    .eq('store_id', storeId)
                    .neq('payment_status', 'cancelled')
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

            // Fetch all orders (รวม credit_sale ค้าง) เพื่อให้ chart consistent กับ summary
            const { data: orders, error } = await supabaseAdmin
                .from('orders')
                .select('created_at, total_amount')
                .eq('store_id', storeId)
                .neq('payment_status', 'cancelled')
                .gte('created_at', start)
                .lte('created_at', end)
                .order('created_at', { ascending: true });

            if (error) throw error;

            let labels = [];
            let values = [];
            let peakTime = '-';
            let peakAmount = 0;

            if (period === 'today') {
                // Group by hour เวลาไทย (UTC+7) ใช้ toThaiHour helper
                const hourlyData = new Array(24).fill(0);
                orders.forEach(order => {
                    const h = toThaiHour(order.created_at);
                    hourlyData[h] += parseFloat(order.total_amount);
                });

                // แสดงเฉพาะ hour ที่มียอดขายจริง เรียงตามเวลา
                const keyHours = hourlyData
                    .map((val, h) => ({ h, val }))
                    .filter(({ val }) => val > 0)
                    .map(({ h }) => h);

                labels = keyHours.map(h => `${h}:00`);
                values = keyHours.map(h => Math.round(hourlyData[h]));

                hourlyData.forEach((val, idx) => {
                    if (val > peakAmount) { peakAmount = val; peakTime = `${idx}:00 น.`; }
                });

            } else if (period === 'week') {
                // สร้าง key วันจันทร์ถึงวันนี้ (เวลาไทย)
                const nowTH = getThaiNow();
                const dow = nowTH.getUTCDay(); // 0=Sun
                const daysFromMonday = dow === 0 ? 6 : dow - 1;
                const dailyData = {};

                for (let i = 0; i <= daysFromMonday; i++) {
                    const d = new Date(Date.UTC(
                        nowTH.getUTCFullYear(), nowTH.getUTCMonth(),
                        nowTH.getUTCDate() - daysFromMonday + i
                    ));
                    dailyData[`${d.getUTCDate()}/${d.getUTCMonth() + 1}`] = 0;
                }

                orders.forEach(order => {
                    const key = toThaiDateStr(order.created_at);
                    if (key in dailyData) dailyData[key] += parseFloat(order.total_amount);
                });

                labels = Object.keys(dailyData);
                values = Object.values(dailyData).map(v => Math.round(v));

                for (const [key, val] of Object.entries(dailyData)) {
                    if (val > peakAmount) { peakAmount = val; peakTime = key; }
                }

            } else if (period === 'month') {
                // สร้าง key วันที่ 1 ถึงวันนี้ (เวลาไทย)
                const nowTH = getThaiNow();
                const y = nowTH.getUTCFullYear();
                const mo = nowTH.getUTCMonth();
                const todayDate = nowTH.getUTCDate();
                const dailyData = {};

                for (let d = 1; d <= todayDate; d++) {
                    dailyData[`${d}/${mo + 1}`] = 0;
                }

                orders.forEach(order => {
                    const key = toThaiDateStr(order.created_at);
                    if (key in dailyData) dailyData[key] += parseFloat(order.total_amount);
                });

                labels = Object.keys(dailyData);
                values = Object.values(dailyData).map(v => Math.round(v));

                for (const [key, val] of Object.entries(dailyData)) {
                    if (val > peakAmount) { peakAmount = val; peakTime = key; }
                }
            }

            // ถ้าไม่มีข้อมูลเลย ส่ง empty array (frontend จะ handle เอง)
            if (values.length === 0) {
                labels = [];
                values = [];
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

            // 1. Fetch payments (เงินสด + QR ที่จ่ายจริงแล้ว)
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
            // 2. Fetch credit_accounts ที่ยังค้างอยู่ ดึง remaining_amount (ไม่ใช่ total_amount)
            // เพื่อกัน double count กรณี partial payment
            const { data: creditAccounts, error: creditError } = await supabaseAdmin
                .from('credit_accounts')
                .select(`
                    remaining_amount,
                    orders!inner(store_id, created_at)
                `)
                .eq('orders.store_id', storeId)
                .in('status', ['unpaid', 'partial'])
                .gte('orders.created_at', start)
                .lte('orders.created_at', end);
            if (creditError) throw creditError;
            const stats = {
                cash: 0,
                qr: 0,
                credit: 0
            };
            let total = 0;
            // นับจาก payments (เงินสด + QR)
            payments.forEach(p => {
                const amount = parseFloat(p.amount) || 0;
                total += amount;
                if (p.method === 'cash') stats.cash += amount;
                else if (p.method === 'qr_promptpay') stats.qr += amount;
                else if (p.method === 'credit') stats.credit += amount;
            });
            // นับจาก credit_accounts (เฉพาะยอดค้างจริง remaining_amount)
            creditAccounts.forEach(ca => {
                const amount = parseFloat(ca.remaining_amount) || 0;
                stats.credit += amount;
                total += amount;
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
};

module.exports = { registerReportRoutes };
