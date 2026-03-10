const { body, validationResult } = require('express-validator');

// Reusable error handling middleware
const validate = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({
            success: false,
            error: 'Validation Error',
            details: errors.array()
        });
    }
    next();
};

const productValidators = [
    body('name').trim().notEmpty().withMessage('Product name is required')
        .isLength({ max: 100 }).withMessage('Name too long'),
    body('quantity').isFloat({ min: 0 }).withMessage('Quantity must be a positive number'),
    body('costPrice').isFloat({ min: 0 }).withMessage('Cost price must be positive'),
    body('salePrice').isFloat({ min: 0 }).withMessage('Sale price must be positive'),
    body('lowStockThreshold').optional().isFloat({ min: 0 }),
    validate
];

const categoryValidators = [
    body('name').trim().notEmpty().withMessage('Category name is required')
        .isLength({ max: 50 }).withMessage('Name too long')
        .matches(/^[a-zA-Z0-9ก-๙\s]+$/).withMessage('Name contains invalid characters'), // Thai & Eng only
    validate
];

const creditPaymentValidators = [
    body('customer_id').isString().notEmpty().withMessage('Customer ID required'), // Assuming UUID or String ID
    body('amount').isFloat({ gt: 0 }).withMessage('Amount must be greater than 0'),
    body('payment_method').isIn(['cash', 'transfer', 'qr', 'qr_promptpay']).withMessage('Invalid payment method'),
    validate
];

module.exports = {
    productValidators,
    categoryValidators,
    creditPaymentValidators
};
