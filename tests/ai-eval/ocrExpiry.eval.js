/**
 * LIVE evaluation of POST /api/ai/ocr-expiry.
 *
 * This endpoint feeds a photo of a product label to the vision model and writes the
 * returned date straight onto a stock batch, so a misread is a wrong expiry date in
 * the store's inventory. It was the only AI endpoint never exercised against the real
 * model. Labels are rendered here as PNGs (see textImage.js) so the input is exact and
 * nothing has to be committed as a binary fixture.
 *
 *   npm run eval:ocr
 *   OCR_EVAL_RUNS=3 npm run eval:ocr
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env'), override: true });

const request = require('supertest');
const express = require('express');

let mockDb;
jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn(() => mockDb) }));

const { createMockSupabase } = require('../helpers/mockSupabase');
const { renderTextPng } = require('./textImage');

mockDb = createMockSupabase();
const aiRoutes = require('../../routes/ai');

const RUNS = Number(process.env.OCR_EVAL_RUNS || 2);

const CASES = [
    {
        id: 'gregorian_ddmmyyyy',
        lines: ['EXP 25/12/2025'],
        expect: '2025-12-25',
        why: 'plain Gregorian date in the format Thai labels use'
    },
    {
        id: 'buddhist_era',
        lines: ['EXP 15/03/2569'],
        expect: '2026-03-15',
        why: 'Buddhist era year must be converted (2569 - 543 = 2026)'
    },
    {
        id: 'best_before_label',
        lines: ['BB 01/06/2026'],
        expect: '2026-06-01',
        why: '"BB" is the other abbreviation the prompt lists'
    },
    {
        id: 'mfg_and_exp_together',
        lines: ['MFG 01/01/2025', 'EXP 01/07/2026'],
        expect: '2026-07-01',
        why: 'must pick the expiry, not the manufacturing date'
    },
    {
        id: 'mfg_only',
        lines: ['MFG 10/05/2025'],
        expectNotFound: true,
        why: 'a manufacturing date alone is not an expiry date'
    },
    {
        id: 'no_date_at_all',
        lines: ['HELLO WORLD'],
        expectNotFound: true,
        why: 'nothing to read — must report failure, not invent a date'
    }
];

function buildApp() {
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use((req, _res, next) => { req.user = { id: 'user-eval-1' }; next(); });
    app.use('/api/ai', aiRoutes);
    return app;
}

describe('OCR expiry — live vision evaluation', () => {
    const results = [];
    let app;
    let errorSpy;

    beforeAll(() => {
        if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) {
            throw new Error('GEMINI_API_KEY is required for the live OCR evaluation');
        }
    });

    beforeEach(() => {
        mockDb.reset();
        app = buildApp();
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => errorSpy.mockRestore());

    for (const testCase of CASES) {
        it(`${testCase.id}: ${testCase.why}`, async () => {
            const imageBase64 = renderTextPng(testCase.lines).toString('base64');

            for (let run = 1; run <= RUNS; run++) {
                // eslint-disable-next-line no-await-in-loop
                const res = await request(app).post('/api/ai/ocr-expiry')
                    .set({ 'x-store-id': 'store-eval-1' })
                    .send({ imageBase64 });

                expect(res.status).toBe(200);

                const pass = testCase.expectNotFound
                    ? res.body.success === false
                    : res.body.success === true && res.body.date === testCase.expect;

                results.push({
                    label: `${testCase.id}#${run}`,
                    checks: [{
                        id: testCase.expectNotFound ? 'reports_not_found' : 'reads_correct_date',
                        pass,
                        detail: `expected ${testCase.expectNotFound ? 'success:false' : testCase.expect}, got ${JSON.stringify(res.body)}`
                    }]
                });
            }
        }, 300000);
    }

    afterAll(() => {
        const lines = results.map((r) => {
            const c = r.checks[0];
            return `  ${c.pass ? 'ok  ' : 'FAIL'}  ${r.label.padEnd(28)} ${c.pass ? '' : c.detail}`;
        });
        const passed = results.filter((r) => r.checks[0].pass).length;
        process.stdout.write(
            `\n=== OCR EXPIRY (live vision) — ${passed}/${results.length} ===\n${lines.join('\n')}\n\n`
        );

        require('fs').writeFileSync(
            require('path').join(__dirname, 'last-ocr-run.json'),
            JSON.stringify({ generatedAt: new Date().toISOString(), runs: RUNS, results }, null, 2),
            'utf8'
        );
    });
});
