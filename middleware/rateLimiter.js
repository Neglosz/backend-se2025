const rateLimit = require('express-rate-limit');

const limiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 300, // 300 requests per minute (~5/sec) รองรับการเพิ่มสินค้าแบบต่อเนื่อง
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        error: "Too many requests from this IP, please try again after 1 minute",
    },
});

module.exports = limiter;
