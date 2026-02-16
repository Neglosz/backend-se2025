const { registerSystemRoutes } = require('./systemRoutes');
const { registerStoreSettingsRoutes } = require('./storeSettingsRoutes');
const { registerStockRoutes } = require('./stockRoutes');
const { registerCustomerDebtRoutes } = require('./customerDebtRoutes');
const { registerNotificationRoutes } = require('./notificationRoutes');
const { registerCustomerCrudRoutes } = require('./customerCrudRoutes');
const { registerSalesRoutes } = require('./salesRoutes');
const { registerProductRoutes } = require('./productRoutes');
const { registerReportRoutes } = require('./reportRoutes');
const { registerTransactionRoutes } = require('./transactionRoutes');
const { registerOrderRoutes } = require('./orderRoutes');

const registerApiRoutes = ({
    app,
    authMiddleware,
    rateLimiter,
    productValidators,
    categoryValidators,
    creditPaymentValidators,
    branchesRoutes,
    aiRoutes,
    supabaseAdmin,
    encrypt,
    decrypt,
    promptpay,
    checkStoreAccess,
    signUrlIfNeeded,
    convertDateFormat,
    upsertNotificationGlobal,
    deleteNotificationGlobal
}) => {
    registerSystemRoutes({ app, authMiddleware, supabaseAdmin });

    app.use('/api', authMiddleware);
    app.use('/api', rateLimiter); // Apply rate limiting to all API routes

    registerStoreSettingsRoutes({
        app,
        supabaseAdmin,
        encrypt,
        decrypt,
        promptpay,
        checkStoreAccess
    });

    // Keep this duplicate middleware in the same relative position to preserve existing behavior.
    app.use('/api', rateLimiter);

    registerStockRoutes({
        app,
        supabaseAdmin,
        checkStoreAccess,
        upsertNotificationGlobal
    });

    app.use('/api/branches', authMiddleware, branchesRoutes);
    app.use('/api/ai', aiRoutes);

    registerCustomerDebtRoutes({
        app,
        supabaseAdmin,
        creditPaymentValidators,
        checkStoreAccess,
        signUrlIfNeeded,
        deleteNotificationGlobal
    });

    registerNotificationRoutes({
        app,
        supabaseAdmin,
        checkStoreAccess,
        upsertNotificationGlobal
    });

    registerCustomerCrudRoutes({
        app,
        supabaseAdmin,
        checkStoreAccess
    });

    registerSalesRoutes({
        app,
        supabaseAdmin,
        checkStoreAccess,
        upsertNotificationGlobal,
        convertDateFormat
    });

    registerProductRoutes({
        app,
        supabaseAdmin,
        categoryValidators,
        checkStoreAccess,
        convertDateFormat,
        deleteNotificationGlobal
    });

    registerReportRoutes({
        app,
        supabaseAdmin,
        checkStoreAccess
    });

    registerTransactionRoutes({
        app,
        supabaseAdmin,
        checkStoreAccess
    });

    registerOrderRoutes({
        app,
        supabaseAdmin,
        checkStoreAccess
    });
};

module.exports = { registerApiRoutes };
