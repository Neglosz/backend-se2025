const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });

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
    const today = new Date();
    const startOfDay = new Date(today.setHours(0, 0, 0, 0)).toISOString();
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1).toISOString();
    const thirtyDaysAgo = new Date(today.setDate(today.getDate() - 30)).toISOString();

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
            order_items (qty, price_per_unit, cost_price_at_sale, subtotal, products (id, name))
        `)
        .eq('store_id', storeId)
        .gte('created_at', thirtyDaysAgo);

    // B. Current Stock
    const { data: products } = await supabaseAdmin
        .from('products')
        .select('id, name, stock_qty, cost_price, price, low_stock_threshold')
        .eq('store_id', storeId);

    // B2. Product Batches with Expiry (within 14 days)
    const fourteenDaysLater = new Date();
    fourteenDaysLater.setDate(fourteenDaysLater.getDate() + 14);
    const { data: nearExpiryBatches } = await supabaseAdmin
        .from('product_batches')
        .select('qty, expire_date, products!inner(name, store_id, cost_price, price)')
        .eq('products.store_id', storeId)
        .gt('qty', 0)
        .lte('expire_date', fourteenDaysLater.toISOString())
        .order('expire_date', { ascending: true });

    // Format expiry list for AI with cost & price for profit calculation
    const expiryList = nearExpiryBatches?.map(b => {
        const name = b.products?.name || 'ไม่ระบุชื่อ';
        const qty = b.qty;
        const costPrice = parseFloat(b.products?.cost_price) || 0;
        const sellPrice = parseFloat(b.products?.price) || 0;
        const expDate = b.expire_date ? new Date(b.expire_date) : null;
        const today = new Date();
        let status = '';
        let daysUntilExpiry = null;
        if (expDate) {
            daysUntilExpiry = Math.floor((expDate - today) / (1000 * 60 * 60 * 24));
            if (daysUntilExpiry < 0) status = `หมดอายุแล้ว ${Math.abs(daysUntilExpiry)} วัน`;
            else if (daysUntilExpiry === 0) status = 'หมดอายุวันนี้';
            else status = `อีก ${daysUntilExpiry} วัน`;
        }
        return { name, qty, status, daysUntilExpiry, costPrice, sellPrice };
    }) || [];

    // C. Debt with Customer Names
    const { data: debts } = await supabaseAdmin
        .from('credit_accounts')
        .select('remaining_amount, customers_info!inner(store_id, name, phone, due_date)')
        .eq('customers_info.store_id', storeId)
        .gt('remaining_amount', 0)
        .order('remaining_amount', { ascending: false });

    // Format debts for AI context
    const debtList = debts?.map(d => {
        const name = d.customers_info?.name || 'ไม่ระบุชื่อ';
        const phone = d.customers_info?.phone || null;
        const amount = parseFloat(d.remaining_amount) || 0;
        const dueDate = d.customers_info?.due_date ? new Date(d.customers_info.due_date) : null; // Use customer due date
        const today = new Date();
        let status = '';
        if (dueDate) {
            const daysDiff = Math.floor((today - dueDate) / (1000 * 60 * 60 * 24));
            if (daysDiff > 0) status = `เกินกำหนด ${daysDiff} วัน`;
            else if (daysDiff === 0) status = 'ครบกำหนดวันนี้';
            else status = `อีก ${Math.abs(daysDiff)} วัน`;
        }
        return { name, phone, amount, status };
    }) || [];

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
            const qty = parseFloat(item.qty);
            const cost = parseFloat(item.cost_price_at_sale) || 0;
            const price = parseFloat(item.price_per_unit || 0) * qty; // Rough revenue
            const pid = item.products?.id;
            const pname = item.products?.name || 'Unknown';
            if (!pid) return;

            orderCost += (cost * qty);
            productSalesQty[pid] = (productSalesQty[pid] || 0) + qty;
            itemNames.push(pname);

            // Track Monthly Best Sellers
            if (isThisMonth) {
                if (!productStatsMonth[pid]) productStatsMonth[pid] = { name: pname, qty: 0, revenue: 0 };
                productStatsMonth[pid].qty += qty;
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
    products?.forEach(p => {
        const soldQty = productSalesQty[p.id] || 0;
        const threshold = parseFloat(p.low_stock_threshold) || 5;
        const margin = (parseFloat(p.price) - parseFloat(p.cost_price));

        if (soldQty > 10 && p.stock_qty <= threshold) opportunities.push(`${p.name} (Sold ${soldQty}, Left ${p.stock_qty})`);
        if (soldQty === 0 && p.stock_qty > 10) sunkCosts.push(`${p.name} (Stock ${p.stock_qty}, 0 Sales)`);
        if (soldQty * margin > 1000) winners.push(p.name);
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
        .map(p => `${p.name} (${p.qty} ชิ้น)`)
        .join(', ');

    const bestSellersRev = Object.values(productStatsMonth)
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 5)
        .map(p => `${p.name} (฿${p.revenue.toLocaleString()})`)
        .join(', ');

    // ===================================================
    // 4. CONSTRUCT PROMPT (The Intelligent Brain)
    // ===================================================

    // Format debt list for context
    const debtListText = debtList.slice(0, 5).map(d =>
        `• ${d.name}: ฿${d.amount.toLocaleString()} (${d.status || 'ไม่ระบุวันครบกำหนด'})`
    ).join('\n') || 'ไม่มีลูกหนี้';

    // Format expiry list for context WITH cost & price for profit calculation
    const expiryListText = expiryList.slice(0, 5).map(e =>
        `• ${e.name}: ${e.qty} ชิ้น (${e.status}) | ทุน ฿${e.costPrice} ราคาขาย ฿${e.sellPrice}`
    ).join('\n') || 'ไม่มีสินค้าใกล้หมดอายุ';

    // Format Date Range
    const startOfMonthDate = new Date(startOfMonth);
    const daysCount = new Date().getDate();
    const dateRangeStr = `${startOfMonthDate.getDate()} - ${new Date().getDate()} ${new Date().toLocaleString('default', { month: 'short' })} (${daysCount} Days)`;

    const contextText = `
