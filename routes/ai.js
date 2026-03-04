const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');
const { error } = require('console');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });

// Admin client for backend operations
const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Helper to get real address from coordinates (FREE Nominatim API)
const getRealAddress = async (lat, lon) => {
    if (!lat || !lon) return "Unknown Location";
    try {
        const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=14&addressdetails=1`, {
            headers: { 'User-Agent': 'SE2025-POS-App' } // Required by Nominatim policy
        });
        const data = await response.json();
        const addr = data.address;
        // Construct a concise address (District, City)
        const district = addr.suburb || addr.district || addr.city_district || "";
        const city = addr.city || addr.town || addr.province || "";
        return `${district}, ${city}`.trim() || "Thailand";
    } catch (e) {
        console.error("Geocoding Error:", e);
        return "Thailand";
    }
};

// Helper to get real-time weather from Open-Meteo (FREE)
const getWeatherData = async (lat, lon) => {
    if (!lat || !lon) return null;
    try {
        const response = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`);
        const data = await response.json();

        const weatherCodes = {
            0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
            45: 'Fog', 48: 'Fog', 51: 'Drizzle', 61: 'Rainy', 71: 'Snow',
            80: 'Rain showers', 95: 'Thunderstorm'
        };

        const code = data.current_weather?.weathercode;
        return {
            temp: data.current_weather?.temperature,
            description: weatherCodes[code] || 'Varies'
        };
    } catch (e) {
        console.error("Weather API Error:", e);
        return null;
    }
};

