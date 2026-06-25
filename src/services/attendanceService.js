const pool = require('../config/database');

const { redisClient } = require('../config/redis');
const { calculateDuration, formatDate, formatTime } = require('../utils/helpers');
const logger = require('../utils/logger');
const stateTransitionService = require('./stateTransitionService');
const teamsService = require('./teamsService');

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

      await this.checkAndSplitShift(userId, client);

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

          // Log this gap as 'untracked' in activity_logs to keep reports consistent
          if (gapSeconds > 0) {
            await client.query(
              `INSERT INTO activity_logs (user_id, attendance_record_id, activity_type, start_time, end_time, duration) 
               VALUES ($1, $2, 'untracked', $3, NOW(), $4)`,
              [userId, existing.id, existing.check_out_time, gapSeconds]
            );
            logger.info(`Logged gap of ${gapSeconds}s as untracked time for user ${userId} during re-check-in`);
          }

          const currentUntracked = existing.untracked_seconds || 0;
          const newUntracked = currentUntracked + gapSeconds;

          const updateResult = await client.query(
            `UPDATE attendance_records 
             SET check_out_time = NULL,
                 check_out_ip = NULL,
                 check_out_location = NULL,
                 total_work_duration = NULL,
                 total_active_duration = NULL,
                 total_idle_duration = NULL,
                 total_break_duration = NULL,
                 current_state = NULL,
                 last_state_change_at = NULL,
                 untracked_seconds = $2,
                 updated_at = NOW()
             WHERE id = $1
             RETURNING *`,
            [existing.id, newUntracked]
          );
          attendance = updateResult.rows[0];
          logger.info(`User ${userId} re-checked in. Gap of ${gapSeconds}s logged in activity_logs as untracked.`);
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
      
      // Fetch user name for notification
      const userResult = await client.query('SELECT name FROM users WHERE id = $1', [userId]);
      const userName = userResult.rows[0]?.name || 'Unknown User';
      const checkInTime = formatTime(attendance.check_in_time);
      
      // Send notification asynchronously
      teamsService.sendCheckInAlert(userName, checkInTime).catch(err => logger.error('Teams check-in alert error:', err));

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

  async checkOut(userId, ipAddress, location = null, checkoutTime = null) {
    const client = await pool.connect();
    const finalCheckoutTime = checkoutTime ? new Date(checkoutTime) : new Date();
    try {
      await client.query('BEGIN');

      await this.checkAndSplitShift(userId, client, finalCheckoutTime);

      const today = formatDate(finalCheckoutTime);

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
      attendance = await stateTransitionService.finalizeState(attendance, finalCheckoutTime, client);

      // Close all open activity logs for audit trail
      const closedActivities = await client.query(
        `UPDATE activity_logs 
         SET end_time = $3, duration = EXTRACT(EPOCH FROM ($3 - start_time))::INTEGER
         WHERE user_id = $1 AND attendance_record_id = $2 AND end_time IS NULL
         RETURNING id, activity_type, duration`,
        [userId, attendance.id, finalCheckoutTime]
      );

      logger.info(`Closed ${closedActivities.rows.length} open activities for user ${userId}`);

      // Close all open lunch breaks
      const closedBreaks = await client.query(
        `UPDATE lunch_breaks 
         SET break_end_time = $3, duration = EXTRACT(EPOCH FROM ($3 - break_start_time))::INTEGER
         WHERE user_id = $1 AND attendance_record_id = $2 AND break_end_time IS NULL
         RETURNING id, duration`,
        [userId, attendance.id, finalCheckoutTime]
      );

      logger.info(`Closed ${closedBreaks.rows.length} open lunch breaks for user ${userId}`);

      // Calculate totals from state-based counters
      const totalActive = attendance.active_seconds || 0;
      const totalIdle = attendance.idle_seconds || 0;
      const totalBreak = attendance.lunch_seconds || 0;

      // Calculate total work time: active + idle (excludes lunch)
      const rawTotalWork = totalActive + totalIdle;

      // Safety cap: total work can never exceed wall-clock time (check-in to now).
      // If state counters drifted due to a race condition, this prevents impossible values.
      const wallClockSeconds = Math.max(0, Math.floor((finalCheckoutTime - new Date(attendance.check_in_time)) / 1000));
      const totalWork = Math.min(rawTotalWork, wallClockSeconds);

      if (rawTotalWork > wallClockSeconds) {
        logger.warn(
          `[CHECKOUT CLAMP] user=${userId} rawWork=${rawTotalWork}s exceeds wallClock=${wallClockSeconds}s. ` +
          `Clamped to wallClock. active=${totalActive}s, idle=${totalIdle}s, lunch=${totalBreak}s`
        );
      }

      // Update legacy fields for backward compatibility
      const updatedAttendance = await client.query(
        `UPDATE attendance_records 
         SET check_out_time = $8, 
             check_out_ip = $1, 
             check_out_location = $2,
             total_work_duration = $3,
             total_active_duration = $4,
             total_idle_duration = $5,
             total_break_duration = $6,
             updated_at = NOW()
         WHERE id = $7 
         RETURNING *`,
        [ipAddress, location ? JSON.stringify(location) : null, totalWork, totalActive, totalIdle, totalBreak, attendance.id, finalCheckoutTime]
      );

      await redisClient.del(`user:${userId}:attendance`);
      await redisClient.del(`user:${userId}:current_activity`);
      await redisClient.del(`user:${userId}:current_state`);
      await redisClient.del(`user:${userId}:last_activity`);

      const attendanceData = updatedAttendance.rows[0];
      const checkOutTime = formatTime(attendanceData.check_out_time);
      
      // Calculate work hours for notification
      const hours = Math.floor(attendanceData.total_work_duration / 3600);
      const minutes = Math.floor((attendanceData.total_work_duration % 3600) / 60);
      const workHoursStr = `${hours}h ${minutes}m`;

      // Fetch user name for notification
      const userResult = await client.query('SELECT name FROM users WHERE id = $1', [userId]);
      const userName = userResult.rows[0]?.name || 'Unknown User';
      
      // Send notification asynchronously
      teamsService.sendCheckOutAlert(userName, checkOutTime, workHoursStr).catch(err => logger.error('Teams check-out alert error:', err));

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
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await this.checkAndSplitShift(userId, client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error('Error splitting shift in getTodayAttendance:', err);
    } finally {
      client.release();
    }

    const today = formatDate(new Date());
    const result = await pool.query(
      'SELECT * FROM attendance_records WHERE user_id = $1 AND date::date = $2::date',
      [userId, today]
    );

    const attendance = result.rows[0];
    if (!attendance) return null;

    // If already checked out, return stored values
    if (attendance.check_out_time) {
      const logsResult = await pool.query(
        `SELECT id, activity_type, start_time, end_time, duration 
         FROM activity_logs 
         WHERE attendance_record_id = $1 
         ORDER BY start_time ASC`,
        [attendance.id]
      );
      const noteResult = await pool.query(
        'SELECT note_text FROM attendance_notes WHERE user_id = $1 AND date::date = $2::date',
        [userId, today]
      );
      return {
        ...attendance,
        total_time: attendance.total_work_duration || 0,
        active_time: attendance.total_active_duration || 0,
        idle_time: attendance.total_idle_duration || 0,
        break_time: attendance.total_break_duration || 0,
        tracked_time: (attendance.total_active_duration || 0) + (attendance.total_idle_duration || 0),
        untracked_time: attendance.untracked_seconds || 0,
        activity_logs: logsResult.rows,
        daily_note: noteResult.rows[0]?.note_text || null
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

      if (attendance.current_state === 'WORKING') {
        // Check for "silence" (tracker closed/crashed)
        // validStates are WORKING, IDLE, LUNCH.
        // If WORKING, we must check if we have received a recent heartbeat.
        const cachedActivity = await redisClient.get(`user:${userId}:last_activity`);
        let silenceDuration = 0;

        if (cachedActivity) {
          try {
            const parsed = JSON.parse(cachedActivity);
            const lastHeartbeatTs = parsed.lastHeartbeatTs;
            // Ensure lastHeartbeatTs is not in the future and is after the last state change
            if (lastHeartbeatTs && lastHeartbeatTs > new Date(attendance.last_state_change_at).getTime()) {
              const gap = (now.getTime() - lastHeartbeatTs) / 1000;
              // If gap > 10 minutes (600s), treat it as IDLE time
              // BUT we must not double count.
              // Total duration in state = currentStateDuration.duration
              // Active portion = (lastHeartbeat - lastStateChange)
              // (Or if lastHeartbeat < lastStateChange, then 0 active added here? No, stick to the robust logic below)

              // Let's stick to the logic:
              // If gap > 600s, then "real" active ended at lastHeartbeatTs.
              // Currently accumuated: currentStateDuration.duration
              // We should split this.
              if (gap > 600) {
                silenceDuration = gap;
              }
            }
          } catch (err) {
            logger.warn(`Error parsing cached activity for user ${userId}:`, err);
          }
        }

        if (silenceDuration > 0) {
          // Split the current duration
          // Total duration = currentStateDuration.duration
          // The "silence" part is Idle. The rest is Active.
          const forcedIdle = silenceDuration;
          const forcedActive = Math.max(0, currentStateDuration.duration - forcedIdle);

          totalActive += forcedActive;
          totalIdle += forcedIdle;
        } else {
          totalActive += currentStateDuration.duration;
        }
      } else if (attendance.current_state === 'IDLE') {
        totalIdle += currentStateDuration.duration;
      } else if (attendance.current_state === 'LUNCH') {
        totalBreak += currentStateDuration.duration;
      }
    }

    // Calculate total work time: active + idle (excludes lunch)
    const totalWork = totalActive + totalIdle;
    const trackedTime = totalActive + totalIdle;

    const logsResult = await pool.query(
      `SELECT id, activity_type, start_time, end_time, duration 
       FROM activity_logs 
       WHERE attendance_record_id = $1 
       ORDER BY start_time ASC`,
      [attendance.id]
    );

    const noteResult = await pool.query(
      'SELECT note_text FROM attendance_notes WHERE user_id = $1 AND date::date = $2::date',
      [userId, today]
    );

    return {
      ...attendance,
      total_time: totalWork > 0 ? totalWork : 0,
      active_time: totalActive,
      idle_time: totalIdle,
      break_time: totalBreak,
      tracked_time: trackedTime,
      untracked_time: attendance.untracked_seconds || 0,
      current_state: attendance.current_state,
      activity_logs: logsResult.rows,
      daily_note: noteResult.rows[0]?.note_text || null
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
      // If already checked out, return stored values and logs
      if (record.check_out_time) {
        const logsResult = await pool.query(
          `SELECT id, activity_type, start_time, end_time, duration 
           FROM activity_logs 
           WHERE attendance_record_id = $1 
           ORDER BY start_time ASC`,
          [record.id]
        );
        const noteResult = await pool.query(
          'SELECT note_text FROM attendance_notes WHERE user_id = $1 AND date::date = $2::date',
          [record.user_id, record.date]
        );
        return {
          ...record,
          untracked_time: record.untracked_seconds || 0,
          activity_logs: logsResult.rows,
          daily_note: noteResult.rows[0]?.note_text || null
        };
      }

      /**
       * For records without a checkout time we calculate durations in "real time".
       * However, if the record date is in the past (before today) we should NOT
       * keep accumulating time indefinitely. In those cases we cap the end time
       * at that record's end-of-day (23:59:59), which effectively simulates an
       * automatic checkout at the end of the working day.
       */
      // If record is for today and NOT checked out, calculate using counters + current state (Same as getTodayAttendance)
      const now = new Date();
      const recordDateObj = new Date(record.date);
      const isToday = recordDateObj.toDateString() === now.toDateString();

      if (isToday && !record.check_out_time) {
        // Get accumulated time from state counters
        let totalActive = record.active_seconds || 0;
        let totalIdle = record.idle_seconds || 0;
        let totalBreak = record.lunch_seconds || 0;

        // Add current state duration
        if (record.current_state && record.last_state_change_at) {
          const currentStateDuration = stateTransitionService.getCurrentStateDuration(record, now);

          if (record.current_state === 'WORKING') {
            // Check for "silence" (tracker closed/crashed)
            const cachedActivity = await redisClient.get(`user:${userId}:last_activity`);
            let silenceDuration = 0;

            if (cachedActivity) {
              try {
                const parsed = JSON.parse(cachedActivity);
                const lastHeartbeatTs = parsed.lastHeartbeatTs;

                if (lastHeartbeatTs && lastHeartbeatTs > new Date(record.last_state_change_at).getTime()) {
                  const gap = (now.getTime() - lastHeartbeatTs) / 1000;
                  if (gap > 600) {
                    silenceDuration = gap;
                  }
                }
              } catch (err) {
                logger.warn(`Error checking redis for history gap user ${userId}:`, err);
              }
            }

            if (silenceDuration > 0) {
              const forcedIdle = silenceDuration;
              const forcedActive = Math.max(0, currentStateDuration.duration - forcedIdle);

              totalActive += forcedActive;
              totalIdle += forcedIdle;
            } else {
              totalActive += currentStateDuration.duration;
            }
          } else if (record.current_state === 'IDLE') {
            totalIdle += currentStateDuration.duration;
          } else if (record.current_state === 'LUNCH') {
            totalBreak += currentStateDuration.duration;
          }
        }

        // Calculate total work time: active + idle (excludes lunch)
        const totalWork = totalActive + totalIdle;
        const trackedTime = totalActive + totalIdle;

        const logsResult = await pool.query(
          `SELECT id, activity_type, start_time, end_time, duration 
           FROM activity_logs 
           WHERE attendance_record_id = $1 
           ORDER BY start_time ASC`,
          [record.id]
        );
        const noteResult = await pool.query(
          'SELECT note_text FROM attendance_notes WHERE user_id = $1 AND date::date = $2::date',
          [record.user_id, record.date]
        );
        return {
          ...record,
          total_work_duration: totalWork > 0 ? totalWork : 0,
          total_active_duration: totalActive,
          total_idle_duration: totalIdle,
          total_break_duration: totalBreak,
          tracked_time: trackedTime,
          untracked_time: record.untracked_seconds || 0,
          activity_logs: logsResult.rows,
          daily_note: noteResult.rows[0]?.note_text || null
        };
      }

      /**
       * For past records without a checkout time we calculate durations in "real time".
       * However, if the record date is in the past (before today) we should NOT
       * keep accumulating time indefinitely. In those cases we cap the end time
       * at that record's end-of-day (23:59:59), which effectively simulates an
       * automatic checkout at the end of the working day.
       */
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
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
      const logsResult = await pool.query(
        `SELECT id, activity_type, start_time, end_time, duration 
         FROM activity_logs 
         WHERE attendance_record_id = $1 
         ORDER BY start_time ASC`,
        [record.id]
      );
      const noteResult = await pool.query(
        'SELECT note_text FROM attendance_notes WHERE user_id = $1 AND date::date = $2::date',
        [record.user_id, record.date]
      );

      // Return record with calculated real-time durations
      return {
        ...record,
        total_work_duration: finalWork > 0 ? finalWork : 0,
        total_active_duration: finalActive,
        total_idle_duration: finalIdle,
        total_break_duration: totalBreak,
        tracked_time: trackedTime,
        untracked_time: untrackedTime,
        activity_logs: logsResult.rows,
        daily_note: noteResult.rows[0]?.note_text || null
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

  async checkAndSplitShift(userId, client, referenceDate = null) {
    const todayStr = formatDate(referenceDate || new Date());

    // Find any open attendance record from a previous date
    const openRecordsResult = await client.query(
      `SELECT * FROM attendance_records 
       WHERE user_id = $1 AND date < $2::date AND check_out_time IS NULL 
       ORDER BY date ASC`,
      [userId, todayStr]
    );

    if (openRecordsResult.rows.length === 0) {
      return;
    }

    logger.info(`Found ${openRecordsResult.rows.length} open previous records for user ${userId}. Processing split...`);

    for (let record of openRecordsResult.rows) {
      const prevDateStr = formatDate(record.date); // e.g. '2026-06-22'
      const endOfPrevDay = new Date(`${prevDateStr}T23:59:59.999+05:30`);
      const startOfNextDay = new Date(endOfPrevDay.getTime() + 1); // exactly 00:00:00.000 of next day
      const nextDateStr = formatDate(startOfNextDay); // e.g. '2026-06-23'

      logger.info(`Splitting attendance record ${record.id} for user ${userId} at midnight crossing ${prevDateStr} -> ${nextDateStr}`);

      // Keep track of the user's state prior to split
      const prevState = record.current_state || 'WORKING';

      // 1. Finalize the state of the previous record at the end of that day
      record = await stateTransitionService.finalizeState(record, endOfPrevDay, client);

      // Close open activity logs at the end of that day
      await client.query(
        `UPDATE activity_logs 
         SET end_time = $1, duration = EXTRACT(EPOCH FROM ($1 - start_time))::INTEGER
         WHERE attendance_record_id = $2 AND end_time IS NULL`,
        [endOfPrevDay, record.id]
      );

      // Close open lunch breaks at the end of that day
      await client.query(
        `UPDATE lunch_breaks 
         SET break_end_time = $1, duration = EXTRACT(EPOCH FROM ($1 - break_start_time))::INTEGER
         WHERE attendance_record_id = $2 AND break_end_time IS NULL`,
        [endOfPrevDay, record.id]
      );

      // Calculate totals and update the record
      const totalActive = record.active_seconds || 0;
      const totalIdle = record.idle_seconds || 0;
      const totalBreak = record.lunch_seconds || 0;
      const rawTotalWork = totalActive + totalIdle;
      const wallClockSeconds = Math.max(0, Math.floor((endOfPrevDay - new Date(record.check_in_time)) / 1000));
      const totalWork = Math.min(rawTotalWork, wallClockSeconds);

      await client.query(
        `UPDATE attendance_records 
         SET check_out_time = $1, 
             total_work_duration = $2,
             total_active_duration = $3,
             total_idle_duration = $4,
             total_break_duration = $5,
             current_state = NULL,
             last_state_change_at = NULL,
             updated_at = NOW()
         WHERE id = $6`,
        [endOfPrevDay, totalWork, totalActive, totalIdle, totalBreak, record.id]
      );

      // 2. Insert/Check-in for the new day
      // Check if a record for the next day already exists
      const existingNextResult = await client.query(
        `SELECT * FROM attendance_records WHERE user_id = $1 AND date = $2::date FOR UPDATE`,
        [userId, nextDateStr]
      );

      let nextRecord;
      if (existingNextResult.rows.length > 0) {
        const existingNext = existingNextResult.rows[0];
        // If not checked in, update it
        if (!existingNext.check_in_time) {
          const updateNextResult = await client.query(
            `UPDATE attendance_records 
             SET check_in_time = $1,
                 check_in_ip = $2,
                 check_in_location = $3,
                 current_state = $4,
                 last_state_change_at = $1,
                 updated_at = NOW()
             WHERE id = $5
             RETURNING *`,
            [startOfNextDay, record.check_in_ip, record.check_in_location, prevState, existingNext.id]
          );
          nextRecord = updateNextResult.rows[0];
        } else {
          nextRecord = existingNext;
        }
      } else {
        // Insert new record
        const insertNextResult = await client.query(
          `INSERT INTO attendance_records 
           (user_id, date, check_in_time, check_in_ip, check_in_location, current_state, last_state_change_at) 
           VALUES ($1, $2::date, $3, $4, $5, $6, $3) 
           RETURNING *`,
          [userId, nextDateStr, startOfNextDay, record.check_in_ip, record.check_in_location, prevState]
        );
        nextRecord = insertNextResult.rows[0];
      }

      // 3. Open appropriate logs for the new record
      if (prevState === 'WORKING') {
        await client.query(
          `INSERT INTO activity_logs (user_id, attendance_record_id, activity_type, start_time) 
           VALUES ($1, $2, 'active', $3)`,
          [userId, nextRecord.id, startOfNextDay]
        );
      } else if (prevState === 'IDLE') {
        await client.query(
          `INSERT INTO activity_logs (user_id, attendance_record_id, activity_type, start_time) 
           VALUES ($1, $2, 'idle', $3)`,
          [userId, nextRecord.id, startOfNextDay]
        );
      } else if (prevState === 'LUNCH') {
        await client.query(
          `INSERT INTO activity_logs (user_id, attendance_record_id, activity_type, start_time) 
           VALUES ($1, $2, 'lunch_break', $3)`,
          [userId, nextRecord.id, startOfNextDay]
        );
        await client.query(
          `INSERT INTO lunch_breaks (user_id, attendance_record_id, break_start_time, start_location) 
           VALUES ($1, $2, $3, $4)`,
          [userId, nextRecord.id, startOfNextDay, record.check_in_location]
        );
      }

      // Update Redis cache for the user's current session info
      try {
        await redisClient.set(`user:${userId}:attendance`, JSON.stringify(nextRecord), { EX: 86400 });
        await redisClient.set(`user:${userId}:current_state`, prevState, { EX: 86400 });
      } catch (redisErr) {
        logger.error(`Error updating redis in split:`, redisErr);
      }
    }
  }

  async saveDailyNote(userId, date, noteText) {
    const query = `
      INSERT INTO attendance_notes (user_id, date, note_text, updated_at)
      VALUES ($1, $2::date, $3, NOW())
      ON CONFLICT (user_id, date)
      DO UPDATE SET note_text = $3, updated_at = NOW()
      RETURNING *
    `;
    const result = await pool.query(query, [userId, date, noteText]);
    return result.rows[0];
  }

  async getDailyNote(userId, date) {
    const result = await pool.query(
      'SELECT * FROM attendance_notes WHERE user_id = $1 AND date::date = $2::date',
      [userId, date]
    );
    return result.rows[0] || null;
  }
}

module.exports = new AttendanceService();
