const registerReportRoutes = ({ app, supabaseAdmin, checkStoreAccess }) => {
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
};

module.exports = { registerReportRoutes };