// Helper to check store access (Simplified version of middleware)
const getStoreSummary = async (storeId, lat, lon) => {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const thirtyDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30).toISOString();

    // Fetch External Context (Weather & Location)
    const [weather, address] = await Promise.all([
        getWeatherData(lat, lon),
        getRealAddress(lat, lon)
    ]);

    // ===================================================
    // 1. FETCH DATA (Optimized Parallel Requests)
    // ===================================================

    // A. Orders & Items (Last 30 Days)
    const { data: orders } = await supabaseAdmin
        .from('orders')
        .select(`
            id, total_amount, payment_type, created_at,
            order_items (qty, price_per_unit, cost_price_at_sale, subtotal, unit, products (id, name, unit_type))
        `)
        .eq('store_id', storeId)
        .gte('created_at', thirtyDaysAgo);

    // B. Current Stock
    const { data: products } = await supabaseAdmin
        .from('products')
        .select('id, name, stock_qty, cost_price, price, low_stock_threshold, unit_type')
        .eq('store_id', storeId)
        .is('deleted_at', null);

    const today = new Date().toISOString().split('T')[0];
    const { data: activePromos } = await supabaseAdmin
        .from('promotion_items')
        .select('product_id, promotions!inner(name, type, discount_value, end_date)')
        .eq('promotions.is_active', true)
        .eq('promotions.store_id', storeId)
        .lte('promotions.start_date', today)
        .gte('promotions.end_date', today);

    const productsWithPromo = new Set(activePromos?.map(p => p.product_id) || []);
    const activePromoList = activePromos?.map(p => `• ${p.promotions.name} (${p.promotions.type}, หมด ${p.promotions.end_date})`) || [];

    // B2a. สินค้าที่หมดอายุแล้ว (ต้องทิ้ง/ตัดสต็อก)
    const todayISO = new Date().toISOString();
    const { data: expiredBatches } = await supabaseAdmin
        .from('product_batches')
        .select('remaining_qty, expire_date, products!inner(name, store_id, cost_price, price, unit_type)')
        .eq('products.store_id', storeId)
        .is('products.deleted_at', null)
        .gt('remaining_qty', 0)
        .lt('expire_date', todayISO)        // หมดอายุแล้ว (< วันนี้)
        .order('expire_date', { ascending: true });

    const { data: expenses } = await supabaseAdmin
        .from('account_transactions')
        .select('amount')
        .eq('store_id', storeId)
        .eq('trans_type', 'expense')
        .gte('trans_date', thirtyDaysAgo);
    const totalExpenses = expenses?.reduce((sum, current) => sum + (parseFloat(current.amount) || 0), 0) || 0;

    // B2b. สินค้าใกล้หมดอายุ (ยังขายได้ จัดโปรลดราคา)
    const fourteenDaysLater = new Date();
    fourteenDaysLater.setDate(fourteenDaysLater.getDate() + 14);
    const { data: nearExpiryBatches } = await supabaseAdmin
        .from('product_batches')
        .select('remaining_qty, expire_date, products!inner(name, store_id, cost_price, price, unit_type)')
        .eq('products.store_id', storeId)
        .is('products.deleted_at', null)
        .gt('remaining_qty', 0)
        .gte('expire_date', todayISO)                         // ยังไม่หมดอายุ (>= วันนี้)
        .lte('expire_date', fourteenDaysLater.toISOString())  // ภายใน 14 วัน
        .order('expire_date', { ascending: true });

    // List ของที่หมดอายุแล้ว (ต้องทิ้ง/ตัดสต็อก ห้ามขาย!)
    const expiredList = expiredBatches?.map(b => {
        const name = b.products?.name || 'ไม่ระบุชื่อ';
        const qty = parseFloat(b.remaining_qty) || 0;
        const unit = b.products?.unit_type || 'ชิ้น';
        const costPrice = parseFloat(b.products?.cost_price) || 0;
        const sellPrice = parseFloat(b.products?.price) || 0;
        const daysAgo = Math.floor((new Date() - new Date(b.expire_date)) / (1000 * 60 * 60 * 24));
        return { name, qty, unit, costPrice, sellPrice, status: `หมดอายุแล้ว ${daysAgo} วัน` };
    }) || [];
    // List ของใกล้หมดอายุ (ยังขายได้ ควรจัดโปร)
    const expiryList = nearExpiryBatches?.map(b => {
        const name = b.products?.name || 'ไม่ระบุชื่อ';
        const qty = parseFloat(b.remaining_qty) || 0;
        const unit = b.products?.unit_type || 'ชิ้น';
        const costPrice = parseFloat(b.products?.cost_price) || 0;
        const sellPrice = parseFloat(b.products?.price) || 0;
        const daysLeft = Math.floor((new Date(b.expire_date) - new Date()) / (1000 * 60 * 60 * 24));
        return { name, qty, unit, costPrice, sellPrice, status: `อีก ${daysLeft} วัน`, daysUntilExpiry: daysLeft };
    }) || [];

    // C. Debt with Customer Names
    const { data: debts } = await supabaseAdmin
        .from('credit_accounts')
        .select('remaining_amount, customers_info!inner(store_id, name, phone, due_date)')
        .eq('customers_info.store_id', storeId)
        .gt('remaining_amount', 0)
        .order('remaining_amount', { ascending: false });

    // Format debts for AI context — group by customer name
    const debtMap = {};
    debts?.forEach(d => {
        const name = d.customers_info?.name || 'ไม่ระบุชื่อ';
        const phone = d.customers_info?.phone || null;
        const amount = parseFloat(d.remaining_amount) || 0;
        const dueDate = d.customers_info?.due_date ? new Date(d.customers_info.due_date) : null;
        const today = new Date();
        let status = '';
        if (dueDate) {
            const daysDiff = Math.floor((today - dueDate) / (1000 * 60 * 60 * 24));
            if (daysDiff > 0) status = `เกินกำหนด ${daysDiff} วัน`;
            else if (daysDiff === 0) status = 'ครบกำหนดวันนี้';
            else status = `อีก ${Math.abs(daysDiff)} วัน`;
        }

        if (debtMap[name]) {
            debtMap[name].amount += amount;
            // Keep the most urgent status
            if (!debtMap[name].status && status) debtMap[name].status = status;
        } else {
            debtMap[name] = { name, phone, amount, status };
        }
    });
    const debtList = Object.values(debtMap).sort((a, b) => b.amount - a.amount);

    // D. Store Info
    const { data: storeInfo } = await supabaseAdmin
        .from('stores')
        .select('name')
        .eq('id', storeId)
        .single();
    const storeName = storeInfo?.name || 'ร้านของคุณ';

    // ===================================================
    // 2. PROCESS DATA
    // ===================================================

    let salesToday = 0, profitToday = 0;
    let salesMonth = 0, profitMonth = 0;
    let cashSales = 0, creditSales = 0;
    const hourlyTraffic = {};
    const weeklySales = { 'Sun': 0, 'Mon': 0, 'Tue': 0, 'Wed': 0, 'Thu': 0, 'Fri': 0, 'Sat': 0 };
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const productSalesQty = {};
    const productPairs = {};

    // New: Monthly Product Stats
    const productStatsMonth = {}; // { pid: { name, qty, revenue } }

    const todayStr = new Date().toISOString().split('T')[0];

    orders?.forEach(order => {
        const d = new Date(order.created_at);
        const dStr = d.toISOString().split('T')[0];
        const dayName = days[d.getDay()];
        const total = parseFloat(order.total_amount) || 0;
        const isThisMonth = d >= new Date(startOfMonth);

        if (isThisMonth) {
            salesMonth += total;
            if (order.payment_type === 'credit_sale') creditSales += total;
            else cashSales += total;
        }
        if (dStr === todayStr) salesToday += total;

        weeklySales[dayName] += total;
        const hour = d.getHours();
        hourlyTraffic[hour] = (hourlyTraffic[hour] || 0) + 1;

        let orderCost = 0;
        const itemNames = [];
        (order.order_items || []).forEach(item => {
            const rawQty = parseFloat(item.qty);
            let normalizedQty = rawQty;
            let unitType = item.unit || item.products?.unit_type || 'ชิ้น';
            if (unitType === 'กรัม' || unitType === 'g') {
                normalizedQty = rawQty / 1000;
                unitType = 'กก.';
            } else if (unitType === 'ขีด') {
                normalizedQty = rawQty / 10;
                unitType = 'กก.'
            }

            const cost = parseFloat(item.cost_price_at_sale) || 0;
            const price = parseFloat(item.subtotal) || (parseFloat(item.price_per_unit || 0) * rawQty);
            const pid = item.products?.id;
            const pname = item.products?.name || 'Unknown';
            if (!pid) return;
            orderCost += (cost * rawQty);
            productSalesQty[pid] = (productSalesQty[pid] || 0) + normalizedQty;
            itemNames.push(pname);
            if (isThisMonth) {
                if (!productStatsMonth[pid]) productStatsMonth[pid] = { name: pname, qty: 0, revenue: 0, unit: unitType };
                productStatsMonth[pid].qty += normalizedQty;
                productStatsMonth[pid].revenue += price;
            }
        });

        const profit = total - orderCost;
        if (isThisMonth) profitMonth += profit;
        if (dStr === todayStr) profitToday += profit;

        itemNames.sort();
        for (let i = 0; i < itemNames.length; i++) {
            for (let j = i + 1; j < itemNames.length; j++) {
                const pair = `${itemNames[i]} + ${itemNames[j]}`;
                productPairs[pair] = (productPairs[pair] || 0) + 1;
            }
        }
    });

    const opportunities = [], sunkCosts = [], winners = [];
    const deadStockList = [];
    const reorderList = [];

    const lowMarginHighVolume = []; // ขายดีแต่กำไรบางเฉียบ
    const highMarginLowVolume = []; // กำไรงามแต่ขายไม่ออก
    products?.forEach(p => {
        const soldQty = productSalesQty[p.id] || 0;
        const threshold = parseFloat(p.low_stock_threshold) || 5;
        const margin = (parseFloat(p.price) - parseFloat(p.cost_price));
        const price = parseFloat(p.price) || 1; // กันหาร 0
        const marginPercent = Math.round((margin / price) * 100);
        // 1. ขายดีแต่ใกล้หมด -> คำนวณจำนวนที่ควรสั่งเพิ่ม (เพื่อให้พอรันไปอีก 14 วัน)
        if (soldQty > 10 && p.stock_qty <= threshold) {
            const dailySales = soldQty / 30;
            const suggestedOrder = Math.ceil((dailySales * 14) - p.stock_qty);
            const unitLabel = p.unit_type || 'ชิ้น';
            const orderText = suggestedOrder > 0 ? `ควรสั่งเพิ่มด่วน ${suggestedOrder} ${unitLabel}` : "ควรเติมสต็อก";
            opportunities.push(`${p.name} (ขายไป ${soldQty}, เหลือ ${p.stock_qty} ${unitLabel} | ⚠️ ${orderText})`);
            reorderList.push({
                name: p.name,
                qty: parseFloat(p.stock_qty) || 0,
                unit: p.unit_type || 'ชิ้น',
                costPrice: parseFloat(p.cost_price) || 0,
                sellPrice: parseFloat(p.price) || 0,
                suggestedOrder: suggestedOrder
            });
        }

        if (soldQty === 0 && p.stock_qty > 10) {
            sunkCosts.push(`${p.name} (Stock ${p.stock_qty}, 0 Sales)`);
            deadStockList.push({
                name: p.name,
                qty: parseFloat(p.stock_qty) || 0,
                unit: p.unit_type || 'ชิ้น',
                costPrice: parseFloat(p.cost_price) || 0,
                sellPrice: parseFloat(p.price) || 0
            });
            // ถ้ากำไรดีมากแต่ขายนิ่ง
            if (marginPercent > 40) highMarginLowVolume.push(`${p.name} (กำไรตั้ง ${marginPercent}%)`);
        }
        if (soldQty * margin > 1000) winners.push(p.name);
        // 3. ขายกระจุยแต่กำไรนิดเดียว (ต่ำกว่า 15%)
        if (soldQty > 15 && marginPercent < 15) {
            const unitLbl = p.unit_type || 'ชิ้น';
            lowMarginHighVolume.push(`${p.name} (ขายไป ${soldQty} ${unitLbl} แต่กำไรต่อหน่วยละ ${marginPercent}%)`);
        }
    });

    const monthNum = new Date().getMonth() + 1;
    let season = 'Summer';
    if (monthNum >= 5 && monthNum <= 10) season = 'Rainy';
    else if (monthNum >= 11 || monthNum <= 2) season = 'Winter (Cool)';

    const weatherText = weather ? `${weather.description}, ${weather.temp}°C` : 'N/A';
    const topPairs = Object.entries(productPairs).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([p]) => p);
    const peakHourStr = Object.entries(hourlyTraffic).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([h]) => `${h}:00`).join(', ');
    const bestDay = Object.entries(weeklySales).sort((a, b) => b[1] - a[1])[0]?.[0] || 'N/A';

    // Format Best Sellers (Month)
    const bestSellersQty = Object.values(productStatsMonth)
        .sort((a, b) => b.qty - a.qty)
        .slice(0, 5)
        .map(p => {
            const displayQty = (p.qty % 1 !== 0) ? p.qty.toFixed(2) : p.qty;
            return `${p.name} (${displayQty} ${p.unit})`;
        })
        .join(', ');

    const bestSellersRev = Object.values(productStatsMonth)
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 5)
        .map(p => `${p.name} (ยอดขายรวมทั้งเดือน ฿${p.revenue.toLocaleString()})`)
        .join(', ');

    // ===================================================
    // 4. CONSTRUCT PROMPT (The Intelligent Brain)
    // ===================================================

    // Format debt list for context
    const debtListText = debtList.slice(0, 5).map(d =>
        `• ${d.name}: ฿${d.amount.toLocaleString()} (${d.status || 'ไม่ระบุวันครบกำหนด'})`
    ).join('\n') || 'ไม่มีลูกหนี้';

    // Format expiry list for context WITH cost & price for profit calculation
    const expiredListText = expiredList.slice(0, 5).map(e =>
        `• ❌ ${e.name}: ${e.qty} ${e.unit} (${e.status}) | ทุน ฿${e.costPrice} → ต้องตัดสต็อกทิ้ง!`
    ).join('\n') || '';
    // ของใกล้หมดอายุ (ยังจัดโปรได้)
    const expiryListText = expiryList.slice(0, 5).map(e =>
        `• ⚠️ ${e.name}: ${e.qty} ${e.unit} (${e.status}) | ทุน ฿${e.costPrice} ราคาขาย ฿${e.sellPrice}`
    ).join('\n') || 'ไม่มีสินค้าใกล้หมดอายุ';

    // Format Date Range
    const startOfMonthDate = new Date(startOfMonth);
    const daysCount = new Date().getDate();
    const dateRangeStr = `${startOfMonthDate.getDate()} - ${new Date().getDate()} ${new Date().toLocaleString('default', { month: 'short' })} (${daysCount} Days)`;
    const netProfitMonth = profitMonth - totalExpenses; // กำไรสุทธิจริงๆ!

    const contextText = `
[ROLE: AI Business Partner for Store "${storeName}"]
[LOCATION: ${address}] [SEASON: ${season}] [WEATHER: ${weatherText}]

💰 FINANCIALS (Period: ${dateRangeStr}):
- Revenue: ฿${Math.round(salesMonth).toLocaleString()} (Gross Profit: ฿${Math.round(profitMonth).toLocaleString()})
- Store Expenses: ฿${Math.round(totalExpenses).toLocaleString()} (รายจ่ายรวม 30 วันที่ผ่านมา)
- 🎯 NET PROFIT: ฿${Math.round(netProfitMonth).toLocaleString()} (ถ้าติดลบแปลว่าร้านกำลังขาดทุน!)
- Cash Flow: ${salesMonth > 0 ? Math.round((cashSales / salesMonth) * 100) : 0}% Cash / ${salesMonth > 0 ? Math.round((creditSales / salesMonth) * 100) : 0}% Debt
- Debt Risk: ฿${(debts?.reduce((s, d) => s + parseFloat(d.remaining_amount), 0) || 0).toLocaleString()} outstanding

🏆 BEST SELLERS (This Month):
- By Quantity: ${bestSellersQty || 'No sales yet'}
- By Revenue: ${bestSellersRev || 'No sales yet'}

👥 ลูกหนี้ที่ต้องติดตาม (ใช้ชื่อจริงเหล่านี้):
${debtListText}

🚫 สินค้าหมดอายุแล้ว (ห้ามขาย! ต้องตัดสต็อกทิ้งเท่านั้น):
${expiredListText || 'ไม่มี'}
⚠️ สินค้าใกล้หมดอายุ (ยังขายได้ ควรจัดโปรลดราคา):
${expiryListText}

📦 INVENTORY MATRIX (Last 30 Days):
- 🚨 REORDER SOON (ต้องรีบสั่งเพิ่ม): ${opportunities.slice(0, 5).join(', ') || 'None'}
- 📉 CLEARANCE (Dead Stock): ${sunkCosts.slice(0, 5).join(', ') || 'None'}

🛒 TRENDS & PRICING STRATEGY (กลยุทธ์ตั้งราคา):
- Best Pairs: ${topPairs.join(' | ') || 'None'}
- Peak Time: ${peakHourStr} (Best Day: ${bestDay})
- ⚠️ สินค้าขายตีคู่แต่กำไรบางเฉียบ (พิจารณาขึ้นราคา): ${lowMarginHighVolume.slice(0, 3).join(', ') || 'ไม่มี'}
- 💎 สินค้ากำไรสูงลิบแต่ขายไม่ออก (ควรนำมาจับคู่โปรโมชั่นหรือดันหน้าร้าน): ${highMarginLowVolume.slice(0, 3).join(', ') || 'ไม่มี'}

🏷️ โปรโมชั่นที่ใช้อยู่ตอนนี้:
${activePromoList.join('\n') || 'ไม่มีโปรโมชั่น active'}

GOAL: ใช้ข้อมูลจริงข้างบนเท่านั้น ห้ามคิดชื่อคน/สินค้าขึ้นมาเอง! ตอบคำถามเกี่ยวกับ "ร้านนี้" หรือ "เดือนนี้" โดยใช้ข้อมูลใน section 💰 FINANCIALS (This Month) และ 🏆 BEST SELLERS (This Month)
`.trim();

    return {
        context: contextText,
        raw: { address, weather, salesMonth, profitMonth, debtList, expiryList, expiredList, deadStockList, reorderList }
    };
};

