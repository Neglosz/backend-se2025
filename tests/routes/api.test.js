jest.mock('../../routes/systemRoutes', () => ({ registerSystemRoutes: jest.fn() }));
jest.mock('../../routes/storeSettingsRoutes', () => ({ registerStoreSettingsRoutes: jest.fn() }));
jest.mock('../../routes/stockRoutes', () => ({ registerStockRoutes: jest.fn() }));
jest.mock('../../routes/customerDebtRoutes', () => ({ registerCustomerDebtRoutes: jest.fn() }));
jest.mock('../../routes/notificationRoutes', () => ({ registerNotificationRoutes: jest.fn() }));
jest.mock('../../routes/customerCrudRoutes', () => ({ registerCustomerCrudRoutes: jest.fn() }));
jest.mock('../../routes/salesRoutes', () => ({ registerSalesRoutes: jest.fn() }));
jest.mock('../../routes/productRoutes', () => ({ registerProductRoutes: jest.fn() }));
jest.mock('../../routes/reportRoutes', () => ({ registerReportRoutes: jest.fn() }));
jest.mock('../../routes/transactionRoutes', () => ({ registerTransactionRoutes: jest.fn() }));
jest.mock('../../routes/orderRoutes', () => ({ registerOrderRoutes: jest.fn() }));

const { registerApiRoutes } = require('../../routes/api');
const { registerSystemRoutes } = require('../../routes/systemRoutes');
const { registerStoreSettingsRoutes } = require('../../routes/storeSettingsRoutes');
const { registerStockRoutes } = require('../../routes/stockRoutes');
const { registerCustomerDebtRoutes } = require('../../routes/customerDebtRoutes');
const { registerNotificationRoutes } = require('../../routes/notificationRoutes');
const { registerCustomerCrudRoutes } = require('../../routes/customerCrudRoutes');
const { registerSalesRoutes } = require('../../routes/salesRoutes');
const { registerProductRoutes } = require('../../routes/productRoutes');
const { registerReportRoutes } = require('../../routes/reportRoutes');
const { registerTransactionRoutes } = require('../../routes/transactionRoutes');
const { registerOrderRoutes } = require('../../routes/orderRoutes');

/** Build the dependency bag `server.js` hands to `registerApiRoutes`. */
function makeDeps() {
    const app = { use: jest.fn() };
    return {
        app,
        authMiddleware: jest.fn(),
        rateLimiter: jest.fn(),
        productValidators: ['productValidators'],
        categoryValidators: ['categoryValidators'],
        creditPaymentValidators: ['creditPaymentValidators'],
        branchesRoutes: 'branchesRouter',
        aiRoutes: 'aiRouter',
        supabaseAdmin: { tag: 'admin' },
        encrypt: jest.fn(),
        decrypt: jest.fn(),
        promptpay: jest.fn(),
        checkStoreAccess: jest.fn(),
        signUrlIfNeeded: jest.fn(),
        convertDateFormat: jest.fn(),
        upsertNotificationGlobal: jest.fn(),
        deleteNotificationGlobal: jest.fn()
    };
}

