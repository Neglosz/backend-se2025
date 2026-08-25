const request = require('supertest');
const express = require('express');
const {
    productValidators,
    categoryValidators,
    creditPaymentValidators
} = require('../../middleware/validators');

/** Mount one validator chain on POST / and echo the body when it passes. */
function appWith(validators) {
    const app = express();
    app.use(express.json());
    app.post('/', validators, (req, res) => res.json({ success: true, body: req.body }));
    return app;
}

describe('middleware/validators', () => {
    describe('validate() error shape', () => {
        it('returns 400 with success:false, a Validation Error label and per-field details', async () => {
            const res = await request(appWith(categoryValidators)).post('/').send({ name: '' });

            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.error).toBe('Validation Error');
            expect(Array.isArray(res.body.details)).toBe(true);
            expect(res.body.details.length).toBeGreaterThan(0);
            expect(res.body.details[0]).toHaveProperty('msg');
        });

        it('calls the handler untouched when everything passes', async () => {
            const res = await request(appWith(categoryValidators)).post('/').send({ name: 'เครื่องดื่ม' });

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ success: true, body: { name: 'เครื่องดื่ม' } });
        });
    });

    describe('productValidators', () => {
        const valid = { name: 'น้ำเปล่า', quantity: 10, costPrice: 5, salePrice: 8 };

        it('accepts a valid product', async () => {
            const res = await request(appWith(productValidators)).post('/').send(valid);
            expect(res.status).toBe(200);
        });

        it('accepts numeric strings (form-encoded clients send strings)', async () => {
            const res = await request(appWith(productValidators))
                .post('/')
                .send({ ...valid, quantity: '10', costPrice: '5.5', salePrice: '8.25' });
            expect(res.status).toBe(200);
        });

        it('accepts an optional lowStockThreshold and omits it silently', async () => {
            expect((await request(appWith(productValidators)).post('/').send({ ...valid, lowStockThreshold: 3 })).status).toBe(200);
            expect((await request(appWith(productValidators)).post('/').send(valid)).status).toBe(200);
        });

        it('rejects an empty or whitespace-only name', async () => {
            for (const name of ['', '   ']) {
                const res = await request(appWith(productValidators)).post('/').send({ ...valid, name });
                expect(res.status).toBe(400);
                expect(JSON.stringify(res.body.details)).toContain('Product name is required');
            }
        });

        it('rejects a name longer than 100 characters', async () => {
            const res = await request(appWith(productValidators)).post('/').send({ ...valid, name: 'x'.repeat(101) });
            expect(res.status).toBe(400);
            expect(JSON.stringify(res.body.details)).toContain('Name too long');
        });

        it('accepts a name of exactly 100 characters (boundary)', async () => {
            const res = await request(appWith(productValidators)).post('/').send({ ...valid, name: 'x'.repeat(100) });
            expect(res.status).toBe(200);
        });

        it('rejects negative quantity, costPrice and salePrice', async () => {
            for (const field of ['quantity', 'costPrice', 'salePrice']) {
                const res = await request(appWith(productValidators)).post('/').send({ ...valid, [field]: -1 });
                expect(res.status).toBe(400);
            }
        });

        it('accepts zero for quantity and prices (boundary, min:0)', async () => {
            const res = await request(appWith(productValidators))
                .post('/')
                .send({ ...valid, quantity: 0, costPrice: 0, salePrice: 0 });
            expect(res.status).toBe(200);
        });

        it('rejects non-numeric prices', async () => {
            const res = await request(appWith(productValidators)).post('/').send({ ...valid, salePrice: 'free' });
            expect(res.status).toBe(400);
        });

        it('rejects a payload missing the numeric fields entirely', async () => {
            const res = await request(appWith(productValidators)).post('/').send({ name: 'ของ' });
            expect(res.status).toBe(400);
            expect(res.body.details.length).toBeGreaterThanOrEqual(3);
        });
    });

    describe('categoryValidators', () => {
        it('accepts Thai, English, digits and spaces', async () => {
            for (const name of ['เครื่องดื่ม', 'Snacks 2', 'ของใช้ ทั่วไป', 'ABC123']) {
                const res = await request(appWith(categoryValidators)).post('/').send({ name });
                expect(res.status).toBe(200);
            }
        });

        it('rejects punctuation and symbols', async () => {
            for (const name of ['drinks!', 'a<script>', 'ของ-ใช้', 'emoji😀']) {
                const res = await request(appWith(categoryValidators)).post('/').send({ name });
                expect(res.status).toBe(400);
                expect(JSON.stringify(res.body.details)).toContain('invalid characters');
            }
        });

        it('rejects an empty name', async () => {
            const res = await request(appWith(categoryValidators)).post('/').send({ name: '   ' });
            expect(res.status).toBe(400);
        });

        it('rejects a name longer than 50 characters but accepts exactly 50', async () => {
            expect((await request(appWith(categoryValidators)).post('/').send({ name: 'a'.repeat(51) })).status).toBe(400);
            expect((await request(appWith(categoryValidators)).post('/').send({ name: 'a'.repeat(50) })).status).toBe(200);
        });
    });

    describe('creditPaymentValidators', () => {
        const valid = { customer_id: 'cust-1', amount: 50, payment_method: 'cash' };

        it('accepts every allowed payment method', async () => {
            for (const payment_method of ['cash', 'transfer', 'qr', 'qr_promptpay']) {
                const res = await request(appWith(creditPaymentValidators)).post('/').send({ ...valid, payment_method });
                expect(res.status).toBe(200);
            }
        });

        it('rejects an unknown payment method', async () => {
            const res = await request(appWith(creditPaymentValidators)).post('/').send({ ...valid, payment_method: 'bitcoin' });
            expect(res.status).toBe(400);
            expect(JSON.stringify(res.body.details)).toContain('Invalid payment method');
        });

        it('rejects a missing or non-string customer_id', async () => {
            expect((await request(appWith(creditPaymentValidators)).post('/').send({ ...valid, customer_id: '' })).status).toBe(400);
            expect((await request(appWith(creditPaymentValidators)).post('/').send({ ...valid, customer_id: 123 })).status).toBe(400);
        });

        it('rejects a zero or negative amount (must be > 0)', async () => {
            for (const amount of [0, -5]) {
                const res = await request(appWith(creditPaymentValidators)).post('/').send({ ...valid, amount });
                expect(res.status).toBe(400);
                expect(JSON.stringify(res.body.details)).toContain('greater than 0');
            }
        });

        it('accepts a fractional amount', async () => {
            const res = await request(appWith(creditPaymentValidators)).post('/').send({ ...valid, amount: 0.5 });
            expect(res.status).toBe(200);
        });
    });
});
