const pool = require('../config/database');
const { redisClient } = require('../config/redis');
const { formatDate } = require('../utils/helpers');
const logger = require('../utils/logger');
const stateTransitionService = require('./stateTransitionService');
const attendanceService = require('./attendanceService');

const IDLE_THRESHOLD = 300; // 5 minutes in seconds

class ActivityService {
  async processHeartbeat(userId, activityData) {
    const {
      active_window,
      active_application,
      url,
      mouse_clicks = 0,
      keyboard_strokes = 0,
      idle_time_seconds = 0 // unused for state; kept for compatibility
    } = activityData;

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

      // Insert heartbeat into user_activity_tracking for metrics only
      await client.query(
        `INSERT INTO user_activity_tracking 
         (user_id, attendance_record_id, timestamp, active_window_title, active_application, url, 
          mouse_clicks, keyboard_strokes, is_active, idle_time_seconds) 
         VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7, $8, $9)`,
        [userId, attendance.id, active_window, active_application, url, mouse_clicks, keyboard_strokes, true, 0]
      );

      const cachedActivity = await redisClient.get(`user:${userId}:last_activity`);
      const now = Date.now();

      // Track the last time we observed input activity
      let lastInputTs = now;
      let lastHeartbeatTs = now;

      if (cachedActivity) {
        const parsed = JSON.parse(cachedActivity);
        lastInputTs = parsed.lastInputTs || now;
        lastHeartbeatTs = parsed.lastHeartbeatTs || now;
      }

      // Calculate gap since last input
      const gapSeconds = (now - lastInputTs) / 1000;

      // 1. Check for Auto-Checkout (Inactive > 60 minutes)
      if (gapSeconds > 3600) {
        logger.info(`User ${userId} inactive for ${gapSeconds}s (> 60m). Auto-checking out.`);
        await client.query('ROLLBACK'); // Abort current transaction

        // release client before calling external service to avoid deadlock/pool exhaustion
        client.release();

        // Perform checkout
        const checkoutResult = await attendanceService.checkOut(userId, 'Auto-Checkout', { reason: 'Inactive > 60m' });

        return {
          success: false,
          error: 'AUTO_CHECKED_OUT',
          message: 'You were automatically checked out due to inactivity',
          data: checkoutResult
        };
      }

      // 2. Check for Idle Gap (Inactive > 5 minutes)
      // If gap is significant, retroactively mark the gap period as IDLE
      if (gapSeconds > IDLE_THRESHOLD && attendance.current_state === 'WORKING') {
        logger.info(`Gap of ${gapSeconds}s detected for user ${userId}. Retroactively setting state to IDLE at ${new Date(lastInputTs).toISOString()}`);

        attendance = await stateTransitionService.applyStateTransition(
          attendance,
          'IDLE',
          new Date(lastInputTs), // Transition at start of gap
          client
        );
      }

      const { is_active } = activityData;
      // Trust the client's detection but EXCLUDE mouse moves as per requirement
      // Only count actual keyboard strokes or mouse clicks as "Working" activity
      // const hasInput = is_active === true || is_active === 'true' || (mouse_clicks + keyboard_strokes) > 0;
      const hasInput = (mouse_clicks + keyboard_strokes) > 0;
      if (hasInput) {
        lastInputTs = now;
      }

      const secondsSinceInput = (now - lastInputTs) / 1000;
      const currentShouldBeWorking = hasInput || secondsSinceInput < IDLE_THRESHOLD;

      // Determine desired state based on activity
      const desiredState = currentShouldBeWorking ? 'WORKING' : 'IDLE';
      const currentState = attendance.current_state;

      // Apply state transition if state changed
      // Determines transition time: backdate to lastInputTs for accuracy, but don't go before current state start
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

    // Fetch raw tracking data joined with attendance records to filter by date
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

      // Calculate duration for this heartbeat
      let duration = 0;
      if (nextLog) {
        const diff = (new Date(nextLog.timestamp) - new Date(log.timestamp)) / 1000;
        // If gap is less than 5 minutes, consider it part of the session. 
        // Otherwise, it's a gap (stop/offline), so cap the duration of this last heartbeat.
        if (diff < 300) {
          duration = diff;
        } else {
          duration = 30; // Default heartbeat interval assumption
        }
      } else {
        duration = 30; // Default for the very last log
      }

      const isIdle = !log.is_active;
      // If idle, we might want to group them as "Idle" regardless of app, 
      // or show the app but mark as idle. 
      // The UI shows activity_type 'active'/'idle'.
      // Let's group by app/window too, but break if activity_type changes.

      const activityType = isIdle ? 'idle' : 'active';
      const appName = log.active_application || 'Unknown';
      const windowTitle = log.active_window_title || '-';

      if (currentGroup &&
        currentGroup.active_application === appName &&
        currentGroup.active_window_title === windowTitle &&
        currentGroup.activity_type === activityType
      ) {
        // Continue group
        currentGroup.duration += duration;
        currentGroup.mouse_clicks += (log.mouse_clicks || 0);
        currentGroup.keyboard_strokes += (log.keyboard_strokes || 0);
        // Update end time
        currentGroup.end_time = new Date(new Date(currentGroup.start_time).getTime() + currentGroup.duration * 1000);
      } else {
        // Push previous group
        if (currentGroup) {
          aggregatedLogs.push(currentGroup);
        }
        // Start new group
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

    // Push the last group
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

      // Transition to LUNCH state
      attendance = await stateTransitionService.applyStateTransition(
        attendance,
        'LUNCH',
        new Date(),
        client
      );

      // Close any open activity logs
      await client.query(
        `UPDATE activity_logs 
         SET end_time = NOW(), duration = EXTRACT(EPOCH FROM (NOW() - start_time))::INTEGER
         WHERE user_id = $1 AND attendance_record_id = $2 AND end_time IS NULL`,
        [userId, attendance.id]
      );

      // Insert lunch_breaks record for audit trail
      const breakResult = await client.query(
        `INSERT INTO lunch_breaks (user_id, attendance_record_id, break_start_time, start_location) 
         VALUES ($1, $2, NOW(), $3) 
         RETURNING *`,
        [userId, attendance.id, location ? JSON.stringify(location) : null]
      );

      // Insert activity_logs entry for audit trail
      await client.query(
        `INSERT INTO activity_logs (user_id, attendance_record_id, activity_type, start_time) 
         VALUES ($1, $2, 'lunch_break', NOW())`,
        [userId, attendance.id]
      );

      // Update Redis
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

      // Transition back to WORKING state
      attendance = await stateTransitionService.applyStateTransition(
        attendance,
        'WORKING',
        new Date(),
        client
      );

      // Update lunch_breaks record
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

      // Close lunch_break activity log
      await client.query(
        `UPDATE activity_logs 
         SET end_time = NOW(), duration = EXTRACT(EPOCH FROM (NOW() - start_time))::INTEGER
         WHERE user_id = $1 AND attendance_record_id = $2 AND activity_type = 'lunch_break' AND end_time IS NULL`,
        [userId, attendance.id]
      );

      // Start new active activity log
      await client.query(
        `INSERT INTO activity_logs (user_id, attendance_record_id, activity_type, start_time) 
         VALUES ($1, $2, 'active', NOW())`,
        [userId, attendance.id]
      );

      // Update Redis
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
