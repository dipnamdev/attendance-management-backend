const pool = require('../config/database');
const { redisClient } = require('../config/redis');
const { formatDate } = require('../utils/helpers');
const logger = require('../utils/logger');

const IDLE_THRESHOLD = 300;

class ActivityService {
  async processHeartbeat(userId, activityData) {
    const { is_active, active_window, active_application, url, mouse_clicks = 0, keyboard_strokes = 0 } = activityData;
    
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const today = formatDate(new Date());
      const attendanceResult = await client.query(
        'SELECT * FROM attendance_records WHERE user_id = $1 AND date = $2',
        [userId, today]
      );

      if (attendanceResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return { error: 'NOT_CHECKED_IN', message: 'Please check in first' };
      }

      const attendance = attendanceResult.rows[0];

      if (attendance.check_out_time) {
        await client.query('ROLLBACK');
        return { error: 'ALREADY_CHECKED_OUT', message: 'You have already checked out' };
      }

      await client.query(
        `INSERT INTO user_activity_tracking 
         (user_id, attendance_record_id, timestamp, active_window_title, active_application, url, 
          mouse_clicks, keyboard_strokes, is_active, idle_time_seconds) 
         VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7, $8, $9)`,
        [userId, attendance.id, active_window, active_application, url, mouse_clicks, keyboard_strokes, is_active, is_active ? 0 : 30]
      );

      const cachedActivity = await redisClient.get(`user:${userId}:last_activity`);
      const now = Date.now();
      
      if (cachedActivity) {
        const lastActivity = JSON.parse(cachedActivity);
        const timeSinceLastActivity = (now - lastActivity.timestamp) / 1000;

        if (timeSinceLastActivity >= IDLE_THRESHOLD && lastActivity.is_active && !is_active) {
          await client.query(
            `UPDATE activity_logs 
             SET end_time = NOW() - INTERVAL '${IDLE_THRESHOLD} seconds', 
                 duration = EXTRACT(EPOCH FROM (NOW() - INTERVAL '${IDLE_THRESHOLD} seconds' - start_time))::INTEGER
             WHERE user_id = $1 AND attendance_record_id = $2 AND end_time IS NULL AND activity_type = 'active'`,
            [userId, attendance.id]
          );

          await client.query(
            `INSERT INTO activity_logs (user_id, attendance_record_id, activity_type, start_time) 
             VALUES ($1, $2, 'idle', NOW() - INTERVAL '${IDLE_THRESHOLD} seconds')`,
            [userId, attendance.id]
          );
        } else if (lastActivity.is_active === false && is_active) {
          await client.query(
            `UPDATE activity_logs 
             SET end_time = NOW(), duration = EXTRACT(EPOCH FROM (NOW() - start_time))::INTEGER
             WHERE user_id = $1 AND attendance_record_id = $2 AND end_time IS NULL AND activity_type = 'idle'`,
            [userId, attendance.id]
          );

          await client.query(
            `INSERT INTO activity_logs (user_id, attendance_record_id, activity_type, start_time) 
             VALUES ($1, $2, 'active', NOW())`,
            [userId, attendance.id]
          );
        }
      }

      await redisClient.set(
        `user:${userId}:last_activity`,
        JSON.stringify({ is_active, timestamp: now }),
        { EX: 600 }
      );

      await client.query('COMMIT');

      return { success: true };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Heartbeat processing error:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  async getCurrentActivity(userId) {
    const today = formatDate(new Date());
    const result = await pool.query(
      `SELECT al.* 
       FROM activity_logs al
       JOIN attendance_records ar ON al.attendance_record_id = ar.id
       WHERE al.user_id = $1 AND ar.date = $2 AND al.end_time IS NULL
       ORDER BY al.start_time DESC
       LIMIT 1`,
      [userId, today]
    );

    return result.rows[0] || null;
  }

  async getActivityHistory(userId, date) {
    const targetDate = date || formatDate(new Date());
    
    const result = await pool.query(
      `SELECT al.*, ar.date 
       FROM activity_logs al
       JOIN attendance_records ar ON al.attendance_record_id = ar.id
       WHERE al.user_id = $1 AND ar.date = $2
       ORDER BY al.start_time ASC`,
      [userId, targetDate]
    );

    return result.rows;
  }

  async startLunchBreak(userId, location = null) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const today = formatDate(new Date());
      const attendanceResult = await client.query(
        'SELECT * FROM attendance_records WHERE user_id = $1 AND date = $2',
        [userId, today]
      );

      if (attendanceResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return { error: 'NOT_CHECKED_IN', message: 'Please check in first' };
      }

      const attendance = attendanceResult.rows[0];

      const existingBreak = await client.query(
        'SELECT * FROM lunch_breaks WHERE user_id = $1 AND attendance_record_id = $2 AND break_end_time IS NULL',
        [userId, attendance.id]
      );

      if (existingBreak.rows.length > 0) {
        await client.query('ROLLBACK');
        return { error: 'BREAK_ALREADY_STARTED', message: 'Lunch break already in progress' };
      }

      await client.query(
        `UPDATE activity_logs 
         SET end_time = NOW(), duration = EXTRACT(EPOCH FROM (NOW() - start_time))::INTEGER
         WHERE user_id = $1 AND attendance_record_id = $2 AND end_time IS NULL`,
        [userId, attendance.id]
      );

      const breakResult = await client.query(
        `INSERT INTO lunch_breaks (user_id, attendance_record_id, break_start_time, start_location) 
         VALUES ($1, $2, NOW(), $3) 
         RETURNING *`,
        [userId, attendance.id, location ? JSON.stringify(location) : null]
      );

      await client.query(
        `INSERT INTO activity_logs (user_id, attendance_record_id, activity_type, start_time) 
         VALUES ($1, $2, 'lunch_break', NOW())`,
        [userId, attendance.id]
      );

      await client.query('COMMIT');

      logger.info(`User ${userId} started lunch break`);
      return { lunchBreak: breakResult.rows[0] };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Start lunch break error:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  async endLunchBreak(userId, location = null) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const today = formatDate(new Date());
      const attendanceResult = await client.query(
        'SELECT * FROM attendance_records WHERE user_id = $1 AND date = $2',
        [userId, today]
      );

      if (attendanceResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return { error: 'NOT_CHECKED_IN', message: 'No active attendance found' };
      }

      const attendance = attendanceResult.rows[0];

      const breakResult = await client.query(
        'SELECT * FROM lunch_breaks WHERE user_id = $1 AND attendance_record_id = $2 AND break_end_time IS NULL',
        [userId, attendance.id]
      );

      if (breakResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return { error: 'NO_ACTIVE_BREAK', message: 'No active lunch break found' };
      }

      const updatedBreak = await client.query(
        `UPDATE lunch_breaks 
         SET break_end_time = NOW(), 
             end_location = $1,
             duration = EXTRACT(EPOCH FROM (NOW() - break_start_time))::INTEGER,
             updated_at = NOW()
         WHERE id = $2 
         RETURNING *`,
        [location ? JSON.stringify(location) : null, breakResult.rows[0].id]
      );

      await client.query(
        `UPDATE activity_logs 
         SET end_time = NOW(), duration = EXTRACT(EPOCH FROM (NOW() - start_time))::INTEGER
         WHERE user_id = $1 AND attendance_record_id = $2 AND activity_type = 'lunch_break' AND end_time IS NULL`,
        [userId, attendance.id]
      );

      await client.query(
        `INSERT INTO activity_logs (user_id, attendance_record_id, activity_type, start_time) 
         VALUES ($1, $2, 'active', NOW())`,
        [userId, attendance.id]
      );

      await client.query('COMMIT');

      logger.info(`User ${userId} ended lunch break`);
      return { lunchBreak: updatedBreak.rows[0] };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('End lunch break error:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  async getCurrentLunchBreak(userId) {
    const today = formatDate(new Date());
    const result = await pool.query(
      `SELECT lb.* 
       FROM lunch_breaks lb
       JOIN attendance_records ar ON lb.attendance_record_id = ar.id
       WHERE lb.user_id = $1 AND ar.date = $2 AND lb.break_end_time IS NULL
       ORDER BY lb.break_start_time DESC
       LIMIT 1`,
      [userId, today]
    );

    return result.rows[0] || null;
  }
}

module.exports = new ActivityService();
