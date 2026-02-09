const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://cwvqefsiapnarjbugllt.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN3dnFlZnNpYXBuYXJqYnVnbGx0Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NTg4NjQxMCwiZXhwIjoyMDgxNDYyNDEwfQ.YT0PrDeOa8YOtIgz-Bnt3Pt_UOhKY9DcuXJoGoypErw';
const STORE_ID = '37628c4d-d9d1-4f94-a1a6-7ad756c843ee'; // SE-7-11

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function runDebug() {
    console.log("Checking Store Owner and Notifications...");
    
    // 1. Get Store Owner
    const { data: store } = await supabaseAdmin.from('stores').select('owner_id').eq('id', STORE_ID).single();
    console.log("Store Owner ID:", store.owner_id);

    // 2. Check existing notifications for Owner
    const { data: notifs } = await supabaseAdmin
        .from('notifications')
        .select('*')
        .eq('store_id', STORE_ID)
        .eq('user_id', store.owner_id)
        .order('created_at', { ascending: false });

    console.log(`Found ${notifs.length} notifications for Owner.`);
    for (const n of notifs.slice(0, 5)) {
        console.log(`- [${n.created_at}] Type: ${n.type} | Title: ${n.title} | Read: ${n.is_read}`);
    }
}

runDebug();