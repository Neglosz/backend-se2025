const { createClient } = require('@supabase/supabase-js');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("Missing Supabase credentials in .env");
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Helper to simulate calling the context API logic
const testAIContext = async () => {
    console.log("🚀 Starting AI Context Test...");

    // 1. Get a valid Store ID
    const { data: store } = await supabase.from('stores').select('id, name').limit(1).single();
    if (!store) {
        console.error("❌ No stores found in database.");
        return;
    }
    console.log(`📍 Testing for Store: ${store.name} (${store.id})`);

    // 2. Mock Location (Siam Paragon, Bangkok)
    const lat = 13.7462;
    const lon = 100.5350;
    console.log(`🌍 Location: ${lat}, ${lon} (Simulating Bangkok)`);

    console.log("\n--- Executing Logic Standalone ---\n");
    await runLogic(store.id, lat, lon);
};

// --- LOGIC COPY FROM ai.js (Simplified for Test) ---
const runLogic = async (storeId, lat, lon) => {
    try {
        // Weather
        console.log("☁️  Fetching Weather...");
        const weatherRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`);
        const weatherData = await weatherRes.json();
        const temp = weatherData.current_weather?.temperature;
        const code = weatherData.current_weather?.weathercode;
        console.log(`   > Temp: ${temp}°C, Code: ${code}`);

        // Address
        console.log("🏘️  Fetching Address...");
        const addrRes = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=14&addressdetails=1`, {
            headers: { 'User-Agent': 'Test-Script' }
        });
        const addrData = await addrRes.json();
        const district = addrData.address?.city_district || addrData.address?.district || 'Unknown District';
        const province = addrData.address?.province || 'Unknown Province';
        console.log(`   > Address: ${district}, ${province}`);

        // Database Queries
        console.log("💾  Fetching Store Data...");
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        const { data: orders } = await supabase.from('orders').select('total_amount, payment_type').eq('store_id', storeId).gte('created_at', thirtyDaysAgo.toISOString());
        const { data: products } = await supabase.from('products').select('name, stock_qty').eq('store_id', storeId).limit(5);
        
        console.log(`   > Orders Found: ${orders?.length}`);
        
        const productList = products?.map(p => p.name).join(', ') || 'No products';
        console.log(`   > Products Sample: ${productList}`);

        console.log("\n✅ Test Complete! Logic connects to Weather, Map, and Database successfully.");
    } catch (e) {
        console.error("❌ Test Failed:", e);
    }
};

testAIContext();