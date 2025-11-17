const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../config/database');
const { successResponse, errorResponse } = require('../utils/helpers');
const logger = require('../utils/logger');

const register = async (req, res, next) => {
  try {
    const { email, password, name, employee_id, role = 'employee' } = req.body;

    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users (email, password_hash, name, employee_id, role) 
       VALUES ($1, $2, $3, $4, $5) 
       RETURNING id, email, name, employee_id, role, status, created_at`,
      [email, hashedPassword, name, employee_id, role]
    );

    const user = result.rows[0];
    logger.info(`New user registered: ${email}`);

    return successResponse(res, { user }, 'User registered successfully', 201);
  } catch (error) {
    logger.error('Registration error:', error);
    next(error);
  }
};

const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    const result = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return errorResponse(res, 'INVALID_CREDENTIALS', 'Invalid email or password', 401);
    }

    const user = result.rows[0];

    if (user.status !== 'active') {
      return errorResponse(res, 'ACCOUNT_INACTIVE', 'Your account is inactive', 403);
    }

    const isValidPassword = await bcrypt.compare(password, user.password_hash);

    if (!isValidPassword) {
      return errorResponse(res, 'INVALID_CREDENTIALS', 'Invalid email or password', 401);
    }

    const token = jwt.sign(
      { 
        id: user.id, 
        email: user.email, 
        role: user.role,
        employee_id: user.employee_id 
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRY || '24h' }
    );

    const userData = {
      id: user.id,
      email: user.email,
      name: user.name,
      employee_id: user.employee_id,
      role: user.role,
      profile_picture_url: user.profile_picture_url,
    };

    logger.info(`User logged in: ${email}`);

    return successResponse(res, { user: userData, token }, 'Login successful');
  } catch (error) {
    logger.error('Login error:', error);
    next(error);
  }
};

const logout = async (req, res) => {
  logger.info(`User logged out: ${req.user.email}`);
  return successResponse(res, null, 'Logout successful');
};

const refreshToken = async (req, res, next) => {
  try {
    const newToken = jwt.sign(
      { 
        id: req.user.id, 
        email: req.user.email, 
        role: req.user.role,
        employee_id: req.user.employee_id 
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRY || '24h' }
    );

    return successResponse(res, { token: newToken }, 'Token refreshed successfully');
  } catch (error) {
    logger.error('Token refresh error:', error);
    next(error);
  }
};

const getMe = async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, email, name, employee_id, role, profile_picture_url, status, created_at 
       FROM users WHERE id = $1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return errorResponse(res, 'USER_NOT_FOUND', 'User not found', 404);
    }

    return successResponse(res, { user: result.rows[0] });
  } catch (error) {
    logger.error('Get me error:', error);
    next(error);
  }
};

module.exports = {
  register,
  login,
  logout,
  refreshToken,
  getMe,
};