[ROLE: AI Business Partner for Store "${storeName}"]
[LOCATION: ${address}] [SEASON: ${season}] [WEATHER: ${weatherText}]

💰 FINANCIALS (Period: ${dateRangeStr}):
- Revenue: ฿${Math.round(salesMonth).toLocaleString()} (Profit: ฿${Math.round(profitMonth).toLocaleString()})
- Cash Flow: ${salesMonth > 0 ? Math.round((cashSales / salesMonth) * 100) : 0}% Cash / ${salesMonth > 0 ? Math.round((creditSales / salesMonth) * 100) : 0}% Debt
- Debt Risk: ฿${(debts?.reduce((s, d) => s + parseFloat(d.remaining_amount), 0) || 0).toLocaleString()} outstanding

🏆 BEST SELLERS (This Month):
- By Quantity: ${bestSellersQty || 'No sales yet'}
- By Revenue: ${bestSellersRev || 'No sales yet'}

👥 ลูกหนี้ที่ต้องติดตาม (ใช้ชื่อจริงเหล่านี้):
${debtListText}

⏰ สินค้าใกล้หมดอายุ (ใช้ชื่อจริงเหล่านี้):
${expiryListText}

📦 INVENTORY MATRIX (Last 30 Days):
- 🚨 REORDER SOON (High Velocity): ${opportunities.slice(0, 5).join(', ') || 'None'}
- 📉 CLEARANCE (Dead Stock): ${sunkCosts.slice(0, 5).join(', ') || 'None'}

🛒 TRENDS:
- Best Pairs: ${topPairs.join(' | ') || 'None'}
- Peak Time: ${peakHourStr} (Best Day: ${bestDay})

