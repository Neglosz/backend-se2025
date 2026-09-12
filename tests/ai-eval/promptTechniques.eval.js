/**
 * A/B experiment on the REAL production prompt.
 *
 * `captured-prompts.json` holds the exact 8.8k-character prompt routes/ai.js sends
 * for the calmStore scenario (recorded with AI_EVAL_CAPTURE=1). Each arm replays it
 * verbatim and appends one prompt-engineering technique, so the only variable is the
 * technique itself.
 *
 * Rules measured — the two the production prompt keeps losing:
 *   R1  no product repeated across the five recommendations   (production rule 12)
 *   R2  type=pricing suggested_price is a multiple of 5 and differs from current
 *
 *   npm run eval:prompt
 *   PROMPT_EVAL_N=5 npm run eval:prompt
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env'), override: true });

const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { scenarios } = require('./fixtures');

const N = Number(process.env.PROMPT_EVAL_N || 4);
const CAPTURE_FILE = path.join(__dirname, 'captured-prompts.json');

const captured = JSON.parse(fs.readFileSync(CAPTURE_FILE, 'utf8'));
const BASE_PROMPT = captured[0].prompt;
const MODEL = captured[0].model;
const SCENARIO = scenarios.calmStore;

// --- The three techniques, appended to the untouched production prompt ---------

const FEW_SHOT = `

📚 ตัวอย่างคำตอบที่ถูกต้อง (ร้านอื่น ห้ามลอกชื่อสินค้า ดูแค่รูปแบบ):
[
 {"type":"expiry","title":"ตัดสต็อกนมสดหมดอายุ","target_products":["นมสดหนองโพ"],"action_label":"ตัดสต็อกทิ้ง","recommended_discount":{"promotion_type":"discount_percent","percent":100,"action":"dispose","reason":"หมดอายุแล้ว"}},
 {"type":"debt","title":"ทวงหนี้ป้าสมศรี ค้าง 12 วัน","target_customers":["ป้าสมศรี"],"action_label":"ทวงถามหนี้","recommended_discount":null},
 {"type":"stock","title":"เติมสต็อกน้ำดื่มสิงห์","target_products":["น้ำดื่มสิงห์ 600ml"],"action_label":"เติมสต็อก","recommended_discount":null},
 {"type":"pricing","title":"ขึ้นราคาไข่ไก่เบอร์ 2","target_products":["ไข่ไก่เบอร์ 2"],"current_price":5,"suggested_price":10,"price_change_reason":"กำไรบางเกิน (20%) ขึ้นราคาให้ได้ margin 50%","recommended_discount":null},
 {"type":"promotion","title":"จับคู่ขนมปังกับกาแฟ","target_products":["ขนมปังฟาร์มเฮ้าส์"],"action_label":"จัดโปรคู่","recommended_discount":{"promotion_type":"bundle","percent":10}}
]
สังเกต 2 อย่าง: สินค้าทั้ง 5 ข้อไม่ซ้ำกันแม้แต่ตัวเดียว และ suggested_price = 10 หารด้วย 5 ลงตัว`;

const COT = `

🧠 ก่อนตอบ ให้คิดเป็นขั้นตอนก่อน แล้วใส่ผลการคิดไว้ในสมาชิกตัวแรกของ array เป็น {"_thinking":"..."} (ระบบจะตัดทิ้งเอง) จากนั้นตามด้วยคำแนะนำ 5 ข้อ รวมเป็น 6 สมาชิก
ขั้นตอนการคิดที่ต้องทำใน _thinking:
 1) เขียนรายชื่อสินค้า/ลูกหนี้ที่หยิบมาใช้ได้ทั้งหมด
 2) จับคู่ทีละข้อ ข้อ 1..5 → ระบุว่าใช้สินค้าตัวไหน และขีดชื่อนั้นออกจากรายการ
 3) ตรวจซ้ำ: มีชื่อไหนถูกใช้เกิน 1 ครั้งไหม ถ้ามีให้เปลี่ยนเป็นสินค้าที่ยังไม่ถูกใช้
 4) ถ้ามีข้อ type=pricing: คำนวณราคาจากทุนจริง แล้วปัดให้หารด้วย 5 ลงตัว และตรวจว่าไม่เท่ากับ current_price`;

const CONTRASTIVE = `

⚖️ เทียบวิธีคิดผิด vs ถูก (สำคัญมาก):

❌ วิธีคิดที่ผิด:
 "ปลากระป๋องสามแม่ครัวขายดีสุด เอามาทำ pricing ข้อ 1 ... แล้วข้อ 5 นึกอะไรไม่ออก เอาปลากระป๋องมาจัดโปรช่วง peak hour อีกที
  ส่วนราคา: margin 14% ต่ำไป 12/(1-0.2)=15 แต่ 15 เท่าราคาเดิมพอดี งั้นตอบ 16 แทน ใกล้ๆ กันน่าจะได้"
 ผิดตรงไหน:
  (ก) ใช้ "ปลากระป๋องสามแม่ครัว" 2 ข้อ ทั้งที่ยังมีสินค้าอีก 3 ตัวที่ไม่ถูกแตะเลย → ผิดกฎห้ามซ้ำ
  (ข) ตอบ 16 เพราะ "ใกล้ๆ กัน" → 16 หารด้วย 5 ไม่ลงตัว ผิดกฎราคากลม

✅ วิธีคิดที่ถูก:
 "รายชื่อที่ใช้ได้: ปลากระป๋อง, ข้าวสาร, น้ำมันพืช, ซอสหอยนางรม
  ข้อ1 pricing → ปลากระป๋อง (ขีดออก) | ข้อ2 stock → ข้าวสาร (ขีดออก) | ข้อ3 promotion → ซอสหอยนางรม (ขีดออก)
  ข้อ4 pricing → น้ำมันพืช (ขีดออก) | ข้อ5 → ไม่เหลือสินค้าแล้ว ให้แนะนำเชิงกลยุทธ์ที่ไม่ผูกสินค้าเดิม เช่น โปรตามช่วงเวลา/สภาพอากาศ โดยไม่ใส่ target_products ซ้ำ
  ราคา: ปลากระป๋อง ทุน 12 margin 14% → เป้า 20% → 12/(1-0.2)=15.0 → 15 หารด้วย 5 ลงตัว แต่ 15 ≠ 14 ✓ ตอบ 15"`;

const ARMS = {
    A_production: BASE_PROMPT,
    B_fewshot: BASE_PROMPT + FEW_SHOT,
    C_cot: BASE_PROMPT + COT,
    D_contrastive_cot: BASE_PROMPT + COT + CONTRASTIVE
};

/** Score one raw model answer against R1 and R2. */
function score(raw) {
    const out = { parsed: false, r1: false, r2: false, pricingCount: 0, note: '' };
    let items;
    try {
        items = JSON.parse(String(raw).replace(/```json/g, '').replace(/```/g, '').trim());
    } catch {
        out.note = 'invalid JSON';
        return out;
    }
    if (!Array.isArray(items)) { out.note = 'not an array'; return out; }
    out.parsed = true;

    const suggestions = items.filter((i) => i && !i._thinking);
    if (suggestions.length !== 5) out.note = `${suggestions.length} items`;

    const names = suggestions.flatMap((s) => s.target_products || []);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    out.r1 = dupes.length === 0;
    if (dupes.length) out.note += (out.note ? ' | ' : '') + 'dup:' + [...new Set(dupes)].join(',');

    const pricing = suggestions.filter((s) => s.type === 'pricing' && s.suggested_price != null);
    out.pricingCount = pricing.length;
    const bad = pricing.filter((s) => Number(s.suggested_price) % 5 !== 0
        || Number(s.suggested_price) === Number(s.current_price));
    // No pricing item at all counts as compliant: the rule cannot be broken.
    out.r2 = bad.length === 0;
    if (bad.length) {
        out.note += (out.note ? ' | ' : '') + 'price:' + bad.map((s) => `${s.current_price}→${s.suggested_price}`).join(',');
    }

    // Sanity: names must still exist in the catalogue.
    const known = SCENARIO.products.map((p) => p.name);
    const unknown = names.filter((n) => !known.includes(n));
    if (unknown.length) out.note += (out.note ? ' | ' : '') + 'unknown:' + unknown.join(',');

    return out;
}

