require('dotenv').config({ path: '../pos_application/.env' });
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY; // Use anon key for now, hoping RLS allows or we use service key if available

if (!supabaseUrl || !supabaseKey) {
    console.error('Missing Supabase URL or Key');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function migrate() {
    console.log('Starting migration...');

    // 1. Add column (Using a raw SQL function if available or just update logic)
    // Since we can't run raw SQL easily without service role key or specific setup, 
    // we might need to use a Postgres function if one exists for running SQL, 
    // OR just use the Dashboard. 
    // BUT, usually we can use `rpc` if we have a function to run sql.

    // Attempting to use a workaround or check if we can jus update data.
    // Wait, if we can't run DDL (ALTER TABLE) via client easily without a specific RPC,
    // we might be blocked on adding the column programmatically from here if we don't have the Service Role Key.

    // Let's try to check environmental variables for SERVICE_ROLE_KEY if the user has it.
    // If not, we might need to ask the user to run the SQL in their Supabase Dashboard.

    console.log('Checking connection...');
    const { data, error } = await supabase.from('customers_info').select('count', { count: 'exact', head: true });

    if (error) {
        console.error('Connection failed:', error);
        return;
    }

    console.log('Connection successful. Connection to existing table works.');
    console.log('Please execute the following SQL in your Supabase Dashboard > SQL Editor:');
    console.log(`
    -- 1. Add due_date column to customers_info
    ALTER TABLE customers_info ADD COLUMN IF NOT EXISTS due_date DATE;

    -- 2. Migrate latest due_date
    UPDATE customers_info c
    SET due_date = sub.max_due_date
    FROM (
        SELECT customer_id, MAX(due_date) as max_due_date
        FROM credit_accounts
        GROUP BY customer_id
    ) sub
    WHERE c.id = sub.customer_id;
    `);
}

migrate();