GOAL: ใช้ข้อมูลจริงข้างบนเท่านั้น ห้ามคิดชื่อคน/สินค้าขึ้นมาเอง! ตอบคำถามเกี่ยวกับ "ร้านนี้" หรือ "เดือนนี้" โดยใช้ข้อมูลใน section 💰 FINANCIALS (This Month) และ 🏆 BEST SELLERS (This Month)
`.trim();

    return {
        context: contextText,
        raw: { address, weather, salesMonth, profitMonth, debtList, expiryList }
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

router.post('/chat', async (req, res) => {
    try {
        const { message, lat, lon, history } = req.body;
        const storeId = req.headers['x-store-id'];

        if (!storeId) return res.status(400).json({ success: false, error: 'Store ID required' });

        // Get fresh context
        const data = await getStoreSummary(storeId, lat, lon);

        const systemInstruction = `
${data.context}

You are a helpful, professional Thai business partner for this store.
Your goal is to provide actionable insights, not just raw numbers.

Guidelines for answering:
1. **Be Specific**: Always mention meaningful numbers (Quantity, Revenue ฿) when talking about products.
2. **Provide Context**: Mention the timeframe (e.g., "In the last 30 days", "This month").
3. **Analyze**: Don't just list data. Explain *what it means*.
   - Example: "Oishi sells best (50 units), earning ฿1,000. It's your main revenue driver."
   - Example: "Lay's is selling fast, you should check stock."
4. **Tone**: Professional, encouraging, and succinct (use "ครับ/ค่ะ"). 
5. **No Fluff**: Get straight to the point but keep the detail.

If the user asks something unrelated to the store, politely redirect them.
`.trim();

        // Initialize model per request to inject specific system instruction
        const chatModel = genAI.getGenerativeModel({
            model: "gemini-3-flash-preview",
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

// GET /api/ai/recommendations - Get or Generate 3 daily recommendations
router.get('/recommendations', async (req, res) => {
    try {
        const storeId = req.headers['x-store-id'];
        const userId = req.headers['x-user-id'] || req.user?.id;
        const { lat, lon } = req.query;

        if (!storeId || !userId) return res.status(400).json({ success: false, error: 'Store and User ID required' });

        // Use Thailand timezone (UTC+7) for "today" calculation
        // This ensures recommendations reset at midnight Bangkok time, not UTC
        const bangkokOffset = 7 * 60 * 60 * 1000; // 7 hours in milliseconds
        const nowBangkok = new Date(Date.now() + bangkokOffset);
        const todayBangkok = nowBangkok.toISOString().split('T')[0]; // YYYY-MM-DD in Bangkok time

        // Calculate start of today in Bangkok time, then convert to UTC for database query
        const startOfTodayBangkok = new Date(todayBangkok + 'T00:00:00+07:00');

        // 1. Check if recommendations already generated today (Bangkok time)
        const { data: existing } = await supabaseAdmin
            .from('ai_recommendations')
            .select('*')
            .eq('store_id', storeId)
            .eq('user_id', userId)
            .gte('created_at', startOfTodayBangkok.toISOString())
            .order('created_at', { ascending: true })
            .limit(3);

        if (existing && existing.length >= 3) {
            return res.json({ success: true, data: existing, cached: true });
        }

        // 2. Generate 3 New Recommendations using Gemini
        const data = await getStoreSummary(storeId, lat, lon);
        const prompt = `
${data.context}

คุณคือ AI ที่ปรึกษาธุรกิจอัจฉริยะสำหรับร้านโชห่วย ให้คำแนะนำที่คำนวณแม่นยำ ช่วยเจ้าของร้านตัดสินใจได้ทันที
สร้าง 3 คำแนะนำสำหรับวันนี้ในรูปแบบ JSON array:

