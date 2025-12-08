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

        // Case 1: Transition from Active to Idle
        // Only occurs if time threshold exceeded (5 minutes of no heartbeats)
        if (timeSinceLastActivity >= IDLE_THRESHOLD && lastActivity.is_active) {
          // Backdate end time by threshold
          const endTimeExpression = `NOW() - INTERVAL '${IDLE_THRESHOLD} seconds'`;
          const durationExpression = `EXTRACT(EPOCH FROM (NOW() - INTERVAL '${IDLE_THRESHOLD} seconds' - start_time))::INTEGER`;

          await client.query(
            `UPDATE activity_logs 
             SET end_time = ${endTimeExpression}, 
                 duration = ${durationExpression}
             WHERE user_id = $1 AND attendance_record_id = $2 AND end_time IS NULL AND activity_type = 'active'`,
            [userId, attendance.id]
          );

          // Start the Idle log (backdated to 5 minutes ago)
          const startTimeExpression = `NOW() - INTERVAL '${IDLE_THRESHOLD} seconds'`;

          await client.query(
            `INSERT INTO activity_logs (user_id, attendance_record_id, activity_type, start_time) 
             VALUES ($1, $2, 'idle', ${startTimeExpression})`,
            [userId, attendance.id]
          );

        } else if (lastActivity.is_active === false && is_active) {
          // Case 2: Transition from Idle to Active
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

      const attendance = attendanceResult.rows[0];

      const existingBreak = await client.query(
        'SELECT * FROM lunch_breaks WHERE user_id = $1 AND attendance_record_id = $2 AND break_end_time IS NULL',
        [userId, attendance.id]
      );

      if (existingBreak.rows.length > 0) {
        await client.query('ROLLBACK');
        logger.error(`startLunchBreak: Break already started for user ${userId}, breakId: ${existingBreak.rows[0].id}`);
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