describe('prompt technique A/B on the production prompt', () => {
    const results = {};

    beforeAll(() => {
        if (!fs.existsSync(CAPTURE_FILE)) {
            throw new Error('captured-prompts.json missing — run AI_EVAL_CAPTURE=1 npm run eval:ai first');
        }
    });

    for (const [arm, prompt] of Object.entries(ARMS)) {
        it(`${arm}: ${N} samples`, async () => {
            const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
            const model = genAI.getGenerativeModel({ model: MODEL });

            const scores = [];
            for (let i = 0; i < N; i++) {
                // eslint-disable-next-line no-await-in-loop
                const res = await model.generateContent(prompt);
                scores.push(score(res.response.text()));
            }
            results[arm] = scores;
            expect(scores.length).toBe(N);
        }, 300000);
    }

    afterAll(() => {
        const rows = Object.entries(results).map(([arm, ss]) => {
            const pct = (k) => Math.round((ss.filter((s) => s[k]).length / ss.length) * 100);
            const notes = [...new Set(ss.map((s) => s.note).filter(Boolean))].slice(0, 2).join(' ; ');
            return `  ${arm.padEnd(18)} parsed ${String(pct('parsed')).padStart(3)}%  `
                + `R1 no-dup ${String(pct('r1')).padStart(3)}%  `
                + `R2 price/5 ${String(pct('r2')).padStart(3)}%   ${notes}`;
        });
        process.stdout.write(
            `\n=== PROMPT TECHNIQUE A/B on the real prompt (n=${N}/arm, ${MODEL}, scenario=calmStore) ===\n`
            + `${rows.join('\n')}\n\n`
        );

        fs.writeFileSync(
            path.join(__dirname, 'last-prompt-ab.json'),
            JSON.stringify({ generatedAt: new Date().toISOString(), n: N, model: MODEL, results }, null, 2),
            'utf8'
        );
    });
});
