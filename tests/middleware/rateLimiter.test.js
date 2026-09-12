const request = require('supertest');
const express = require('express');

describe('middleware/rateLimiter', () => {
    let limiter;

    beforeEach(() => {
        jest.resetModules();
        limiter = require('../../middleware/rateLimiter');
    });

    function appWithLimiter() {
        const app = express();
        app.set('trust proxy', 1);
        app.use(limiter);
        app.get('/', (req, res) => res.json({ success: true }));
        return app;
    }

    it('lets a normal request through and sets standard RateLimit headers', async () => {
        const res = await request(appWithLimiter()).get('/');

        expect(res.status).toBe(200);
        expect(res.headers).toHaveProperty('ratelimit-limit');
        expect(res.headers).not.toHaveProperty('x-ratelimit-limit'); // legacyHeaders: false
    });

    it('advertises a limit of 300 requests', async () => {
        const res = await request(appWithLimiter()).get('/');
        expect(Number(res.headers['ratelimit-limit'])).toBe(300);
    });

    it('blocks with 429 and the documented JSON body once the window budget is spent', async () => {
        const app = appWithLimiter();
        const agent = request(app);

        // 300 allowed, the 301st must be refused.
        for (let i = 0; i < 300; i++) {
            // eslint-disable-next-line no-await-in-loop
            const ok = await agent.get('/');
            expect(ok.status).toBe(200);
        }

        const blocked = await agent.get('/');
        expect(blocked.status).toBe(429);
        expect(blocked.body).toEqual({
            success: false,
            error: 'Too many requests from this IP, please try again after 1 minute'
        });
    }, 30000);

    it('counts per client IP, so one blocked client does not block another', async () => {
        const app = appWithLimiter();

        for (let i = 0; i < 300; i++) {
            // eslint-disable-next-line no-await-in-loop
            await request(app).get('/').set('X-Forwarded-For', '10.0.0.1');
        }

        const blocked = await request(app).get('/').set('X-Forwarded-For', '10.0.0.1');
        const other = await request(app).get('/').set('X-Forwarded-For', '10.0.0.2');

        expect(blocked.status).toBe(429);
        expect(other.status).toBe(200);
    }, 30000);
});
