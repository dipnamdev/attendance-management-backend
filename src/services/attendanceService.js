const pool = require('../config/database');
const { redisClient } = require('../config/redis');
const { calculateDuration, formatDate } = require('../utils/helpers');
const logger = require('../utils/logger');

class AttendanceService {
  async checkIn(userId, ipAddress, location = null) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const today = formatDate(new Date());
      
      const existingAttendance = await client.query(
        'SELECT * FROM attendance_records WHERE user_id = $1 AND date = $2',
        [userId, today]
      );

      if (existingAttendance.rows.length > 0) {
        await client.query('ROLLBACK');
        return { error: 'ALREADY_CHECKED_IN', message: 'You have already checked in today' };
      }

      const attendanceResult = await client.query(
        `INSERT INTO attendance_records 
         (user_id, date, check_in_time, check_in_ip, check_in_location) 
         VALUES ($1, $2, NOW(), $3, $4) 
         RETURNING *`,
        [userId, today, ipAddress, location ? JSON.stringify(location) : null]
      );

      const attendance = attendanceResult.rows[0];

      await client.query(
        `INSERT INTO activity_logs (user_id, attendance_record_id, activity_type, start_time) 
         VALUES ($1, $2, 'active', NOW())`,
        [userId, attendance.id]
      );

      await redisClient.set(`user:${userId}:attendance`, JSON.stringify(attendance), {
        EX: 86400,
      });

      await client.query('COMMIT');

      logger.info(`User ${userId} checked in at ${attendance.check_in_time}`);
      return { attendance };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Check-in error:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  async checkOut(userId, ipAddress, location = null) {
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
        return { error: 'NOT_CHECKED_IN', message: 'You have not checked in today' };
      }

      const attendance = attendanceResult.rows[0];

      if (attendance.check_out_time) {
        await client.query('ROLLBACK');
        return { error: 'ALREADY_CHECKED_OUT', message: 'You have already checked out today' };
      }

      await client.query(
        `UPDATE activity_logs 
         SET end_time = NOW(), duration = EXTRACT(EPOCH FROM (NOW() - start_time))::INTEGER
         WHERE user_id = $1 AND attendance_record_id = $2 AND end_time IS NULL`,
        [userId, attendance.id]
      );

      await client.query(
        `UPDATE lunch_breaks 
         SET break_end_time = NOW(), duration = EXTRACT(EPOCH FROM (NOW() - break_start_time))::INTEGER
         WHERE user_id = $1 AND attendance_record_id = $2 AND break_end_time IS NULL`,
        [userId, attendance.id]
      );

      const activityStats = await client.query(
        `SELECT 
           COALESCE(SUM(CASE WHEN activity_type = 'active' THEN duration ELSE 0 END), 0) as total_active,
           COALESCE(SUM(CASE WHEN activity_type = 'idle' THEN duration ELSE 0 END), 0) as total_idle
         FROM activity_logs 
         WHERE attendance_record_id = $1`,
        [attendance.id]
      );

      const breakStats = await client.query(
        `SELECT COALESCE(SUM(duration), 0) as total_break 
         FROM lunch_breaks 
         WHERE attendance_record_id = $1`,
        [attendance.id]
      );

      const totalWork = calculateDuration(attendance.check_in_time, new Date());
      const totalActive = parseInt(activityStats.rows[0].total_active) || 0;
      const totalIdle = parseInt(activityStats.rows[0].total_idle) || 0;
      const totalBreak = parseInt(breakStats.rows[0].total_break) || 0;

      const updatedAttendance = await client.query(
        `UPDATE attendance_records 
         SET check_out_time = NOW(), 
             check_out_ip = $1, 
             check_out_location = $2,
             total_work_duration = $3,
             total_active_duration = $4,
             total_idle_duration = $5,
             total_break_duration = $6,
             updated_at = NOW()
         WHERE id = $7 
         RETURNING *`,
        [ipAddress, location ? JSON.stringify(location) : null, totalWork, totalActive, totalIdle, totalBreak, attendance.id]
      );

      await redisClient.del(`user:${userId}:attendance`);
      await redisClient.del(`user:${userId}:current_activity`);

      await client.query('COMMIT');

      logger.info(`User ${userId} checked out at ${updatedAttendance.rows[0].check_out_time}`);
      return { attendance: updatedAttendance.rows[0] };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Check-out error:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  async getTodayAttendance(userId) {
    const today = formatDate(new Date());
    const result = await pool.query(
      'SELECT * FROM attendance_records WHERE user_id = $1 AND date = $2',
      [userId, today]
    );
    return result.rows[0] || null;
  }

  async getAttendanceHistory(userId, startDate, endDate) {
    const query = `
      SELECT * FROM attendance_records 
      WHERE user_id = $1 
      ${startDate ? 'AND date >= $2' : ''} 
      ${endDate ? `AND date <= $${startDate ? 3 : 2}` : ''}
      ORDER BY date DESC
    `;
    
    const params = [userId];
    if (startDate) params.push(startDate);
    if (endDate) params.push(endDate);

    const result = await pool.query(query, params);
    return result.rows;
  }

  async updateNotes(attendanceId, userId, notes, isAdmin) {
    const query = isAdmin 
      ? 'UPDATE attendance_records SET notes = $1, updated_at = NOW() WHERE id = $2 RETURNING *'
      : 'UPDATE attendance_records SET notes = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3 RETURNING *';
    
    const params = isAdmin ? [notes, attendanceId] : [notes, attendanceId, userId];
    const result = await pool.query(query, params);
    
    return result.rows[0] || null;
  }
}

module.exports = new AttendanceService();
