const { body, param, query, validationResult } = require('express-validator');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: errors.array()[0].msg,
        details: errors.array(),
      },
    });
  }
  next();
};

const registerValidation = [
  body('email').isEmail().withMessage('Valid email is required'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  body('name').notEmpty().withMessage('Name is required'),
  body('employee_id').notEmpty().withMessage('Employee ID is required'),
  body('role').optional().isIn(['employee', 'admin']).withMessage('Invalid role'),
  validate,
];

const loginValidation = [
  body('email').isEmail().withMessage('Valid email is required'),
  body('password').notEmpty().withMessage('Password is required'),
  validate,
];

const checkInValidation = [
  body('location').optional().isObject().withMessage('Location must be an object'),
  validate,
];

const activityHeartbeatValidation = [
  body('is_active').isBoolean().withMessage('is_active must be a boolean'),
  body('active_window').optional().isString(),
  body('active_application').optional().isString(),
  body('mouse_clicks').optional().isInt({ min: 0 }),
  body('keyboard_strokes').optional().isInt({ min: 0 }),
  validate,
];

const dateQueryValidation = [
  query('date').optional().isISO8601().withMessage('Invalid date format'),
  validate,
];

module.exports = {
  validate,
  registerValidation,
  loginValidation,
  checkInValidation,
  activityHeartbeatValidation,
  dateQueryValidation,
};
