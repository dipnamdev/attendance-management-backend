const pool = require('../config/database');
const logger = require('../utils/logger');
const { formatDate } = require('../utils/helpers');

async function runDailyAggregation() {
  const client = await pool.connect();
  try {
    logger.info('Starting daily aggregation job...');

    const yesterday = formatDate(new Date(Date.now() - 24 * 60 * 60 * 1000));

    const attendanceRecords = await client.query(
      'SELECT * FROM attendance_records WHERE date = $1',
      [yesterday]
    );

    for (const attendance of attendanceRecords.rows) {
      const activityStats = await client.query(
        `SELECT 
           COALESCE(SUM(CASE WHEN activity_type = 'active' THEN duration ELSE 0 END), 0) as active_time,
           COALESCE(SUM(CASE WHEN activity_type = 'idle' THEN duration ELSE 0 END), 0) as idle_time
         FROM activity_logs 
         WHERE attendance_record_id = $1`,
        [attendance.id]
      );

      const screenshotCount = await client.query(
        'SELECT COUNT(*) as count FROM screenshots WHERE attendance_record_id = $1',
        [attendance.id]
      );

      const activityData = await client.query(
        `SELECT 
           SUM(mouse_clicks) as total_clicks,
           SUM(keyboard_strokes) as total_strokes,
           active_application,
           COUNT(*) as usage_count
         FROM user_activity_tracking
         WHERE attendance_record_id = $1
         GROUP BY active_application
         ORDER BY usage_count DESC
         LIMIT 10`,
        [attendance.id]
      );

      const urlData = await client.query(
        `SELECT url, COUNT(*) as visit_count
         FROM user_activity_tracking
         WHERE attendance_record_id = $1 AND url IS NOT NULL
         GROUP BY url
         ORDER BY visit_count DESC
         LIMIT 10`,
        [attendance.id]
      );

      const totalTrackedTime = attendance.total_work_duration || 0;
      const productiveTime = parseInt(activityStats.rows[0].active_time) || 0;
      const unproductiveTime = parseInt(activityStats.rows[0].idle_time) || 0;
      
      const productivityScore = totalTrackedTime > 0 
        ? Math.round((productiveTime / totalTrackedTime) * 100)
        : 0;

      const totalClicks = activityData.rows.reduce((sum, row) => sum + parseInt(row.total_clicks || 0), 0);
      const totalStrokes = activityData.rows.reduce((sum, row) => sum + parseInt(row.total_strokes || 0), 0);

      await client.query(
        `INSERT INTO productivity_summary 
         (user_id, date, total_tracked_time, productive_time, unproductive_time, 
          top_applications, top_websites, total_screenshots, total_mouse_clicks, 
          total_keyboard_strokes, productivity_score)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (user_id, date) 
         DO UPDATE SET 
           total_tracked_time = $3,
           productive_time = $4,
           unproductive_time = $5,
           top_applications = $6,
           top_websites = $7,
           total_screenshots = $8,
           total_mouse_clicks = $9,
           total_keyboard_strokes = $10,
           productivity_score = $11,
           updated_at = NOW()`,
        [
          attendance.user_id,
          yesterday,
          totalTrackedTime,
          productiveTime,
          unproductiveTime,
          JSON.stringify(activityData.rows),
          JSON.stringify(urlData.rows),
          parseInt(screenshotCount.rows[0].count),
          totalClicks,
          totalStrokes,
          productivityScore,
        ]
      );

      logger.info(`Aggregated data for user ${attendance.user_id} on ${yesterday}`);
    }

    logger.info(`Daily aggregation completed for ${attendanceRecords.rows.length} records`);
  } catch (error) {
    logger.error('Daily aggregation error:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = runDailyAggregation;
