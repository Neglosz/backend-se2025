const { createClient } = require('@supabase/supabase-js');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

// Create Supabase Client for token verification (using Anon Key)
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

const authMiddleware = async (req, res, next) => {
    try {
        // 1. Get Token from Header "Authorization: Bearer <token>"
        const authHeader = req.headers.authorization;

        if (!authHeader) {
            return res.status(401).json({ success: false, error: 'Missing Authorization Header' });
        }

        const token = authHeader.split(' ')[1]; // Split "Bearer "

        if (!token) {
            return res.status(401).json({ success: false, error: 'Invalid Token Format' });
        }

        // 2. Verify Token with Supabase
        const { data: { user }, error } = await supabase.auth.getUser(token);

        if (error || !user) {
            console.error('Auth Error:', error);
            return res.status(401).json({ success: false, error: 'Invalid or Expired Token' });
        }

        // 3. Attach User to Request for next routes
        req.user = user;

        next(); // Proceed

    } catch (error) {
        console.error('Auth Middleware Critical Error:', error);
        res.status(500).json({ success: false, error: 'Internal Server Error' });
    }
};

module.exports = authMiddleware;