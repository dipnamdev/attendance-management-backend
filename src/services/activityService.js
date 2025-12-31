const pool = require('../config/database');
const { redisClient } = require('../config/redis');
const { formatDate } = require('../utils/helpers');
const logger = require('../utils/logger');
const stateTransitionService = require('./stateTransitionService');
const attendanceService = require('./attendanceService');

const IDLE_THRESHOLD = 300; // 5 minutes in seconds
const AUTO_CHECKOUT_THRESHOLD = 3600; // 60 minutes in seconds

class ActivityService {
  async processHeartbeat(userId, activityData) {
    const {
      active_window,
      active_application,
      url,
      mouse_clicks = 0,
      keyboard_strokes = 0,
      idle_time_seconds = 0,
    } = activityData;

    // DEBUG LOG
    logger.info(`Heartbeat for ${userId}: clicks=${mouse_clicks}, keys=${keyboard_strokes}, is_active=${activityData.is_active}, activeWindow=${active_window}`);

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

      let attendance = attendanceResult.rows[0];

      if (attendance.check_out_time) {
        await client.query('ROLLBACK');
        return { error: 'ALREADY_CHECKED_OUT', message: 'You have already checked out' };
      }

      const now = Date.now();
      const cachedActivity = await redisClient.get(`user:${userId}:last_activity`);

      let lastInputTs = now; // Initialize lastInputTs

      // REVISED LOGIC: Trust the client's idle_time_seconds
      if (idle_time_seconds > 0) {
        lastInputTs = now - (idle_time_seconds * 1000);
      } else if (cachedActivity) {
        // Fallback or verify with cache
        const parsed = JSON.parse(cachedActivity);
        // Only use cache if it suggests a MORE recent input than our calculation?
        // No, client is truth. If client says "I am active" (idle=0), then lastInputTs = now.
        // If client says "Idle 10s", then lastInputTs = now - 10s.
        // We only use cache for "Gap Detection" (if no heartbeat received).
        // But here we HAVE a heartbeat. So we trust the heartbeat.

        // However, we must ensure we don't accidentally "reset" idle time if the client sends a weird 0
        // when they shouldn't. But the client logic is solid now.
      }

      // Check for Auto-Checkout (Inactive > 60 minutes)
      const currentGapSeconds = (now - lastInputTs) / 1000;

      logger.info(`Gap analysis: now=${new Date(now).toISOString()}, lastInput=${new Date(lastInputTs).toISOString()}, gap=${currentGapSeconds}s, current_state=${attendance.current_state}`);

      if (currentGapSeconds > 3600) {
        logger.info(`User ${userId} inactive for ${currentGapSeconds}s (> 60m). Auto-checking out.`);
        await client.query('ROLLBACK');
        client.release();

        const checkoutResult = await attendanceService.checkOut(userId, 'Auto-Checkout', { reason: 'Inactive > 60m' });

        return {
          success: false,
          error: 'AUTO_CHECKED_OUT',
          message: 'You were automatically checked out due to inactivity',
          data: checkoutResult
        };
      }

      // 2. Check for Idle Gap (Inactive > 5 minutes)
      // If client says idle > 5 mins, we trust it.
      if (currentGapSeconds > IDLE_THRESHOLD && attendance.current_state === 'WORKING') {
        logger.info(`DETECTED IDLE GAP > 5m via Heartbeat. Transitioning to IDLE.`);
        attendance = await stateTransitionService.applyStateTransition(attendance, 'IDLE', new Date(lastInputTs), client);
      }

      const { is_active } = activityData;
      // Trust the client's detection but EXCLUDE mouse moves as per requirement
      // If client sends idle_time_seconds > 0, then hasInput is effectively false for THIS heartbeat moment
      // unless clicks > 0 (which means they JUST came back).
      const hasInput = (mouse_clicks + keyboard_strokes) > 0;

      logger.info(`Input detection: hasInput=${hasInput} (clicks=${mouse_clicks}, keys=${keyboard_strokes}). idle_time=${idle_time_seconds}`);

      if (hasInput) {
        lastInputTs = now;
      }

      const secondsSinceInput = (now - lastInputTs) / 1000;
      const currentShouldBeWorking = hasInput || secondsSinceInput < IDLE_THRESHOLD;
      const desiredState = currentShouldBeWorking ? 'WORKING' : 'IDLE';

      logger.info(`State Decision: secondsSinceInput=${secondsSinceInput}, shouldWorking=${currentShouldBeWorking}, desired=${desiredState}, current=${attendance.current_state}`);

      const currentState = attendance.current_state;
      const lastStateChangeTime = new Date(attendance.last_state_change_at || 0).getTime();
      const transitionTime = new Date(Math.max(lastInputTs, lastStateChangeTime));

      if (currentState && currentState !== desiredState && currentState !== 'LUNCH') {
        logger.info(`State transition detected for user ${userId}: ${currentState} → ${desiredState} at ${transitionTime.toISOString()}`);

        attendance = await stateTransitionService.applyStateTransition(
          attendance,
          desiredState,
          transitionTime,
          client
        );

        // Update activity_logs for audit trail
        await client.query(
          `UPDATE activity_logs
           SET end_time = NOW(), duration = EXTRACT(EPOCH FROM (NOW() - start_time))::INTEGER
           WHERE user_id = $1 AND attendance_record_id = $2 AND end_time IS NULL`,
          [userId, attendance.id]
        );

        const activityType = desiredState === 'WORKING' ? 'active' : 'idle';
        await client.query(
          `INSERT INTO activity_logs (user_id, attendance_record_id, activity_type, start_time)
           VALUES ($1, $2, $3, NOW())`,
          [userId, attendance.id, activityType]
        );
      }

      // Insert heartbeat into user_activity_tracking for metrics
      await client.query(
        `INSERT INTO user_activity_tracking
         (user_id, attendance_record_id, timestamp, active_window_title, active_application, url,
          mouse_clicks, keyboard_strokes, is_active, idle_time_seconds)
         VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7, $8, $9)`,
        [userId, attendance.id, active_window, active_application, url, mouse_clicks, keyboard_strokes, true, 0]
      );

      // Update Redis with latest activity info
      await redisClient.set(
        `user:${userId}:last_activity`,
        JSON.stringify({ lastInputTs, lastHeartbeatTs: now }),
        { EX: 86400 }
      );

      await redisClient.set(`user:${userId}:current_state`, attendance.current_state, { EX: 86400 });

      await client.query('COMMIT');

      return {
        success: true,
        current_state: attendance.current_state
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Heartbeat processing error:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  // Background job to check for users who haven't sent heartbeats
  async checkForIdleUsers() {
    try {
      const today = formatDate(new Date());

      // Get all users who are checked in but haven't checked out
      const activeUsers = await pool.query(
        `SELECT ar.*, u.id as user_id 
         FROM attendance_records ar
         JOIN users u ON ar.user_id = u.id
         WHERE ar.date = $1 AND ar.check_out_time IS NULL AND ar.current_state IN ('WORKING', 'IDLE')`,
        [today]
      );

      const now = Date.now();

      for (const record of activeUsers.rows) {
        const userId = record.user_id;
        const cachedActivity = await redisClient.get(`user:${userId}:last_activity`);

        if (cachedActivity) {
          const parsed = JSON.parse(cachedActivity);
          const lastHeartbeatTs = parsed.lastHeartbeatTs;
          const secondsSinceLastHeartbeat = (now - lastHeartbeatTs) / 1000;

          // Check for auto-checkout first
          if (secondsSinceLastHeartbeat > AUTO_CHECKOUT_THRESHOLD) {
            logger.info(`Background check: User ${userId} inactive for ${secondsSinceLastHeartbeat.toFixed(0)}s. Auto-checking out.`);

            const idleStartTime = new Date(lastHeartbeatTs + (IDLE_THRESHOLD * 1000));
            await attendanceService.checkOut(userId, 'Auto-Checkout', {
              reason: 'Inactive > 60m',
              idleSince: idleStartTime
            });
            continue;
          }

          // If more than IDLE_THRESHOLD and currently WORKING, mark as IDLE
          if (secondsSinceLastHeartbeat > IDLE_THRESHOLD && record.current_state === 'WORKING') {
            const idleStartTime = new Date(lastHeartbeatTs + (IDLE_THRESHOLD * 1000));

            logger.info(`Background check: User ${userId} idle since ${idleStartTime.toISOString()}`);

            const client = await pool.connect();
            try {
              await client.query('BEGIN');

              // Fetch fresh attendance record
              const freshAttendance = await client.query(
                'SELECT * FROM attendance_records WHERE user_id = $1 AND date = $2',
                [userId, today]
              );

              if (freshAttendance.rows.length === 0) {
                await client.query('ROLLBACK');
                continue;
              }

              let attendance = freshAttendance.rows[0];

              // Double-check state hasn't changed
              if (attendance.current_state === 'WORKING') {
                attendance = await stateTransitionService.applyStateTransition(
                  attendance,
                  'IDLE',
                  idleStartTime,
                  client
                );

                // Close active logs and create idle log
                await client.query(
                  `UPDATE activity_logs 
                   SET end_time = $1, duration = EXTRACT(EPOCH FROM ($1 - start_time))::INTEGER
                   WHERE user_id = $2 AND attendance_record_id = $3 AND end_time IS NULL AND activity_type = 'active'`,
                  [idleStartTime, userId, record.id]
                );

                await client.query(
                  `INSERT INTO activity_logs (user_id, attendance_record_id, activity_type, start_time) 
                   VALUES ($1, $2, 'idle', $3)`,
                  [userId, record.id, idleStartTime]
                );

                await redisClient.set(`user:${userId}:current_state`, 'IDLE', { EX: 86400 });

                await client.query('COMMIT');
              } else {
                await client.query('ROLLBACK');
              }
            } catch (error) {
              await client.query('ROLLBACK');
              logger.error(`Error marking user ${userId} as idle:`, error);
            } finally {
              client.release();
            }
          }
        }
      }
    } catch (error) {
      logger.error('Error in checkForIdleUsers:', error);
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
      `SELECT uat.* 
       FROM user_activity_tracking uat
       JOIN attendance_records ar ON uat.attendance_record_id = ar.id
       WHERE uat.user_id = $1 AND ar.date = $2
       ORDER BY uat.timestamp ASC`,
      [userId, targetDate]
    );

    const rawLogs = result.rows;
    const aggregatedLogs = [];

    if (rawLogs.length === 0) return [];

    let currentGroup = null;

    for (let i = 0; i < rawLogs.length; i++) {
      const log = rawLogs[i];
      const nextLog = rawLogs[i + 1];

      let duration = 0;
      if (nextLog) {
        const diff = (new Date(nextLog.timestamp) - new Date(log.timestamp)) / 1000;
        if (diff < 300) {
          duration = diff;
        } else {
          duration = 30;
        }
      } else {
        duration = 30;
      }

      const isIdle = !log.is_active;
      const activityType = isIdle ? 'idle' : 'active';
      const appName = log.active_application || 'Unknown';
      const windowTitle = log.active_window_title || '-';

      if (currentGroup &&
        currentGroup.active_application === appName &&
        currentGroup.active_window_title === windowTitle &&
        currentGroup.activity_type === activityType
      ) {
        currentGroup.duration += duration;
        currentGroup.mouse_clicks += (log.mouse_clicks || 0);
        currentGroup.keyboard_strokes += (log.keyboard_strokes || 0);
        currentGroup.end_time = new Date(new Date(currentGroup.start_time).getTime() + currentGroup.duration * 1000);
      } else {
        if (currentGroup) {
          aggregatedLogs.push(currentGroup);
        }
        currentGroup = {
          start_time: log.timestamp,
          end_time: new Date(new Date(log.timestamp).getTime() + duration * 1000),
          active_application: appName,
          active_window_title: windowTitle,
          duration: duration,
          activity_type: activityType,
          mouse_clicks: log.mouse_clicks || 0,
          keyboard_strokes: log.keyboard_strokes || 0
        };
      }
    }

    if (currentGroup) {
      aggregatedLogs.push(currentGroup);
    }

    return aggregatedLogs;
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
        logger.error(`startLunchBreak: No attendance record found for user ${userId} on ${today}`);
        return { error: 'NOT_CHECKED_IN', message: 'Please check in first' };
      }

      let attendance = attendanceResult.rows[0];

      const existingBreak = await client.query(
        'SELECT * FROM lunch_breaks WHERE user_id = $1 AND attendance_record_id = $2 AND break_end_time IS NULL',
        [userId, attendance.id]
      );

      if (existingBreak.rows.length > 0) {
        await client.query('ROLLBACK');
        logger.error(`startLunchBreak: Break already started for user ${userId}, breakId: ${existingBreak.rows[0].id}`);
        return { error: 'BREAK_ALREADY_STARTED', message: 'Lunch break already in progress' };
      }

      attendance = await stateTransitionService.applyStateTransition(
        attendance,
        'LUNCH',
        new Date(),
        client
      );

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

      await redisClient.set(`user:${userId}:current_state`, 'LUNCH', { EX: 86400 });

      await client.query('COMMIT');

      logger.info(`User ${userId} started lunch break, state transitioned to LUNCH`);
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

      let attendance = attendanceResult.rows[0];

      const breakResult = await client.query(
        'SELECT * FROM lunch_breaks WHERE user_id = $1 AND attendance_record_id = $2 AND break_end_time IS NULL',
        [userId, attendance.id]
      );

      if (breakResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return { error: 'NO_ACTIVE_BREAK', message: 'No active lunch break found' };
      }

      attendance = await stateTransitionService.applyStateTransition(
        attendance,
        'WORKING',
        new Date(),
        client
      );

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

      await redisClient.set(`user:${userId}:current_state`, 'WORKING', { EX: 86400 });

      await client.query('COMMIT');

      logger.info(`User ${userId} ended lunch break, state transitioned to WORKING`);
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