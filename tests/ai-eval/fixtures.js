/**
 * Store scenarios for the live AI evaluation.
 *
 * Each scenario describes a realistic Thai grocery store and, crucially, the ground
 * truth the model's answer is graded against: which products exist, which are expired,
 * which are out of stock, and which already carry a promotion.
 */

const STORE_ID = 'store-eval-1';

/** ISO timestamp `daysAgo` days before now. */
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

/** YYYY-MM-DD offset from today in Bangkok terms. */
const dateOffset = (n) => new Date(Date.now() + 7 * 3600 * 1000 + n * 86400000).toISOString().split('T')[0];

/** Build an order row with its items, in the shape getStoreSummary selects. */
function order(id, items, { payment_type = 'cash_sale', createdDaysAgo = 3 } = {}) {
    const total = items.reduce((s, i) => s + i.qty * i.price, 0);
    return {
        id,
        total_amount: total,
        payment_type,
        created_at: daysAgo(createdDaysAgo),
        order_items: items.map((i) => ({
            qty: i.qty,
            price_per_unit: i.price,
            cost_price_at_sale: i.cost,
            subtotal: i.qty * i.price,
            unit: i.unit || 'ชิ้น',
            products: { id: i.id, name: i.name, unit_type: i.unit || 'ชิ้น' }
        }))
    };
}