[
  {
    "type": "expiry" | "debt" | "stock" | "price",
    "title": "หัวข้อสั้นๆ ไม่เกิน 8 คำ (ใช้ชื่อสินค้า/คนจริงจากข้อมูล)",
    "detail": "รายละเอียด 1 บรรทัด",
    "expected_impact": "ผลลัพธ์ที่คาดว่าจะได้ เช่น: คืนทุน 350 บาท (ปกติเสีย 500 บาท)",
    "reason": "เหตุผลละเอียดพร้อมการคำนวณจากข้อมูลจริง",
    "action_label": "ปุ่มสั้นๆ (เช่น ลด 20%, โปร 1แถม1)",
    "icon": "alert-triangle | account-clock | package-variant | trending-up",
    "urgency": "urgent" | "normal",
    
    "target_customers": ["ชื่อลูกหนี้ที่กล่าวถึง - เฉพาะ type=debt"],
    "target_products": ["ชื่อสินค้าที่กล่าวถึง - เฉพาะ type=expiry"],
    
    "recommended_discount": {
      "promotion_type": "discount_percent" | "buy_1_get_1" | "bundle",
      "percent": 20,
      "price_after_discount": 32,
      "profit_per_unit": 2,
      "total_recovery": 320,
      "vs_total_loss": 400,
      "reason": "..."
    }
  }
]

กฎสำคัญ (PRODUCTION LEVEL):
1. type=expiry ต้องมี recommended_discount เสมอ! คำนวณจากทุนและราคาขายจริง
2. recommended_discount.reason ต้องแสดง:
   - ทุน ฿X/ชิ้น ราคาขาย ฿Y/ชิ้น
   - ลด X% = ราคา ฿Z (กำไร/ขาดทุนเท่าไหร่)
   - เปรียบเทียบ 2-3 ระดับส่วนลด
   - สรุปว่าแนะนำลดเท่าไหร่และทำไม
2.1 ถ้าสต็อกเยอะมาก หรือขายไม่ออกนานๆ ให้พิจารณา "buy_1_get_1" (ซื้อ 1 แถม 1)
   - recommended_discount = { "promotion_type": "buy_1_get_1", "percent": 50, "reason": "สต็อกเหลือเยอะ ระบายด่วน ซื้อ 1 แถม 1 จูงใจกว่าลดราคา" }

3. สินค้าหมดอายุแล้ว → แนะนำ "ตัดสต็อก/ทิ้ง" แทนลดราคา (ขายไม่ได้แล้ว!)
   recommended_discount = { "percent": 100, "reason": "สินค้าหมดอายุแล้ว ขายไม่ได้ ต้องตัดสต็อกทิ้ง", "action": "dispose" }

4. type=debt ให้ระบุ target_customers เฉพาะ 1-2 คนที่เร่งด่วนที่สุด ไม่ใช่ทุกคน

5. ใช้ชื่อสินค้า/คนจริงจากข้อมูลเท่านั้น ห้ามคิดขึ้นมาเอง!

