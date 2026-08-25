// Deterministic env for every test run.
//
// Existing values are never overwritten: the offline suites double both Supabase and
// Gemini so these placeholders are enough, while the live evaluation runs (and CI)
// need the real credentials they were given to survive.
const defaults = {
    // Must be 32 bytes for aes-256-cbc.
    ENCRYPTION_KEY: '12345678901234567890123456789012',
    SUPABASE_URL: 'http://localhost:54321',
    SUPABASE_ANON_KEY: 'test-anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    GEMINI_API_KEY: 'test-gemini-key',
    NODE_ENV: 'test',
    // Pin the timezone so local-date arithmetic in utils/date.js is reproducible
    // on any machine or CI runner.
    TZ: 'Asia/Bangkok'
};

for (const [key, value] of Object.entries(defaults)) {
    if (!process.env[key]) process.env[key] = value;
}