const scenarios = {
    /**
     * The "everything at once" store: expired stock, stock expiring today, a dead
     * stock item, a fast seller running out, an overdue debtor, a thin-margin item,
     * one product already on promotion and one out of stock.
     */
    busyStore: {
        name: 'busyStore',
        storeName: 'ร้านสมชายมินิมาร์ท',
        products: [
            { id: 'p1', name: 'นมสดหนองโพ', stock_qty: 40, cost_price: 15, price: 22, low_stock_threshold: 10, unit_type: 'กล่อง' },
            { id: 'p2', name: 'ขนมปังฟาร์มเฮ้าส์', stock_qty: 12, cost_price: 20, price: 28, low_stock_threshold: 5, unit_type: 'ถุง' },
            { id: 'p3', name: 'น้ำดื่มสิงห์ 600ml', stock_qty: 4, cost_price: 5, price: 7, low_stock_threshold: 20, unit_type: 'ขวด' },
            { id: 'p4', name: 'ผงซักฟอกบรีสสูตรเข้มข้น', stock_qty: 35, cost_price: 45, price: 89, low_stock_threshold: 5, unit_type: 'ถุง' },
            { id: 'p5', name: 'มาม่าต้มยำกุ้ง', stock_qty: 0, cost_price: 5, price: 7, low_stock_threshold: 24, unit_type: 'ซอง' },
            { id: 'p6', name: 'โค้กกระป๋อง 325ml', stock_qty: 60, cost_price: 13, price: 15, low_stock_threshold: 12, unit_type: 'กระป๋อง' },
            { id: 'p7', name: 'ไข่ไก่เบอร์ 2', stock_qty: 30, cost_price: 4, price: 5, low_stock_threshold: 30, unit_type: 'ฟอง' }
        ],
        // p1 expired 2 days ago, p2 expires today, p7 expires in 5 days
        batches: [
            { remaining_qty: 18, expire_date: dateOffset(-2), productId: 'p1' },
            { remaining_qty: 12, expire_date: dateOffset(0), productId: 'p2' },
            { remaining_qty: 30, expire_date: dateOffset(5), productId: 'p7' }
        ],
        // p6 already has a live promotion
        activePromoProductIds: ['p6'],
        debts: [
            { name: 'ป้าสมศรี', phone: '0812345678', remaining_amount: 3200, dueOffsetDays: -12 },
            { name: 'ลุงวิรัตน์', phone: '0898765432', remaining_amount: 850, dueOffsetDays: 2 }
        ],
        expenses: [{ amount: 4500 }, { amount: 1200 }],
        orders: [
            order('o1', [
                { id: 'p3', name: 'น้ำดื่มสิงห์ 600ml', qty: 24, price: 7, cost: 5, unit: 'ขวด' },
                { id: 'p6', name: 'โค้กกระป๋อง 325ml', qty: 12, price: 15, cost: 13, unit: 'กระป๋อง' }
            ]),
            order('o2', [
                { id: 'p3', name: 'น้ำดื่มสิงห์ 600ml', qty: 30, price: 7, cost: 5, unit: 'ขวด' },
                { id: 'p6', name: 'โค้กกระป๋อง 325ml', qty: 20, price: 15, cost: 13, unit: 'กระป๋อง' }
            ], { createdDaysAgo: 6 }),
            order('o3', [
                { id: 'p1', name: 'นมสดหนองโพ', qty: 6, price: 22, cost: 15, unit: 'กล่อง' },
                { id: 'p2', name: 'ขนมปังฟาร์มเฮ้าส์', qty: 6, price: 28, cost: 20, unit: 'ถุง' }
            ], { createdDaysAgo: 1 }),
            order('o4', [
                { id: 'p3', name: 'น้ำดื่มสิงห์ 600ml', qty: 20, price: 7, cost: 5, unit: 'ขวด' }
            ], { createdDaysAgo: 10, payment_type: 'credit_sale' })
        ]
    },

    /** A calm store: nothing expiring, no debt, healthy stock. Tests "no urgency" behaviour. */
    calmStore: {
        name: 'calmStore',
        storeName: 'ร้านลุงหมีของชำ',
        products: [
            { id: 'q1', name: 'ข้าวสารหอมมะลิ 5 กก.', stock_qty: 40, cost_price: 150, price: 199, low_stock_threshold: 5, unit_type: 'ถุง' },
            { id: 'q2', name: 'น้ำมันพืชองุ่น 1 ลิตร', stock_qty: 50, cost_price: 42, price: 52, low_stock_threshold: 10, unit_type: 'ขวด' },
            { id: 'q3', name: 'ปลากระป๋องสามแม่ครัว', stock_qty: 80, cost_price: 12, price: 14, low_stock_threshold: 20, unit_type: 'กระป๋อง' },
            { id: 'q4', name: 'ซอสหอยนางรมแม่ครัว', stock_qty: 25, cost_price: 35, price: 60, low_stock_threshold: 5, unit_type: 'ขวด' }
        ],
        batches: [],
        activePromoProductIds: [],
        debts: [],
        expenses: [{ amount: 800 }],
        orders: [
            order('c1', [
                { id: 'q3', name: 'ปลากระป๋องสามแม่ครัว', qty: 20, price: 14, cost: 12, unit: 'กระป๋อง' },
                { id: 'q2', name: 'น้ำมันพืชองุ่น 1 ลิตร', qty: 4, price: 52, cost: 42, unit: 'ขวด' }
            ]),
            order('c2', [
                { id: 'q3', name: 'ปลากระป๋องสามแม่ครัว', qty: 18, price: 14, cost: 12, unit: 'กระป๋อง' }
            ], { createdDaysAgo: 8 })
        ]
    },

    /**
     * A trap store: almost every product is either out of stock or already on
     * promotion, so a careless model will violate the "no promo for zero stock /
     * already promoted" rules.
     */
    trapStore: {
        name: 'trapStore',
        storeName: 'ร้านป้าแดงมินิมาร์ท',
        products: [
            { id: 't1', name: 'เป๊ปซี่ขวดใหญ่', stock_qty: 0, cost_price: 18, price: 25, low_stock_threshold: 10, unit_type: 'ขวด' },
            { id: 't2', name: 'ลูกอมฮอลล์รสมิ้นต์', stock_qty: 0, cost_price: 8, price: 12, low_stock_threshold: 10, unit_type: 'ห่อ' },
            { id: 't3', name: 'ยาสีฟันคอลเกต', stock_qty: 30, cost_price: 40, price: 55, low_stock_threshold: 5, unit_type: 'หลอด' },
            { id: 't4', name: 'แชมพูซันซิล', stock_qty: 22, cost_price: 60, price: 79, low_stock_threshold: 5, unit_type: 'ขวด' },
            { id: 't5', name: 'ทิชชู่สก๊อตต์', stock_qty: 18, cost_price: 55, price: 62, low_stock_threshold: 5, unit_type: 'แพ็ค' }
        ],
        batches: [],
        activePromoProductIds: ['t3', 't4'],
        debts: [{ name: 'เจ๊หมวย', phone: '0811111111', remaining_amount: 1500, dueOffsetDays: -3 }],
        expenses: [],
        orders: [
            order('t-o1', [
                { id: 't1', name: 'เป๊ปซี่ขวดใหญ่', qty: 20, price: 25, cost: 18, unit: 'ขวด' },
                { id: 't2', name: 'ลูกอมฮอลล์รสมิ้นต์', qty: 15, price: 12, cost: 8, unit: 'ห่อ' }
            ])
        ]
    }
};