// GET /api/ai/context - Get Store Context for AI
router.get('/context', async (req, res) => {
    try {
        const storeId = req.headers['x-store-id'];
        const { lat, lon } = req.query; // Real location from app

        if (!storeId) return res.status(400).json({ success: false, error: 'Store ID required' });

        const data = await getStoreSummary(storeId, lat, lon);
        res.json({ success: true, context: data.context, raw: data.raw });
    } catch (error) {
        console.error('AI Context Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/ai/chat - Interactive Chat with Store Context

// Helper: Retry with Exponential Backoff
const retryWithBackoff = async (fn, retries = 3, delay = 1000) => {
    try {
        return await fn();
    } catch (error) {
        if (retries === 0 || (!error.message.includes('429') && !error.message.includes('503'))) {
            throw error;
        }
        console.log(`AI Rate Limit (429/503). Retrying in ${delay}ms... (${retries} left)`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return retryWithBackoff(fn, retries - 1, delay * 2);
    }
};

const chatRateLimit = {};
const CHAT_LIMIT = 20;
const CHAT_WINDOW = 5 * 60 * 1000;

const checkChatRateLimit = (userId) => {
    const now = Date.now();
    if (!chatRateLimit[userId]) {
        chatRateLimit[userId] = { count: 1, resetAt: now + CHAT_WINDOW };
        return true;
    }
    if (now > chatRateLimit[userId].resetAt) {
        chatRateLimit[userId] = { count: 1, resetAt: now + CHAT_WINDOW };
        return true;
    }
    if (chatRateLimit[userId].count >= CHAT_LIMIT) {
        return false;
    }
    chatRateLimit[userId].count++;
    return true;
}

router.post('/chat', async (req, res) => {
    try {
        const { message, lat, lon, history } = req.body;
        const storeId = req.headers['x-store-id'];
        const userId = req.headers['x-user-id'] || req.user?.id;

        if (!storeId) return res.status(400).json({ success: false, error: 'Store ID required' });

        if (userId && !checkChatRateLimit(userId)) {
            return res.status(429).json({
                success: false,
                error: 'ส่งข้อความมากเกินไป กรุณารอสักครู่ (จำกัด 20 ข้อความ/5นาที)'
            })
        }

        // Get fresh context
        const data = await getStoreSummary(storeId, lat, lon);

        const systemInstruction = `
${data.context}

คุณคือ "ผู้จัดการร้านมืออาชีพ" ที่เข้าใจร้านโชห่วยไทยอย่างลึกซึ้ง เป็นมิตร
คุณรู้ทุกอย่างเกี่ยวกับร้านนี้ — ยอดขาย สต็อก ลูกหนี้ สินค้าใกล้หมดอายุ สภาพอากาศ ฤดูกาล โดยรายงานสถานการณ์ร้านสั้นกระชับที่สุด

หน้าที่ของคุณ:
1. **ตอบทุกคำถามเกี่ยวกับร้าน** ด้วยข้อมูลจริงเสมอ (ยอดขาย, กำไร, สต็อก)
2. **แนะนำกลยุทธ์การขาย** เช่น โปรโมชั่น, จัดวางสินค้า, เปลี่ยนราคา
3. **ช่วยจัดการสต็อก** แจ้งเตือนสินค้าใกล้หมด/ค้างสต็อก + บอกจำนวนที่ควรสั่งเพิ่มเข้าร้าน (ดูจาก REORDER SOON)
4. **ติดตามลูกหนี้** แนะนำวิธีทวงถามอย่างเหมาะสม
5. **วิเคราะห์เทรนด์** ช่วงเวลาขายดี, สินค้าที่ซื้อคู่กัน
6. **วิเคราะห์ต้นทุนและกำไรสุทธิ** ดูจาก NET PROFIT ถ้าร้านขาดทุน ให้เตือนทันที พร้อมแนะนำวิธีลดรายจ่ายหรือเพิ่มยอดขาย
7. **แนะนำกลยุทธ์ตั้งราคา** ดูจาก TRENDS & PRICING STRATEGY ถ้าพบสินค้าที่ขายดีแต่กำไรบางเฉียบ ให้แนะนำปรับราคาขึ้น พร้อมประมาณการว่ากำไรจะเพิ่มเท่าไหร่ หรือถ้าพบสินค้ากำไรงามแต่ขายไม่ออก ให้แนะนำวิธีดันยอดเช่น จัดวางหน้าร้าน หรือจับคู่กับสินค้าขายดี

⚠️ กฎเหล็กในการคุย (ห้ามฝ่าฝืน):
1. **ห้ามพิมพ์เครื่องหมายดอกจัน (*) หรือเครื่องหมายขีด (-) นำหน้าข้อความเด็ดขาด**
2. ห้ามพูดคำว่า "ครับ/ค่ะ" ซ้ำซ้อนตอนท้ายประโยค ให้พูดเหมือนอัดเสียงส่งไลน์ (เช่น "วันนี้หมูเนื้อแดงขายดีมาก รีบสั่งของเลยนะ")
3. **เลิกสรุปยอดตัวเลขยาวๆ** (มองเลขไม่ทัน) ให้จับแค่ประเด็นเด่นสุด 2-3 เรื่องพอ 
4. **ขึ้นบรรทัดใหม่ (Enter) ทุกครั้ง** เมื่อเปลี่ยนหัวข้อ หรือเปลี่ยนสินค้า เพื่อให้อ่านง่าย
5. ใช้ 🎯 นำหน้าเรื่องเด่นสุด, 📦 นำหน้าเรื่องสต็อก และ ⚠️ นำหน้าเรื่องเตือนภัย แทนการทำ Bullet Point
6. 🚫 **ห้ามแนะนำให้ขายสินค้าที่ "หมดอายุแล้ว" เด็ดขาด!** ถ้าเจอของที่สถานะบอกว่าหมดอายุแล้ว ให้เตือนว่า "ทิ้งด่วน" หรือ "ส่งคืนเซลล์" ทันที ส่วนของที่ "กำลังจะหมดอายุ" (เหลืออีก X วัน) ค่อยแนะนำให้จัดโปรโมรชั่นลดราคา

แนวทางการตอบ:
- ใช้ตัวเลขจริง (จำนวน, รายได้ ฿) เสมอ
- บอก timeframe (เช่น "เดือนนี้", "30 วันที่ผ่านมา")
- อย่าแค่บอกข้อมูล ให้วิเคราะห์ว่า *หมายความว่าอะไร* และ *ควรทำอะไร*
- น้ำเสียงเป็นมิตร กระชับ ใช้ "ครับ/ค่ะ"
- ถ้าถูกถามเรื่องที่ไม่เกี่ยวกับร้าน ให้กลับมาเรื่องร้านอย่างสุภาพ
- ถ้าแนะนำโปรโมชั่น ให้อ้างอิงข้อมูลจริง เช่น สินค้าที่ซื้อคู่กัน (Best Pairs) หรือช่วงเวลาขายดี (Peak Hours)
`.trim();

        // Initialize model per request to inject specific system instruction
        const chatModel = genAI.getGenerativeModel({
            model: "gemini-2.5-flash-lite",
            systemInstruction: systemInstruction
        });

        const chat = chatModel.startChat({
            history: history || [],
            generationConfig: { maxOutputTokens: 500 }
        });

        // Use retry logic for chat message
        const result = await retryWithBackoff(() => chat.sendMessage(message));
        const response = await result.response;

        res.json({ success: true, answer: response.text() });
    } catch (error) {
        console.error('AI Chat Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/ai/recommendations - Get or Generate 5 daily recommendations
router.get('/recommendations', async (req, res) => {
    try {
        const storeId = req.headers['x-store-id'];
        const userId = req.headers['x-user-id'] || req.user?.id;
        const { lat, lon, period = 'today' } = req.query;

        if (!storeId || !userId) return res.status(400).json({ success: false, error: 'Store and User ID required' });

        let startDate = new Date();
        startDate.setHours(0, 0, 0, 0);
        if (period === 'today') {
            // Use Thailand timezone (UTC+7) for "today" calculation
            const bangkokOffset = 7 * 3600 * 1000;
            const todayBangkok = new Date(Date.now() + bangkokOffset).toISOString().split('T')[0];
            startDate = new Date(todayBangkok + 'T00:00:00+07:00');
        } else if (period === 'month') {
            startDate.setDate(1);
        } else { // default to week
            const day = startDate.getDay() || 7; // Get current day number, make Sunday (0) become 7
            if (day !== 1) startDate.setHours(-24 * (day - 1)); // Adjust to previous Monday
        }

        // 1. Check if recommendations already generated for this period
        const { data: existing } = await supabaseAdmin
            .from('ai_recommendations')
            .select('*')
            .eq('store_id', storeId)
            .eq('user_id', userId)
            .gte('created_at', startDate.toISOString())
            .order('created_at', { ascending: false })
            .limit(5);

        if (existing && existing.length > 0 && period !== 'today') {
            // For historical periods, simply return what we found, do not re-generate.
            return res.json({ success: true, data: existing, cached: true });
        } else if (existing && existing.length >= 5 && period === 'today') {
            // Today logic: if fully generated today, return cache
            return res.json({ success: true, data: existing, cached: true });
        }

        // 1.5 FAST CHECK: Is the store empty?
        // Do a lightweight check before running heavy queries and external APIs (Weather)
        const { count: productCount } = await supabaseAdmin
            .from('products')
            .select('*', { count: 'exact', head: true })
            .eq('store_id', storeId)
            .is('deleted_at', null);

        if (productCount === 0) {
            return res.json({ success: true, data: [], emptyStore: true });
        }

        // 2. Generate 5 New Recommendations using Gemini
        const data = await getStoreSummary(storeId, lat, lon);

        const prompt = `
${data.context}

คุณคือ "ผู้จัดการร้านมืออาชีพ" ที่เข้าใจร้านโชห่วยไทยอย่างลึกซึ้ง
คุณรู้ทุกอย่างเกี่ยวกับร้านนี้ — ยอดขาย สต็อก ลูกหนี้ สินค้าใกล้หมดอายุ สภาพอากาศ ฤดูกาล
หน้าที่ของคุณคือ ให้คำแนะนำ 5 ข้อที่ส่งผลกระทบต่อรายได้ร้านมากที่สุด

📌 ลำดับความสำคัญ (เรียงจากสำคัญสุด):
  A. 🚨 ด่วน — สินค้าหมดอายุแล้ว/ใกล้หมดอายุ (ทุกวันที่ไม่ทำ = เสียเงินจริง)
  B. 💸 ลูกหนี้เกินกำหนด หรือ กระแสเงินสดร้านติดลบ (Net Profit < 0)
  C. 📦 สต็อกขายดีใกล้หมด (ดึงจาก REORDER SOON และแจ้งยอดที่ "ควรสั่งเพิ่มด่วน")
  D. 💡 กลยุทธ์การขาย/ปรับราคา (ดึงจาก TRENDS & PRICING STRATEGY เช่น ปรับราคาขึ้นสำหรับของที่กำไรบาง หรือจัดโปรของที่กำไรงาม)

สร้าง 5 คำแนะนำในรูปแบบ JSON array เรียงตามลำดับ A → B → C → D:

[
  {
    "type": "expiry" | "debt" | "stock" | "promotion" | "pricing",
    "urgency": "urgent" | "normal",
    "title": "หัวข้อสั้นๆ ไม่เกิน 8 คำ (ใช้ชื่อสินค้า/คนจริงจากข้อมูล)",
    "detail": "รายละเอียด 1 บรรทัดชัดเจน",
    "expected_impact": "ผลลัพธ์ที่คาดว่าจะได้ เช่น: คืนทุน 350 บาท (ปกติเสีย 500 บาท)",
    "reason": "เหตุผลแบบมีโครงสร้าง (ดูกฎข้อ 6)",
    "action_label": "ปุ่มสั้นๆ (เช่น ลด 20%, ทวงถาม, เติมสต็อก)",
    "icon": "alert-triangle | account-clock | package-variant | trending-up",

    "target_customers": ["ชื่อลูกหนี้ - เฉพาะ type=debt"],
    "target_products": ["ชื่อสินค้า - เฉพาะ type=expiry/stock/promotion"],

    "recommended_discount": { // ใส่ null เท่านั้น ถ้าเป็นการแนะนำ "เติมสต็อก" ของขายดี หรือ ตัดสต็อก
      "promotion_type": "discount_percent" | "buy_x_get_y" | "bundle",
      "percent": 20,
      "discount_amount": 10,
      "min_qty": 2,
      "free_qty": 1,
      "min_spend":100,
      "days_valid": 3,
      "price_after_discount": 32,
      "profit_per_unit": 2,
      "total_recovery": 320,
      "vs_total_loss": 400,
      "reason": "..."
    }
  }
]

กฎสำคัญ:

1. **เรียงตามลำดับความสำคัญ**:
   - ข้อ 1 = สำคัญที่สุด ต้องทำก่อน (เช่น สินค้าหมดอายุแล้ว)
   - ข้อ 5 = สำคัญน้อยสุดในห้าข้อ (เช่น โปรโมชั่นเพิ่มยอด)
   - ถ้าไม่มีเรื่องด่วน ให้แนะนำกลยุทธ์เพิ่มยอดขายแทน

2. **type=expiry และ type=stock (เฉพาะสต็อกจม/ขายไม่ออก) ต้องมี recommended_discount เสมอ!**
   - คำนวณจากทุนและราคาขายจริง
   - เปรียบเทียบ 2-3 ระดับส่วนลด ใน reason
   - **ข้อยกเว้น**: ถ้าเป็น type=stock แบบ "ของขายดีต้องเติมสต็อก (REORDER SOON)" **ห้ามใส่ recommended_discount เด็ดขาด ทิ้งเป็น null ไปเลย** อย่ากุโปรโมชั่นขึ้นมาเอง

3. **สินค้าหมดอายุแล้ว** → แนะนำ "ตัดสต็อก/ทิ้ง" (ขายไม่ได้แล้ว!)
   recommended_discount = { "promotion_type": "discount_percent", "percent": 100, "reason": "สินค้าหมดอายุแล้ว ต้องตัดสต็อกทิ้ง", "action": "dispose" }

4. **type=debt** → ระบุ target_customers เฉพาะ 1-2 คนที่เร่งด่วนที่สุด

5. **ชื่อสินค้า/ชื่อคน ต้อง copy ตัวอักษรเดิมเป๊ะๆ!**
   - ห้ามแปลง ห้ามเปลี่ยนสระ/วรรณยุกต์ ห้ามสะกดใหม่
   - ถ้าข้อมูลเขียนว่า "บุ๊ค" ต้องเขียน "บุ๊ค" ไม่ใช่ "บุก"
   - ถ้าข้อมูลเขียนว่า "OISHI" ต้องเขียน "OISHI" ไม่ใช่ "โออิชิ"

6. **reason ต้องมีโครงสร้างชัดเจน แยกเป็นข้อๆ**:
   "1. สถานการณ์: [อธิบายว่าเกิดอะไรขึ้น เช่น สินค้า X เหลือ 20 ชิ้น หมดอายุอีก 3 วัน]\n2. คำนวณ: [ถ้าทิ้ง = เสีย ฿xx / ถ้าลดราคา xx% = คืนทุน ฿yy หรือ ถ้าสั่งเพิ่ม xx ชิ้น = อิงจากราคาขาย]\n3. สรุป: [แนะนำทำอะไร เพราะอะไร]"

7. **คณิตศาสตร์ต้องถูกต้อง (Expected Impact)**:
   - "ยอดขายรวมทั้งเดือน (Revenue)" ≠ "ราคาขายแต่ละชิ้น (Sell Price)" ห้ามสับสน
   - เวลาคำนวณ expected_impact แบบได้รายได้จากการสั่งเพิ่ม ให้ใช้สูตร "ยอดสั่งเพิ่ม x ราคาขายแต่ละชิ้น (Sell Price)" เสมอ
   - อย่าเอา Revenue ทั้งเดือนมาคูณจำนวนชิ้น!

8. **type=promotion** (ใช้เมื่อไม่มีเรื่องด่วน):
   - แนะนำโปรโมชั่นจากโลกจริงที่เหมาะกับร้าน เช่น:
     • ซื้อคู่ลดราคา (จากสินค้า Best Pairs)
     • โปรช่วงเวลา Peak Hours
     • โปรตามสภาพอากาศ/ฤดูกาล (ร้อน→เครื่องดื่มเย็น, ฝน→บะหมี่กึ่งสำเร็จรูป)
     • เพิ่มสต็อกสินค้ายอดนิยมก่อนหมด
   - ต้องอ้างอิงข้อมูลจริง เช่น "สินค้า A ขายคู่กับ B บ่อย ควรจัดโปร bundle"

9. **สต็อกเยอะมาก/ขายไม่ออกนาน** → พิจารณา "buy_x_get_y" (จูงใจกว่าลดราคา)
10. **days_valid** กำหนดตามประเภท:
    - type=expiry → 1-3 วัน (เร่งขาย)
    - type=promotion/bundle → 5-14 วัน (ให้เวลาลูกค้า)
    - type=stock (ระบายสต็อก) → 7 วัน
11. **ห้ามแนะนำโปรสินค้าที่มีโปรอยู่แล้ว!**
    - ดูจาก section 🏷️ ถ้าสินค้ามีโปรอยู่แล้ว ให้ข้ามไปแนะนำสินค้าอื่น
    - หรือแนะนำประเภทอื่น เช่น stock/debt แทน
12. **ห้ามแนะนำสินค้าซ้ำข้ามข้อแนะนำเด็ดขาด!**
    - ถ้าดึงสินค้า X ไปวิเคราะห์ในกลยุทธ์ข้อหนึ่งแล้ว ห้ามนำสินค้า X กลับมาพูดถึงในกระบวนการอื่นอีก ให้แนะนำสินค้าตัวอื่นๆ แทนเพื่อกระจายความสำคัญ

Output JSON array เท่านั้น ไม่ต้องมีอะไรอื่น
`.trim();

        const result = await retryWithBackoff(() => model.generateContent(prompt));
        const text = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        let suggestions;
        try {
            suggestions = JSON.parse(text);
        } catch (parseError) {
            console.error('AI returned invalid JSON:', text.substring(0, 200));
            return res.status(500).json({
                success: false,
                error: 'AI ตอบกลับผิดรูปแบบ กรุณาลองใหม่อีกครั้ง'
            });
        }

        // 3. Save to ai_recommendations table
        // Inject real data into payload based on type
        const toInsert = suggestions.slice(0, 5).map(s => {
            const payload = { ...s };

            // For debt type, inject ONLY customers mentioned by AI (target_customers)
            if (s.type === 'debt' && data.raw.debtList?.length > 0) {
                const targetNames = s.target_customers || [];
                // Filter to only customers AI specifically mentioned
                const filteredCustomers = targetNames.length > 0
                    ? data.raw.debtList.filter(c =>
                        targetNames.some(name =>
                            c.name.includes(name) || name.includes(c.name)
                        )
                    )
                    : data.raw.debtList.slice(0, 1); // Fallback to first customer if not specified

                payload.customers = filteredCustomers;
                // If single customer, add phone directly for quick call
                if (filteredCustomers.length === 1) {
                    payload.phone = filteredCustomers[0].phone;
                }
            }

            // For expiry type, inject products and keep AI's recommended_discount
            if (s.type === 'expiry' && data.raw.expiryList?.length > 0) {
                const targetProducts = s.target_products || [];
                // Filter to only products AI specifically mentioned
                const filteredProducts = targetProducts.length > 0
                    ? data.raw.expiryList.filter(p =>
                        targetProducts.some(name =>
                            p.name.includes(name) || name.includes(p.name)
                        )
                    )
                    : data.raw.expiryList.slice(0, 1);

                payload.products = filteredProducts;
                // Keep AI's recommended_discount (already in payload from ...s)
            }

            if (s.type === 'stock') {
                const targetProducts = s.target_products || [];
                // ถ้า action_label เป็น เติมสต็อก → ดึงจาก reorderList, ไม่งั้นดึงจาก deadStockList
                const sourceList = s.action_label === 'เติมสต็อก'
                    ? (data.raw.reorderList || [])
                    : (data.raw.deadStockList || []);

                const filteredProducts = targetProducts.length > 0
                    ? sourceList.filter(p =>
                        targetProducts.some(name =>
                            p.name.includes(name) || name.includes(p.name)
                        )
                    )
                    : sourceList.slice(0, 1);
                payload.products = filteredProducts;
            }

            return {
                store_id: storeId,
                user_id: userId,
                type: s.type || 'info',
                title: s.title,
                detail: s.detail,
                expected_impact: s.expected_impact,
                action_label: s.action_label,
                reference_type: s.reference_type || null,
                status: 'pending',
                payload
            };
        });

        const { data: inserted, error } = await supabaseAdmin
            .from('ai_recommendations')
            .insert(toInsert)
            .select();

        if (error) throw error;

        res.json({ success: true, data: inserted });

    } catch (error) {
        console.error('AI Recommendations Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Legacy endpoint - redirect to new one
router.get('/suggestions', async (req, res) => {
    // Redirect to new recommendations endpoint
    req.url = '/recommendations';
    return router.handle(req, res);
});

// POST /api/ai/recommendations/:id/action - Accept or Skip a recommendation
router.post('/recommendations/:id/action', async (req, res) => {
    try {
        const { id } = req.params;
        const { action, actual_outcome, actual_amount } = req.body; // action: 'accepted' | 'skipped'
        const storeId = req.headers['x-store-id'];
        const userId = req.headers['x-user-id'] || req.user?.id;

        if (!storeId || !userId) return res.status(400).json({ success: false, error: 'Store and User ID required' });
        if (!['accepted', 'skipped'].includes(action)) return res.status(400).json({ success: false, error: 'Invalid action' });

        const updateData = {
            status: action,
            acted_at: new Date().toISOString()
        };

        if (actual_outcome) updateData.actual_outcome = actual_outcome;
        if (actual_amount !== undefined) updateData.actual_amount = actual_amount;

        // --- ENRICH PAYLOAD FOR REAL DATA TRACKING (Production-Level Metric) ---
        if (action === 'accepted') {
            const { data: rec } = await supabaseAdmin
                .from('ai_recommendations')
                .select('payload')
                .eq('id', id)
                .single();

            if (rec && rec.payload) {
                let enrichedPayload = { ...rec.payload };
                let payloadUpdated = false;

                // 1. Tag Products
                if (rec.payload.target_products && Array.isArray(rec.payload.target_products) && rec.payload.target_products.length > 0) {
                    const { data: products } = await supabaseAdmin
                        .from('products')
                        .select('id')
                        .eq('store_id', storeId)
                        .is('deleted_at', null)
                        .or(rec.payload.target_products.map(n => `name.ilike."%${n.replace(/"/g, '""')}%"`).join(','));

                    if (products && products.length > 0) {
                        enrichedPayload.affected_product_ids = products.map(p => p.id);
                        payloadUpdated = true;
                    }
                }

                // 2. Tag Customers
                if (rec.payload.target_customers && Array.isArray(rec.payload.target_customers) && rec.payload.target_customers.length > 0) {
                    const { data: customers } = await supabaseAdmin
                        .from('customers')
                        .select('id')
                        .eq('store_id', storeId)
                        .or(rec.payload.target_customers.map(n => `name.ilike."%${n.replace(/"/g, '""')}%"`).join(','));

                    if (customers && customers.length > 0) {
                        enrichedPayload.affected_customer_ids = customers.map(c => c.id);
                        payloadUpdated = true;
                    }
                }

                if (payloadUpdated) {
                    updateData.payload = enrichedPayload;
                }
            }
        }
        // ------------------------------------------------------------------------

        const { data, error } = await supabaseAdmin
            .from('ai_recommendations')
            .update(updateData)
            .eq('id', id)
            .eq('store_id', storeId)
            .eq('user_id', userId)
            .select()
            .single();

        if (error) throw error;

        res.json({ success: true, data });

    } catch (error) {
        console.error('AI Action Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/ai/recommendations/history - Get past recommendations with outcomes
router.get('/recommendations/history', async (req, res) => {
    try {
        const storeId = req.headers['x-store-id'];
        const userId = req.headers['x-user-id'] || req.user?.id;
        const { days = 30 } = req.query;

        if (!storeId || !userId) return res.status(400).json({ success: false, error: 'Store and User ID required' });

        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - parseInt(days));

        const { data, error } = await supabaseAdmin
            .from('ai_recommendations')
            .select('*')
            .eq('store_id', storeId)
            .eq('user_id', userId)
            .neq('status', 'pending') // Only show actioned items
            .gte('created_at', cutoffDate.toISOString())
            .order('created_at', { ascending: false });

        if (error) throw error;

        await syncRealMoneyEarned(storeId, data);

        // Group by date
        const grouped = {};
        const todayBangkokOffset = new Date().getTime() + (7 * 3600 * 1000);
        const today = new Date(todayBangkokOffset).toISOString().split('T')[0];
        const yesterday = new Date(todayBangkokOffset - 86400000).toISOString().split('T')[0];

        data.forEach(item => {
            const itemDate = new Date(new Date(item.created_at).getTime() + (7 * 3600 * 1000));
            const date = itemDate.toISOString().split('T')[0];
            let label = date;
            if (date === today) label = 'วันนี้';
            else if (date === yesterday) label = 'เมื่อวาน';
            else {
                const diff = Math.floor((new Date(today).getTime() - new Date(date).getTime()) / 86400000);
                label = `${diff} วันก่อน`;
            }

            if (!grouped[label]) grouped[label] = [];
            grouped[label].push(item);
        });

        res.json({ success: true, data: grouped });

    } catch (error) {
        console.error('AI History Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- HELPER TO SYNC ACTUAL REVENUE ---
async function syncRealMoneyEarned(storeId, items) {
    if (!items || items.length === 0) return items;
    const acceptedItems = items.filter(r => r.status === 'accepted' && r.acted_at && r.payload);

    for (const item of acceptedItems) {
        let newAmount = 0;

        // 1. Calculate Product Sales generated since accepted
        if (item.payload.affected_product_ids && item.payload.affected_product_ids.length > 0) {
            const { data: sales, error: salesError } = await supabaseAdmin
                .from('order_items')
                .select('subtotal, orders!inner(created_at, payment_status)')
                .in('product_id', item.payload.affected_product_ids)
                .eq('orders.store_id', storeId)
                .eq('orders.payment_status', 'paid')
                .gte('orders.created_at', item.acted_at);

            if (!salesError && sales) {
                newAmount += sales.reduce((sum, row) => sum + (parseFloat(row.subtotal) || 0), 0);
            }
        }

        // 2. Calculate Debt Recovered since accepted
        if (item.payload.affected_customer_ids && item.payload.affected_customer_ids.length > 0) {
            const { data: payments, error: payError } = await supabaseAdmin
                .from('payment_transactions')
                .select('amount')
                .eq('store_id', storeId)
                .in('customer_id', item.payload.affected_customer_ids)
                .eq('transaction_type', 'debt_clearance')
                .gte('created_at', item.acted_at);

            if (!payError && payments) {
                newAmount += payments.reduce((sum, row) => sum + (parseFloat(row.amount) || 0), 0);
            }
        }

        // If amount changed, update DB and memory ref
        const savedAmount = parseFloat(item.actual_amount) || 0;
        if (newAmount > 0 && newAmount !== savedAmount) {
            item.actual_amount = newAmount;
            await supabaseAdmin
                .from('ai_recommendations')
                .update({ actual_amount: newAmount })
                .eq('id', item.id);
        }
    }
    return items;
}
// ----------------------------------------

// GET /api/ai/recommendations/stats - Get stats for summary card
router.get('/recommendations/stats', async (req, res) => {
    try {
        const storeId = req.headers['x-store-id'];
        const userId = req.headers['x-user-id'] || req.user?.id;
        const { period = 'week' } = req.query;

        if (!storeId || !userId) return res.status(400).json({ success: false, error: 'Store and User ID required' });

        // Calculate start date based on period
        let startDate = new Date();
        startDate.setHours(0, 0, 0, 0);
        if (period === 'today') {
            // Already set to today start
        } else if (period === 'month') {
            startDate.setDate(1);
        } else { // default to week
            const day = startDate.getDay() || 7; // Get current day number, make Sunday (0) become 7
            if (day !== 1) startDate.setHours(-24 * (day - 1)); // Adjust to previous Monday
        }

        const { data: periodData, error: periodError } = await supabaseAdmin
            .from('ai_recommendations')
            .select('id, status, actual_amount, type, payload, acted_at')
            .eq('store_id', storeId)
            .eq('user_id', userId)
            .gte('created_at', startDate.toISOString());

        if (periodError) throw periodError;

        // Sync real money explicitly for memory
        await syncRealMoneyEarned(storeId, periodData);

        // Calculate stats
        const totalRecommendations = periodData?.length || 0;
        const accepted = periodData?.filter(r => r.status === 'accepted') || [];
        const followedCount = accepted.length;
        const moneyEarned = accepted.reduce((sum, r) => sum + (parseFloat(r.actual_amount) || 0), 0);

        // Type breakdown
        const byType = {
            expiry: periodData?.filter(r => r.type === 'expiry' && r.status === 'accepted').length || 0,
            debt: periodData?.filter(r => r.type === 'debt' && r.status === 'accepted').length || 0,
            stock: periodData?.filter(r => r.type === 'stock' && r.status === 'accepted').length || 0,
        };

        // Determine dynamic label (e.g. "สัปดาห์ที่ 1", "วันนี้", "เดือนนี้")
        // If it's a week, calculate which week of the month it is.
        let dynamicLabelLabelValue = weekOfMonth = Math.ceil(new Date().getDate() / 7);
        let dynamicLabelString = `สัปดาห์ที่ ${weekOfMonth}`;
        if (period === 'today') dynamicLabelString = 'วันนี้';
        if (period === 'month') dynamicLabelString = 'เดือนนี้';

        res.json({
            success: true,
            data: {
                label: dynamicLabelString,
                totalRecommendations,
                followedCount,
                followedPercent: totalRecommendations > 0 ? Math.round((followedCount / totalRecommendations) * 100) : 0,
                moneyEarned,
                byType
            }
        });

    } catch (error) {
        console.error('AI Stats Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});


router.get('/active-promotions', async (req, res) => {
    const storeId = req.headers['x-store-id'];
    const bangkokOffset = 7 * 3600 * 1000;
    const today = new Date(Date.now() + bangkokOffset).toISOString().split('T')[0];

    // 1. Auto clean-up expired promotions
    await supabaseAdmin
        .from('promotions')
        .update({ is_active: false })
        .eq('store_id', storeId)
        .eq('is_active', true)
        .lt('end_date', today);

    // 2. Fetch remaining active promotions
    const { data, error } = await supabaseAdmin
        .from('promotions')
        .select(`
            id, name, type, discount_value, 
            min_qty_required, free_qty, min_spend,
            start_date, end_date, is_active, created_at,
            promotion_items(product_id, products(name))
        `)
        .eq('store_id', storeId)
        .eq('is_active', true)
        .lte('start_date', today)
        .order('created_at', { ascending: false });
    res.json({ success: true, data: data || [] });
});

router.patch('/promotions/:id/deactivate', async (req, res) => {
    const { id } = req.params;
    const storeId = req.headers['x-store-id'];
    const { data, error } = await supabaseAdmin
        .from('promotions')
        .update({ is_active: false })
        .eq('id', id)
        .eq('store_id', storeId)
        .select()
        .single();
    if (error) throw error;
    res.json({ success: true, data });
})

// ==================== AI ACTION ENDPOINTS ====================

// Apply Promotion - Create a time-limited discount for products
router.post('/apply-promotion', async (req, res) => {
    try {
        const storeId = req.headers['x-store-id'];
        const userId = req.headers['x-user-id'] || req.user?.id;
        const { recommendationId, productNames, discountPercent, promotionType = 'discount_percent', daysValid = 3, minQtyRequired, freeQtyAmount, discountAmount, minSpend } = req.body;

        if (!storeId || !userId) {
            return res.status(400).json({ success: false, error: 'Store and User ID required' });
        }

        // 1. Find products by name (partial match)
        const { data: products, error: productError } = await supabaseAdmin
            .from('products')
            .select('id, name, price, cost_price')
            .eq('store_id', storeId)
            .is('deleted_at', null)
            .or(productNames.map(n => `name.ilike."%${n.replace(/"/g, '""')}%"`).join(','));

        if (productError) throw productError;

        if (!products || products.length === 0) {
            return res.status(404).json({ success: false, error: 'No matching products found' });
        }

        const today = new Date().toISOString().split('T')[0];
        const { data: existingPromos } = await supabaseAdmin
            .from('promotion_items')
            .select('product_id, promotions!inner(name)')
            .in('product_id', products.map(p => p.id))
            .eq('promotions.is_active', true)
            .lte('promotions.start_date', today)
            .gte('promotions.end_date', today);

        if (existingPromos && existingPromos.length > 0) {
            const conflicting = existingPromos.map(p => p.promotions.name);
            return res.status(400).json({
                success: false,
                error: `สินค้าบางชิ้นมีโปรโมชั่นอยู่แล้ว: ${[...new Set(conflicting)].join(', ')}`
            });
        }

        // 2. Setup Promotion Details
        let promoDiscountValue = discountPercent || 20;
        let dbPromoType = 'discount_percent';
        let minQty = 0;
        let freeQty = 0;
        let promoMinSpend = null;
        let promoName = `AI แนะนำ: ลด ${promoDiscountValue}% - ${products.map(p => p.name).join(', ')}`;

        if (promotionType === 'buy_x_get_y') {
            dbPromoType = 'buy_x_get_y';
            minQty = minQtyRequired || 1;
            freeQty = freeQtyAmount || 1;
            promoName = `AI แนะนำ: ซื้อ ${minQty} แถม ${freeQty} - ${products.map(p => p.name).join(', ')}`;
            promoDiscountValue = 0; // Not used for this type
        } else if (promotionType === 'discount_amount') {
            dbPromoType = 'discount_amount';
            promoDiscountValue = discountAmount || 10;
            promoName = `AI แนะนำ: ลด ฿${promoDiscountValue} - ${products.map(p => p.name).join(', ')}`;
        } else if (promotionType === 'bundle') {
            dbPromoType = 'bundle';
            promoMinSpend = minSpend || null;
            // Logic for bundle could be detailed later, assuming simple discount for now
            promoName = `AI แนะนำ: ซื้อคู่ถูกกว่า - ${products.map(p => p.name).join(', ')}`;
        }

        // 3. Create Promotion record
        const endDate = new Date();
        endDate.setDate(endDate.getDate() + daysValid);

        let description = `AI แนะนำ: ${promoName}`;

        if (recommendationId) {
            const { data: rec } = await supabaseAdmin
                .from('ai_recommendations')
                .select('detail, payload')
                .eq('id', recommendationId)
                .single();
            if (rec) {
                description = rec.detail || rec.payload?.reason || description;
            }
        }

        const { data: promo, error: promoError } = await supabaseAdmin
            .from('promotions')
            .insert([{
                name: promoName,
                type: dbPromoType,
                discount_value: promoDiscountValue,
                min_qty_required: minQty,
                free_qty: freeQty,
                start_date: new Date().toISOString().split('T')[0],
                end_date: endDate.toISOString().split('T')[0],
                store_id: storeId,
                is_active: true,
                created_by: userId,
                description: description,
                min_spend: promoMinSpend
            }])
            .select()
            .single();

        if (promoError) throw promoError;

        // 4. Link products to promotion
        const promoItems = products.map(p => ({
            promotion_id: promo.id,
            product_id: p.id
        }));

        const { error: itemsError } = await supabaseAdmin
            .from('promotion_items')
            .insert(promoItems);

        if (itemsError) throw itemsError;

        // 5. Update recommendation status if provided
        if (recommendationId) {
            await supabaseAdmin
                .from('ai_recommendations')
                .update({
                    status: 'accepted',
                    acted_at: new Date().toISOString(),
                    actual_outcome: `สร้างโปรโมชั่นลด ${promoDiscountValue}% สำหรับ ${products.length} สินค้า`
                })
                .eq('id', recommendationId);
        }

        res.json({
            success: true,
            data: {
                promotion: promo,
                affectedProducts: products.map(p => ({
                    id: p.id,
                    name: p.name,
                    originalPrice: p.price,
                    discountedPrice: dbPromoType === 'discount_percent' ? Math.round(p.price * (1 - promoDiscountValue / 100)) : dbPromoType === 'discount_amount' ? Math.max(0, p.price - promoDiscountValue) : p.price
                })),
                expiresAt: endDate.toISOString()
            }
        });

    } catch (error) {
        console.error('Apply Promotion Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Dispose Product - Remove expired stock from batches
router.post('/dispose-product', async (req, res) => {
    try {
        const storeId = req.headers['x-store-id'];
        const userId = req.headers['x-user-id'] || req.user?.id;
        const { recommendationId, productNames, reason = 'Expired - disposed by AI recommendation' } = req.body;

        if (!storeId || !userId) {
            return res.status(400).json({ success: false, error: 'Store and User ID required' });
        }

        const today = new Date().toISOString().split('T')[0];
        let totalDisposed = 0;
        const disposedItems = [];

        // 1. Find products by name
        const { data: products, error: productError } = await supabaseAdmin
            .from('products')
            .select('id, name, stock_qty, unit_type')
            .eq('store_id', storeId)
            .is('deleted_at', null)
            .or(productNames.map(n => `name.ilike."%${n.replace(/"/g, '""')}%"`).join(','));

        if (productError) throw productError;

        // 2. For each product, find and dispose expired batches
        for (const product of products || []) {
            const { data: batches, error: batchError } = await supabaseAdmin
                .from('product_batches')
                .select('id, batch_no, remaining_qty, expire_date')
                .eq('product_id', product.id)
                .lt('expire_date', today)
                .gt('remaining_qty', 0);

            if (batchError) throw batchError;

            for (const batch of batches || []) {
                const disposedQty = batch.remaining_qty;
                totalDisposed += disposedQty;

                // Set remaining_qty to 0
                await supabaseAdmin
                    .from('product_batches')
                    .update({ remaining_qty: 0 })
                    .eq('id', batch.id);

                // Record inventory transaction
                await supabaseAdmin
                    .from('inventory_transactions')
                    .insert([{
                        product_id: product.id,
                        batch_id: batch.id,
                        trans_type: 'out',
                        qty: -disposedQty,
                        reference_type: 'dispose',
                        notes: reason
                    }]);

                // Update product stock_qty
                await supabaseAdmin
                    .from('products')
                    .update({ stock_qty: Math.max(0, product.stock_qty - disposedQty) })
                    .eq('id', product.id)
                    .is('deleted_at', null);

                disposedItems.push({
                    productName: product.name,
                    batchNo: batch.batch_no,
                    qty: disposedQty,
                    expireDate: batch.expire_date
                });
            }
        }

        // 3. Update recommendation status if provided
        if (recommendationId) {
            await supabaseAdmin
                .from('ai_recommendations')
                .update({
                    status: 'accepted',
                    acted_at: new Date().toISOString(),
                    actual_outcome: `ตัดสต็อก ${totalDisposed} ${products?.[0]?.unit_type || 'ชิ้น'} จาก ${disposedItems.length} batch`
                })
                .eq('id', recommendationId);
        }

        res.json({
            success: true,
            data: {
                totalDisposed,
                disposedItems
            }
        });

    } catch (error) {
        console.error('Dispose Product Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;

