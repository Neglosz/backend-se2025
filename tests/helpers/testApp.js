const express = require('express');

/**
 * Build a minimal express app around one route module.
 *
 * The production wiring (`registerApiRoutes`) mounts `authMiddleware` on `/api`
 * before every route module runs, so each handler can assume `req.user` exists.
 * Tests get the same guarantee here without touching Supabase auth.
 *
 * @param {(deps: object) => void} register  the route module's register function
 * @param {object} deps                      dependencies injected into the module
 * @param {object} [options]
 * @param {object|null} [options.user]       value for `req.user` (null = no auth)
 */
function createTestApp(register, deps = {}, options = {}) {
    const { user = { id: 'user-1', email: 'owner@test.dev' } } = options;

    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use(express.urlencoded({ extended: true }));

    if (user) {
        app.use((req, _res, next) => {
            req.user = user;
            next();
        });
    }

    register({ app, ...deps });

    app.use((req, res) => res.status(404).json({ success: false, error: 'Endpoint not found' }));
    return app;
}

/** A `checkStoreAccess` double that always grants access. */
const allowAccess = jest.fn(async () => true);
/** A `checkStoreAccess` double that always denies access. */
const denyAccess = jest.fn(async () => false);

/** Standard store header used across the API. */
const STORE_ID = 'store-1';
const storeHeader = { 'x-store-id': STORE_ID };

module.exports = { createTestApp, allowAccess, denyAccess, STORE_ID, storeHeader };