/**
 * Names that contain one another. The server used to resolve these with a plain
 * substring sweep, so "นมสด" could attach to three different rows and the card would
 * quote the wrong price.
 */
scenarios.collisionStore = {
    name: 'collisionStore',
    storeName: 'ร้านชื่อชนกัน',
    products: [
        { id: 'x1', name: 'นม', stock_qty: 30, cost_price: 10, price: 12, low_stock_threshold: 5, unit_type: 'กล่อง' },
        { id: 'x2', name: 'นมสด', stock_qty: 25, cost_price: 15, price: 18, low_stock_threshold: 5, unit_type: 'กล่อง' },
        { id: 'x3', name: 'นมสดพาสเจอร์ไรส์รสจืด', stock_qty: 40, cost_price: 22, price: 27, low_stock_threshold: 5, unit_type: 'ขวด' },
        { id: 'x4', name: 'นมเปรี้ยว', stock_qty: 0, cost_price: 9, price: 11, low_stock_threshold: 10, unit_type: 'ขวด' },
        { id: 'x5', name: 'ขนมปัง', stock_qty: 15, cost_price: 20, price: 25, low_stock_threshold: 5, unit_type: 'ถุง' },
        { id: 'x6', name: 'ขนมปังไส้สังขยา', stock_qty: 12, cost_price: 12, price: 15, low_stock_threshold: 5, unit_type: 'ชิ้น' }
    ],
    batches: [{ remaining_qty: 10, expire_date: dateOffset(3), productId: 'x2' }],
    activePromoProductIds: [],
    debts: [],
    expenses: [{ amount: 500 }],
    orders: [
        order('x-o1', [
            { id: 'x2', name: 'นมสด', qty: 20, price: 18, cost: 15, unit: 'กล่อง' },
            { id: 'x5', name: 'ขนมปัง', qty: 18, price: 25, cost: 20, unit: 'ถุง' }
        ]),
        order('x-o2', [
            { id: 'x3', name: 'นมสดพาสเจอร์ไรส์รสจืด', qty: 12, price: 27, cost: 22, unit: 'ขวด' }
        ], { createdDaysAgo: 9 })
    ]
};

/** A 100-SKU store: does the model still follow the rules with a long context? */
const bigCatalogue = [];
const CATEGORIES = ['น้ำดื่ม', 'ขนม', 'ผงซักฟอก', 'สบู่', 'ยาสีฟัน', 'บะหมี่', 'กาแฟ', 'ชา', 'นม', 'ซอส'];
for (let i = 0; i < 100; i++) {
    const cost = 8 + (i % 40);
    bigCatalogue.push({
        id: `big-${i}`,
        name: `${CATEGORIES[i % CATEGORIES.length]}ยี่ห้อ ${String.fromCharCode(65 + (i % 26))}${Math.floor(i / 26) + 1}`,
        stock_qty: i % 7 === 0 ? 0 : 5 + (i % 50),
        cost_price: cost,
        price: Math.round(cost * (i % 5 === 0 ? 1.08 : 1.35)),
        low_stock_threshold: 5,
        unit_type: 'ชิ้น'
    });
}

scenarios.bigStore = {
    name: 'bigStore',
    storeName: 'ร้านใหญ่ 100 รายการ',
    products: bigCatalogue,
    batches: [
        { remaining_qty: 6, expire_date: dateOffset(-1), productId: 'big-3' },
        { remaining_qty: 9, expire_date: dateOffset(0), productId: 'big-11' },
        { remaining_qty: 14, expire_date: dateOffset(4), productId: 'big-42' }
    ],
    activePromoProductIds: ['big-5', 'big-6'],
    debts: [{ name: 'เสี่ยหลี', phone: '0800000000', remaining_amount: 9800, dueOffsetDays: -20 }],
    expenses: [{ amount: 12000 }],
    orders: [
        order('big-o1', bigCatalogue.slice(20, 26).map((p) => ({
            id: p.id, name: p.name, qty: 12, price: p.price, cost: p.cost_price, unit: p.unit_type
        }))),
        order('big-o2', bigCatalogue.slice(30, 34).map((p) => ({
            id: p.id, name: p.name, qty: 8, price: p.price, cost: p.cost_price, unit: p.unit_type
        })), { createdDaysAgo: 12 })
    ]
};

module.exports = { scenarios, STORE_ID, dateOffset };
