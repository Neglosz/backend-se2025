require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { createClient } = require('@supabase/supabase-js');

const authMiddleware = require('./middleware/auth');
const rateLimiter = require('./middleware/rateLimiter');
const { productValidators, categoryValidators, creditPaymentValidators } = require('./middleware/validators');

const branchesRoutes = require('./routes/branches');
const aiRoutes = require('./routes/ai');
const { registerApiRoutes } = require('./routes/api');

const { encrypt, decrypt } = require('./utils/crypto');
const { convertDateFormat } = require('./utils/date');

const { createStoreService } = require('./services/storeService');
const { createNotificationService } = require('./services/notificationService');

const promptpay = require('promptpay-qr');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(helmet());

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

// Admin client bypasses RLS - use for backend operations
const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const { checkStoreAccess, signUrlIfNeeded } = createStoreService({ supabaseAdmin });
const { upsertNotificationGlobal, deleteNotificationGlobal } = createNotificationService({ supabaseAdmin });

registerApiRoutes({
    app,
    authMiddleware,
    rateLimiter,
    productValidators,
    categoryValidators,
    creditPaymentValidators,
    branchesRoutes,
    aiRoutes,
    supabase,
    supabaseAdmin,
    encrypt,
    decrypt,
    promptpay,
    checkStoreAccess,
    signUrlIfNeeded,
    convertDateFormat,
    upsertNotificationGlobal,
    deleteNotificationGlobal
});

// Global 404 Handler (Must be last)
app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Endpoint not found' });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
