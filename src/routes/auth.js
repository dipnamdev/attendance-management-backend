const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authenticateToken } = require('../middleware/auth');
const { registerValidation, loginValidation } = require('../utils/validators');
const rateLimit = require('express-rate-limit');

// const loginLimiter = rateLimit({
//   windowMs: 15 * 60 * 1000,
//   max: 5,
//   message: {
//     success: false,
//     error: {
//       code: 'TOO_MANY_REQUESTS',
//       message: 'Too many login attempts, please try again later',
//     },
//   },
// });

// // In development, skip rate limiting to avoid 429s while testing
// const isProduction = process.env.NODE_ENV === 'production';
const loginMiddlewares = [loginValidation];

router.post('/register', registerValidation, authController.register);
router.post('/login', ...loginMiddlewares, authController.login);
router.post('/logout', authenticateToken, authController.logout);
router.post('/refresh-token', authenticateToken, authController.refreshToken);
router.get('/me', authenticateToken, authController.getMe);

module.exports = router;