describe('routes/api registerApiRoutes()', () => {
    let deps;

    beforeEach(() => {
        deps = makeDeps();
        registerApiRoutes(deps);
    });

    it('registers every route module exactly once', () => {
        for (const register of [
            registerSystemRoutes, registerStoreSettingsRoutes, registerStockRoutes,
            registerCustomerDebtRoutes, registerNotificationRoutes, registerCustomerCrudRoutes,
            registerSalesRoutes, registerProductRoutes, registerReportRoutes,
            registerTransactionRoutes, registerOrderRoutes
        ]) {
            expect(register).toHaveBeenCalledTimes(1);
        }
    });

    it('mounts auth before the rate limiter on /api', () => {
        const apiMounts = deps.app.use.mock.calls.filter(([path]) => path === '/api');

        expect(apiMounts).toEqual([['/api', deps.authMiddleware], ['/api', deps.rateLimiter]]);
    });

    it('registers system routes BEFORE the /api auth guard (they carry their own)', () => {
        // registerSystemRoutes attaches authMiddleware per route, so it must run before
        // the blanket app.use('/api', authMiddleware) or those routes would be guarded twice.
        const authMountOrder = deps.app.use.mock.invocationCallOrder[0];
        expect(registerSystemRoutes.mock.invocationCallOrder[0]).toBeLessThan(authMountOrder);
        expect(registerSystemRoutes).toHaveBeenCalledWith({
            app: deps.app,
            authMiddleware: deps.authMiddleware,
            supabaseAdmin: deps.supabaseAdmin
        });
    });

    it('guards the branches router with auth and mounts the AI router', () => {
        expect(deps.app.use).toHaveBeenCalledWith('/api/branches', deps.authMiddleware, deps.branchesRoutes);
        expect(deps.app.use).toHaveBeenCalledWith('/api/ai', deps.aiRoutes);
    });

    it('registers every module after the auth guard is mounted', () => {
        const authMountOrder = deps.app.use.mock.invocationCallOrder[0];

        for (const register of [
            registerStoreSettingsRoutes, registerStockRoutes, registerCustomerDebtRoutes,
            registerNotificationRoutes, registerCustomerCrudRoutes, registerSalesRoutes,
            registerProductRoutes, registerReportRoutes, registerTransactionRoutes, registerOrderRoutes
        ]) {
            expect(register.mock.invocationCallOrder[0]).toBeGreaterThan(authMountOrder);
        }
    });

    it('gives every module the admin Supabase client', () => {
        for (const register of [
            registerStoreSettingsRoutes, registerStockRoutes, registerCustomerDebtRoutes,
            registerNotificationRoutes, registerCustomerCrudRoutes, registerSalesRoutes,
            registerProductRoutes, registerReportRoutes, registerTransactionRoutes, registerOrderRoutes
        ]) {
            expect(register.mock.calls[0][0].supabaseAdmin).toBe(deps.supabaseAdmin);
        }
    });

    it('injects the crypto and promptpay helpers only into store settings', () => {
        expect(registerStoreSettingsRoutes).toHaveBeenCalledWith(expect.objectContaining({
            encrypt: deps.encrypt,
            decrypt: deps.decrypt,
            promptpay: deps.promptpay,
            checkStoreAccess: deps.checkStoreAccess
        }));
        expect(registerStockRoutes.mock.calls[0][0]).not.toHaveProperty('encrypt');
    });

    it('gives the notification upsert helper to stock, sales and notification routes', () => {
        for (const register of [registerStockRoutes, registerSalesRoutes, registerNotificationRoutes]) {
            expect(register.mock.calls[0][0].upsertNotificationGlobal).toBe(deps.upsertNotificationGlobal);
        }
    });

    it('gives the notification delete helper to debt and product routes', () => {
        expect(registerCustomerDebtRoutes.mock.calls[0][0].deleteNotificationGlobal).toBe(deps.deleteNotificationGlobal);
        expect(registerProductRoutes.mock.calls[0][0].deleteNotificationGlobal).toBe(deps.deleteNotificationGlobal);
    });

    it('passes the date converter to sales and product routes', () => {
        expect(registerSalesRoutes.mock.calls[0][0].convertDateFormat).toBe(deps.convertDateFormat);
        expect(registerProductRoutes.mock.calls[0][0].convertDateFormat).toBe(deps.convertDateFormat);
    });

    it('passes the matching validator chain to each module that needs one', () => {
        expect(registerCustomerDebtRoutes.mock.calls[0][0].creditPaymentValidators).toBe(deps.creditPaymentValidators);
        expect(registerProductRoutes.mock.calls[0][0].categoryValidators).toBe(deps.categoryValidators);
    });

    it('passes signUrlIfNeeded to the debt routes that render customer images', () => {
        expect(registerCustomerDebtRoutes.mock.calls[0][0].signUrlIfNeeded).toBe(deps.signUrlIfNeeded);
    });
});
