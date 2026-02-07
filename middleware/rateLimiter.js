const rateLimit = require('express-rate-limit');

const limiter = rateLimit({
    windowMs: 2 * 60 * 1000, // 2 minutes
    max: 100, // Limit each IP to 10000 requests per windowMs
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    message: {
        success: false,
        error: "Too many requests from this IP, please try again after 15 minutes",
    },
});

module.exports = limiter;
