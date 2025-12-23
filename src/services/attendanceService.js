const pool = require('../config/database');
const { redisClient } = require('../config/redis');
const { calculateDuration, formatDate } = require('../utils/helpers');
const logger = require('../utils/logger');
const stateTransitionService = require('./stateTransitionService');

// Helper to enforce invariants and prevent runaway sums
function clampDurations(totalWork, totalActive, totalIdle) {
  const work = Math.max(0, totalWork || 0);
  let active = Math.max(0, totalActive || 0);
  let idle = Math.max(0, totalIdle || 0);

  if (work === 0) {
    return { totalWork: 0, totalActive: 0, totalIdle: 0 };
  }

  const sum = active + idle;
  if (sum > work) {
    const excess = sum - work;
    const newIdle = Math.max(0, idle - excess); // trim idle first
    const remainingExcess = Math.max(0, excess - (idle - newIdle));
    const newActive = Math.max(0, active - remainingExcess);
    return { totalWork: work, totalActive: newActive, totalIdle: newIdle };
  }

  return { totalWork: work, totalActive: active, totalIdle: idle };
}

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
          // Close any open lunch breaks that might have been missed (safety net)
          await client.query(
            `UPDATE lunch_breaks 
             SET break_end_time = NOW(), duration = EXTRACT(EPOCH FROM (NOW() - break_start_time))::INTEGER
             WHERE user_id = $1 AND attendance_record_id = $2 AND break_end_time IS NULL`,
            [userId, existing.id]
          );

          // Calculate gap between last check-out and now
          const nowMs = new Date().getTime();
          const checkOutMs = new Date(existing.check_out_time).getTime();
          const gapSeconds = Math.max(0, Math.floor((nowMs - checkOutMs) / 1000));

          // Log this gap as 'idle' in activity_logs to keep reports consistent
          if (gapSeconds > 0) {
            await client.query(
              `INSERT INTO activity_logs (user_id, attendance_record_id, activity_type, start_time, end_time, duration) 
               VALUES ($1, $2, 'idle', $3, NOW(), $4)`,
              [userId, existing.id, existing.check_out_time, gapSeconds]
            );
            logger.info(`Logged gap of ${gapSeconds}s as idle time for user ${userId} during re-check-in`);
          }

          const updateResult = await client.query(
            `UPDATE attendance_records 
             SET check_out_time = NULL,
                 check_out_ip = NULL,
                 check_out_location = NULL,
                 total_work_duration = NULL,
                 total_active_duration = NULL,
                 total_idle_duration = NULL,
                 total_break_duration = NULL,
                 -- Add gap to existing idle_seconds, PRESERVE other counters
                 idle_seconds = COALESCE(idle_seconds, 0) + $2,
                 current_state = NULL,
                 last_state_change_at = NULL,
                 updated_at = NOW()
             WHERE id = $1
             RETURNING *`,
            [existing.id, gapSeconds]
          );
          attendance = updateResult.rows[0];
          logger.info(`User ${userId} re-checked in. Gap of ${gapSeconds}s added to idle.`);
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

      // Initialize state as WORKING
      attendance = await stateTransitionService.applyStateTransition(
        attendance,
        'WORKING',
        new Date(),
        client
      );

      // Keep activity_logs for audit trail
      await client.query(
        `INSERT INTO activity_logs (user_id, attendance_record_id, activity_type, start_time) 
         VALUES ($1, $2, 'active', NOW())`,
        [userId, attendance.id]
      );

      // Store current state in Redis
      await redisClient.set(`user:${userId}:attendance`, JSON.stringify(attendance), {
        EX: 86400,
      });
      await redisClient.set(`user:${userId}:current_state`, 'WORKING', { EX: 86400 });

      await client.query('COMMIT');

      logger.info(`User ${userId} checked in at ${attendance.check_in_time} with state WORKING`);
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

      let attendance = attendanceResult.rows[0];

      if (attendance.check_out_time) {
        await client.query('ROLLBACK');
        return { error: 'ALREADY_CHECKED_OUT', message: 'You have already checked out today' };
      }

      // Finalize current state and accumulate time
      attendance = await stateTransitionService.finalizeState(attendance, new Date(), client);

      // Close all open activity logs for audit trail
      const closedActivities = await client.query(
        `UPDATE activity_logs 
         SET end_time = NOW(), duration = EXTRACT(EPOCH FROM (NOW() - start_time))::INTEGER
         WHERE user_id = $1 AND attendance_record_id = $2 AND end_time IS NULL
         RETURNING id, activity_type, duration`,
        [userId, attendance.id]
      );

      logger.info(`Closed ${closedActivities.rows.length} open activities for user ${userId}`);

      // Close all open lunch breaks
      const closedBreaks = await client.query(
        `UPDATE lunch_breaks 
         SET break_end_time = NOW(), duration = EXTRACT(EPOCH FROM (NOW() - break_start_time))::INTEGER
         WHERE user_id = $1 AND attendance_record_id = $2 AND break_end_time IS NULL
         RETURNING id, duration`,
        [userId, attendance.id]
      );

      logger.info(`Closed ${closedBreaks.rows.length} open lunch breaks for user ${userId}`);

      // Calculate totals from state-based counters
      const totalActive = attendance.active_seconds || 0;
      const totalIdle = attendance.idle_seconds || 0;
      const totalBreak = attendance.lunch_seconds || 0;

      // Calculate total work time: active + idle (excludes lunch)
      const totalWork = totalActive + totalIdle;

      logger.info(
        `State-based duration for user ${userId}: work=${totalWork}s, active=${totalActive}s, idle=${totalIdle}s, lunch=${totalBreak}s`
      );

      // Update legacy fields for backward compatibility
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
      await redisClient.del(`user:${userId}:current_state`);
      await redisClient.del(`user:${userId}:last_activity`);

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

    // If already checked out, return stored values
    if (attendance.check_out_time) {
      return {
        ...attendance,
        total_time: attendance.total_work_duration || 0,
        active_time: attendance.total_active_duration || 0,
        idle_time: attendance.total_idle_duration || 0,
        break_time: attendance.total_break_duration || 0,
        tracked_time: (attendance.total_active_duration || 0) + (attendance.total_idle_duration || 0),
        untracked_time: 0
      };
    }

    // For ongoing sessions, calculate real-time from state counters
    const now = new Date();

    // Get accumulated time from state counters
    let totalActive = attendance.active_seconds || 0;
    let totalIdle = attendance.idle_seconds || 0;
    let totalBreak = attendance.lunch_seconds || 0;

    // Add current state duration
    if (attendance.current_state && attendance.last_state_change_at) {
      const currentStateDuration = stateTransitionService.getCurrentStateDuration(attendance, now);

      switch (currentStateDuration.state) {
        case 'WORKING':
          totalActive += currentStateDuration.duration;
          break;
        case 'IDLE':
          totalIdle += currentStateDuration.duration;
          break;
        case 'LUNCH':
          totalBreak += currentStateDuration.duration;
          break;
      }
    }

    // Calculate total work time: active + idle (excludes lunch)
    const totalWork = totalActive + totalIdle;
    const trackedTime = totalActive + totalIdle;

    return {
      ...attendance,
      total_time: totalWork > 0 ? totalWork : 0,
      active_time: totalActive,
      idle_time: totalIdle,
      break_time: totalBreak,
      tracked_time: trackedTime,
      untracked_time: 0,
      current_state: attendance.current_state
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
          // Cap ongoing idle logs to prevent excessive accumulation
          // If idle log is ongoing for more than 24 hours, cap it
          const MAX_IDLE_DURATION = 24 * 60 * 60; // 24 hours in seconds
          if (log.activity_type === 'idle' && duration > MAX_IDLE_DURATION) {
            logger.warn(`Ongoing idle log duration (${duration}s) exceeds maximum (${MAX_IDLE_DURATION}s), capping it for record ${record.id}`);
            duration = MAX_IDLE_DURATION;
          }
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

      // Enforce invariants: active+idle must not exceed totalWork
      const clamped = clampDurations(totalWork, totalActive, totalIdle);
      const finalWork = clamped.totalWork;
      const finalActive = clamped.totalActive;
      const finalIdle = clamped.totalIdle;

      // Calculate tracked time (when app was running)
      const trackedTime = finalActive + finalIdle;
      // Untracked time is when the app was closed
      const untrackedTime = Math.max(0, finalWork - trackedTime);

      // Return record with calculated real-time durations
      return {
        ...record,
        total_work_duration: finalWork > 0 ? finalWork : 0,
        total_active_duration: finalActive,
        total_idle_duration: finalIdle,
        total_break_duration: totalBreak,
        tracked_time: trackedTime,
        untracked_time: untrackedTime
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
