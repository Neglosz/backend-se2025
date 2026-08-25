// Deterministic env for every test run. Must be 32 bytes for aes-256-cbc.
process.env.ENCRYPTION_KEY = '12345678901234567890123456789012';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.NODE_ENV = 'test';

// Pin the timezone so local-date arithmetic in utils/date.js is reproducible
// on any machine or CI runner.
process.env.TZ = 'Asia/Bangkok';