Output JSON array เท่านั้น ไม่ต้องมีอะไรอื่น
`.trim();

        const result = await retryWithBackoff(() => model.generateContent(prompt));
        const text = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        const suggestions = JSON.parse(text);

        // 3. Save to ai_recommendations table
        // Inject real data into payload based on type
        const toInsert = suggestions.slice(0, 3).map(s => {
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

        // Group by date
        const grouped = {};
        const today = new Date().toISOString().split('T')[0];
        const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

        data.forEach(item => {
            const date = item.created_at.split('T')[0];
            let label = date;
            if (date === today) label = 'วันนี้';
            else if (date === yesterday) label = 'เมื่อวาน';
            else {
                const diff = Math.floor((Date.now() - new Date(date).getTime()) / 86400000);
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

// GET /api/ai/recommendations/stats - Get stats for summary card
router.get('/recommendations/stats', async (req, res) => {
    try {
        const storeId = req.headers['x-store-id'];
        const userId = req.headers['x-user-id'] || req.user?.id;

        if (!storeId || !userId) return res.status(400).json({ success: false, error: 'Store and User ID required' });

        // Get this month's data
        const startOfMonth = new Date();
        startOfMonth.setDate(1);
        startOfMonth.setHours(0, 0, 0, 0);

        const { data: monthData, error: monthError } = await supabaseAdmin
            .from('ai_recommendations')
            .select('status, actual_amount, type')
            .eq('store_id', storeId)
            .eq('user_id', userId)
            .gte('created_at', startOfMonth.toISOString());

        if (monthError) throw monthError;

        // Calculate stats
        const totalRecommendations = monthData?.length || 0;
        const accepted = monthData?.filter(r => r.status === 'accepted') || [];
        const followedCount = accepted.length;
        const moneyEarned = accepted.reduce((sum, r) => sum + (parseFloat(r.actual_amount) || 0), 0);

        // Type breakdown
        const byType = {
            expiry: monthData?.filter(r => r.type === 'expiry' && r.status === 'accepted').length || 0,
            debt: monthData?.filter(r => r.type === 'debt' && r.status === 'accepted').length || 0,
            stock: monthData?.filter(r => r.type === 'stock' && r.status === 'accepted').length || 0,
        };

        // Calculate week number
        const weekOfMonth = Math.ceil(new Date().getDate() / 7);

        res.json({
            success: true,
            data: {
                weekNumber: weekOfMonth,
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

// ==================== AI ACTION ENDPOINTS ====================

// Apply Promotion - Create a time-limited discount for products
router.post('/apply-promotion', async (req, res) => {
    try {
        const storeId = req.headers['x-store-id'];
        const userId = req.headers['x-user-id'] || req.user?.id;
        const { recommendationId, productNames, discountPercent, promotionType = 'discount_percent', daysValid = 3 } = req.body;

        if (!storeId || !userId) {
            return res.status(400).json({ success: false, error: 'Store and User ID required' });
        }

        // 1. Find products by name (partial match)
        const { data: products, error: productError } = await supabaseAdmin
            .from('products')
            .select('id, name, price, cost_price')
            .eq('store_id', storeId)
            .or(productNames.map(n => `name.ilike.%${n}%`).join(','));

        if (productError) throw productError;

        if (!products || products.length === 0) {
            return res.status(404).json({ success: false, error: 'No matching products found' });
        }

        // 2. Setup Promotion Details
        let promoDiscountValue = discountPercent || 20;
        let dbPromoType = 'discount_percent';
        let minQty = 0;
        let freeQty = 0;
        let promoName = `AI แนะนำ: ลด ${promoDiscountValue}% - ${products.map(p => p.name).join(', ')}`;

        if (promotionType === 'buy_1_get_1') {
            dbPromoType = 'buy_x_get_y';
            minQty = 1;
            freeQty = 1;
            promoName = `AI แนะนำ: ซื้อ 1 แถม 1 - ${products.map(p => p.name).join(', ')}`;
            promoDiscountValue = 0; // Not used for this type
        } else if (promotionType === 'bundle') {
            dbPromoType = 'bundle';
            // Logic for bundle could be detailed later, assuming simple discount for now
            promoName = `AI แนะนำ: ซื้อคู่ถูกกว่า - ${products.map(p => p.name).join(', ')}`;
        }

        // 3. Create Promotion record
        const endDate = new Date();
        endDate.setDate(endDate.getDate() + daysValid);

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
                is_active: true
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
                    discountedPrice: Math.round(p.price * (1 - promoDiscountValue / 100))
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
            .select('id, name, stock_qty')
            .eq('store_id', storeId)
            .or(productNames.map(n => `name.ilike.%${n}%`).join(','));

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
                    .eq('id', product.id);

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
                    actual_outcome: `ตัดสต็อก ${totalDisposed} ชิ้น จาก ${disposedItems.length} batch`
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

