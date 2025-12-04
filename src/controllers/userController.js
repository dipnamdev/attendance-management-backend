const bcrypt = require('bcrypt');
const pool = require('../config/database');
const { successResponse, errorResponse } = require('../utils/helpers');
const logger = require('../utils/logger');

const getAllUsers = async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, email, name, employee_id, role, status, profile_picture_url, created_at 
       FROM users 
       ORDER BY created_at DESC`
    );

    return successResponse(res, { users: result.rows, count: result.rows.length });
  } catch (error) {
    logger.error('Get all users error:', error);
    next(error);
  }
};

const createUser = async (req, res, next) => {
  try {
    const { email, password, name, employee_id, role = 'employee' } = req.body;

    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users (email, password_hash, name, employee_id, role) 
       VALUES ($1, $2, $3, $4, $5) 
       RETURNING id, email, name, employee_id, role, status, created_at`,
      [email, hashedPassword, name, employee_id, role]
    );

    logger.info(`User created by admin: ${email}`);
    return successResponse(res, { user: result.rows[0] }, 'User created successfully', 201);
  } catch (error) {
    logger.error('Create user error:', error);
    const fs = require('fs');
    const path = require('path');
    fs.appendFileSync(path.join(__dirname, '../../logs/error.log'), `${new Date().toISOString()} - ${error.message}\n${error.stack}\n\n`);
    next(error);
  }
};

const getUserById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `SELECT id, email, name, employee_id, role, status, profile_picture_url, created_at 
       FROM users WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return errorResponse(res, 'USER_NOT_FOUND', 'User not found', 404);
    }

    return successResponse(res, { user: result.rows[0] });
  } catch (error) {
    logger.error('Get user by ID error:', error);
    next(error);
  }
};

const updateUser = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, role, status, profile_picture_url } = req.body;

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (name) {
      updates.push(`name = $${paramCount++}`);
      values.push(name);
    }
    if (role) {
      updates.push(`role = $${paramCount++}`);
      values.push(role);
    }
    if (status) {
      updates.push(`status = $${paramCount++}`);
      values.push(status);
    }
    if (profile_picture_url !== undefined) {
      updates.push(`profile_picture_url = $${paramCount++}`);
      values.push(profile_picture_url);
    }

    if (updates.length === 0) {
      return errorResponse(res, 'NO_UPDATES', 'No fields to update', 400);
    }

    updates.push(`updated_at = NOW()`);
    values.push(id);

    const query = `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramCount} 
                   RETURNING id, email, name, employee_id, role, status, profile_picture_url, updated_at`;

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return errorResponse(res, 'USER_NOT_FOUND', 'User not found', 404);
    }

    logger.info(`User updated: ${id}`);
    return successResponse(res, { user: result.rows[0] }, 'User updated successfully');
  } catch (error) {
    logger.error('Update user error:', error);
    next(error);
  }
};

const deleteUser = async (req, res, next) => {
  try {
    const { id } = req.params;

    const result = await pool.query('DELETE FROM users WHERE id = $1 RETURNING id', [id]);

    if (result.rows.length === 0) {
      return errorResponse(res, 'USER_NOT_FOUND', 'User not found', 404);
    }

    logger.info(`User deleted: ${id}`);
    return successResponse(res, null, 'User deleted successfully');
  } catch (error) {
    logger.error('Delete user error:', error);
    next(error);
  }
};

const getUserAttendanceSummary = async (req, res, next) => {
  try {
    const { id } = req.params;

    const summary = await pool.query(
      `SELECT 
         COUNT(*) as total_days,
         SUM(total_work_duration) as total_work_time,
         AVG(total_work_duration) as avg_work_time,
         SUM(total_active_duration) as total_active_time,
         AVG(total_active_duration) as avg_active_time
       FROM attendance_records
       WHERE user_id = $1`,
      [id]
    );

    const recentAttendance = await pool.query(
      `SELECT * FROM attendance_records 
       WHERE user_id = $1 
       ORDER BY date DESC 
       LIMIT 10`,
      [id]
    );

    return successResponse(res, {
      summary: summary.rows[0],
      recent_attendance: recentAttendance.rows,
    });
  } catch (error) {
    logger.error('Get user attendance summary error:', error);
    next(error);
  }
};

module.exports = {
  getAllUsers,
  createUser,
  getUserById,
  updateUser,
  deleteUser,
  getUserAttendanceSummary,
};
