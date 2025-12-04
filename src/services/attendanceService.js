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
        'SELECT * FROM attendance_records WHERE user_id = $1 AND date::date = $2::date',
        [userId, today]
      );

      let attendance;

      if (existingAttendance.rows.length > 0) {
        const existing = existingAttendance.rows[0];

        // If already checked in and not checked out, return error
        if (existing.check_in_time && !existing.check_out_time) {
          await client.query('ROLLBACK');
          return { error: 'ALREADY_CHECKED_IN', message: 'You are already marked in' };
        }

        // If checked out, allow re-check-in by updating the record
        if (existing.check_out_time) {
          // Close any open lunch breaks that might have been missed
          await client.query(
            `UPDATE lunch_breaks 
             SET break_end_time = NOW(), duration = EXTRACT(EPOCH FROM (NOW() - break_start_time))::INTEGER
             WHERE user_id = $1 AND attendance_record_id = $2 AND break_end_time IS NULL`,
            [userId, existing.id]
          );

          const updateResult = await client.query(
            `UPDATE attendance_records 
             SET check_out_time = NULL,
                 check_out_ip = NULL,
                 check_out_location = NULL,
                 total_work_duration = NULL,
                 total_active_duration = NULL,
                 total_idle_duration = NULL,
                 total_break_duration = NULL,
                 updated_at = NOW()
             WHERE id = $1
             RETURNING *`,
            [existing.id]
          );
          attendance = updateResult.rows[0];
          logger.info(`User ${userId} re-checked in after marking out`);
        }
        // If an attendance row exists but has no check_in_time (pre-created), update it to set check-in
        if (!existing.check_in_time && !existing.check_out_time) {
          const updated = await client.query(
            `UPDATE attendance_records
             SET check_in_time = NOW(), check_in_ip = $1, check_in_location = $2, updated_at = NOW()
             WHERE id = $3
             RETURNING *`,
            [ipAddress, location ? JSON.stringify(location) : null, existing.id]
          );
          attendance = updated.rows[0];
          logger.info(`User ${userId} checked in (pre-created record) at ${attendance.check_in_time}`);
        }
      } else {
        // No existing record, create new one
        const attendanceResult = await client.query(
          `INSERT INTO attendance_records 
           (user_id, date, check_in_time, check_in_ip, check_in_location) 
           VALUES ($1, $2, NOW(), $3, $4) 
           RETURNING *`,
          [userId, today, ipAddress, location ? JSON.stringify(location) : null]
        );
        attendance = attendanceResult.rows[0];
      }

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
        'SELECT * FROM attendance_records WHERE user_id = $1 AND date::date = $2::date',
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

      // Close all open activity logs and calculate their durations
      const closedActivities = await client.query(
        `UPDATE activity_logs 
         SET end_time = NOW(), duration = EXTRACT(EPOCH FROM (NOW() - start_time))::INTEGER
         WHERE user_id = $1 AND attendance_record_id = $2 AND end_time IS NULL
         RETURNING id, activity_type, duration`,
        [userId, attendance.id]
      );

      logger.info(`Closed ${closedActivities.rows.length} open activities for user ${userId}`);
      if (closedActivities.rows.length > 0) {
        logger.debug('Closed activities:', closedActivities.rows);
      }

      // Close all open lunch breaks and calculate their durations
      const closedBreaks = await client.query(
        `UPDATE lunch_breaks 
         SET break_end_time = NOW(), duration = EXTRACT(EPOCH FROM (NOW() - break_start_time))::INTEGER
         WHERE user_id = $1 AND attendance_record_id = $2 AND break_end_time IS NULL
         RETURNING id, duration`,
        [userId, attendance.id]
      );

      logger.info(`Closed ${closedBreaks.rows.length} open lunch breaks for user ${userId}`);
      if (closedBreaks.rows.length > 0) {
        logger.debug('Closed breaks:', closedBreaks.rows);
      }

      // Now sum up all the durations (all activities should now have durations calculated)
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

      const totalActive = parseInt(activityStats.rows[0].total_active) || 0;
      const totalIdle = parseInt(activityStats.rows[0].total_idle) || 0;
      const totalBreak = parseInt(breakStats.rows[0].total_break) || 0;

      // Calculate total work time: (check-in to check-out) minus breaks
      const totalElapsed = calculateDuration(attendance.check_in_time, new Date());
      const totalWork = totalElapsed - totalBreak;

      logger.info(`Duration calculations for user ${userId}: elapsed=${totalElapsed}s, work=${totalWork}s, active=${totalActive}s, idle=${totalIdle}s, break=${totalBreak}s`);

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
      'SELECT * FROM attendance_records WHERE user_id = $1 AND date::date = $2::date',
      [userId, today]
    );

    const attendance = result.rows[0];
    if (!attendance) return null;

    // Calculate real-time stats
    const activityStats = await pool.query(
      `SELECT 
         activity_type,
         start_time,
         end_time,
         duration
       FROM activity_logs 
       WHERE attendance_record_id = $1`,
      [attendance.id]
    );

    const breakStats = await pool.query(
      `SELECT 
         break_start_time as start_time,
         break_end_time as end_time,
         duration
       FROM lunch_breaks 
       WHERE attendance_record_id = $1`,
      [attendance.id]
    );

    let totalActive = 0;
    let totalIdle = 0;
    let totalBreak = 0;
    const now = new Date();

    // Calculate active/idle time
    activityStats.rows.forEach(log => {
      let duration = log.duration || 0;
      if (!log.end_time && log.start_time) {
        duration = Math.floor((now - new Date(log.start_time)) / 1000);
      }

      if (log.activity_type === 'active') {
        totalActive += duration;
      } else if (log.activity_type === 'idle') {
        totalIdle += duration;
      }
    });

    // Calculate break time with safeguards
    const MAX_BREAK_DURATION = 2 * 60 * 60; // 2 hours in seconds
    breakStats.rows.forEach(brk => {
      let duration = brk.duration || 0;
      if (!brk.end_time && brk.start_time) {
        const breakStart = new Date(brk.start_time);
        const breakStartDate = new Date(breakStart.getFullYear(), breakStart.getMonth(), breakStart.getDate());
        const nowDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        // If break started on a different day, cap it at end of that day
        if (breakStartDate.getTime() !== nowDate.getTime()) {
          const endOfDay = new Date(breakStart);
          endOfDay.setHours(23, 59, 59, 999);
          duration = Math.floor((endOfDay - breakStart) / 1000);
          logger.warn(`Break started on different day for attendance ${attendance.id}, capped at end of day: ${duration}s`);
        } else {
          // Calculate duration but cap at maximum
          duration = Math.floor((now - breakStart) / 1000);
          if (duration > MAX_BREAK_DURATION) {
            logger.warn(`Ongoing break duration (${duration}s) exceeds maximum (${MAX_BREAK_DURATION}s), capping it`);
            duration = MAX_BREAK_DURATION;
          }
        }
      }
      totalBreak += duration;
    });

    // Calculate total work time (Check-in to Now/Check-out minus Breaks)
    let totalWork = 0;
    if (attendance.check_in_time) {
      const endTime = attendance.check_out_time ? new Date(attendance.check_out_time) : now;
      const totalElapsed = Math.floor((endTime - new Date(attendance.check_in_time)) / 1000);
      totalWork = totalElapsed - totalBreak;
    }

    return {
      ...attendance,
      total_time: totalWork > 0 ? totalWork : 0,
      active_time: totalActive,
      idle_time: totalIdle,
      break_time: totalBreak
    };
  }

  async getAttendanceHistory(userId, startDate, endDate) {
    const query = `
      SELECT * FROM attendance_records 
      WHERE user_id = $1 
      ${startDate ? 'AND date::date >= $2::date' : ''} 
      ${endDate ? `AND date::date <= $${startDate ? 3 : 2}::date` : ''}
      ORDER BY date DESC
    `;

    const params = [userId];
    if (startDate) params.push(startDate);
    if (endDate) params.push(endDate);

    const result = await pool.query(query, params);

    // For each record, if it's not checked out yet, calculate real-time durations
    const enrichedRecords = await Promise.all(result.rows.map(async (record) => {
      // If already checked out, return as-is (durations are already stored)
      if (record.check_out_time) {
        return record;
      }

      /**
       * For records without a checkout time we calculate durations in "real time".
       * However, if the record date is in the past (before today) we should NOT
       * keep accumulating time indefinitely. In those cases we cap the end time
       * at that record's end-of-day (23:59:59), which effectively simulates an
       * automatic checkout at the end of the working day.
       */
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const recordDateObj = new Date(record.date);
      const recordDateOnly = new Date(
        recordDateObj.getFullYear(),
        recordDateObj.getMonth(),
        recordDateObj.getDate()
      );

      let effectiveEndTime = now;
      if (recordDateOnly.getTime() < today.getTime()) {
        // Past day with missing checkout – cap at 23:59:59 of that date
        effectiveEndTime = new Date(recordDateOnly);
        effectiveEndTime.setHours(23, 59, 59, 999);
      }

      // Get activity logs
      const activityStats = await pool.query(
        `SELECT 
           activity_type,
           start_time,
           end_time,
           duration
         FROM activity_logs 
         WHERE attendance_record_id = $1`,
        [record.id]
      );

      // Get lunch breaks
      const breakStats = await pool.query(
        `SELECT 
           break_start_time as start_time,
           break_end_time as end_time,
           duration
         FROM lunch_breaks 
         WHERE attendance_record_id = $1`,
        [record.id]
      );

      let totalActive = 0;
      let totalIdle = 0;
      let totalBreak = 0;

      // Calculate active/idle time (including ongoing activities)
      activityStats.rows.forEach(log => {
        let duration = log.duration || 0;
        if (!log.end_time && log.start_time) {
          duration = Math.floor((effectiveEndTime - new Date(log.start_time)) / 1000);
        }

        if (log.activity_type === 'active') {
          totalActive += duration;
        } else if (log.activity_type === 'idle') {
          totalIdle += duration;
        }
      });

      // Calculate break time with safeguards (same as getTodayAttendance)
      const MAX_BREAK_DURATION = 2 * 60 * 60; // 2 hours in seconds
      breakStats.rows.forEach(brk => {
        let duration = brk.duration || 0;
        if (!brk.end_time && brk.start_time) {
          const breakStart = new Date(brk.start_time);
          const breakStartDate = new Date(breakStart.getFullYear(), breakStart.getMonth(), breakStart.getDate());
          const effectiveEndDate = new Date(
            effectiveEndTime.getFullYear(),
            effectiveEndTime.getMonth(),
            effectiveEndTime.getDate()
          );

          // If break started on a different day than our effective end time, cap it at that day's end
          if (breakStartDate.getTime() !== effectiveEndDate.getTime()) {
            const endOfDay = new Date(breakStart);
            endOfDay.setHours(23, 59, 59, 999);
            duration = Math.floor((endOfDay - breakStart) / 1000);
            logger.warn(`Break started on different day for record ${record.id}, capped at end of day: ${duration}s`);
          } else {
            // Calculate duration but cap at maximum
            duration = Math.floor((effectiveEndTime - breakStart) / 1000);
            if (duration > MAX_BREAK_DURATION) {
              logger.warn(`Ongoing break duration (${duration}s) exceeds maximum (${MAX_BREAK_DURATION}s), capping it`);
              duration = MAX_BREAK_DURATION;
            }
          }
        }
        totalBreak += duration;
      });

      // Calculate total work time: (check-in to effective end) minus breaks
      const totalElapsed = Math.floor((effectiveEndTime - new Date(record.check_in_time)) / 1000);
      const totalWork = totalElapsed - totalBreak;

      // Return record with calculated real-time durations
      return {
        ...record,
        total_work_duration: totalWork > 0 ? totalWork : 0,
        total_active_duration: totalActive,
        total_idle_duration: totalIdle,
        total_break_duration: totalBreak
      };
    }));

    return enrichedRecords;
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
