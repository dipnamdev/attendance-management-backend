const path = require('path');
const fs = require('fs').promises;
const pool = require('../config/database');
const logger = require('../utils/logger');

// Retention in days for time-series / historical data
const RETENTION_DAYS = parseInt(process.env.DATA_RETENTION_DAYS || '45', 10);

async function cleanupOldData() {
  const client = await pool.connect();
  try {
    logger.info(`Starting cleanup of historical data older than ${RETENTION_DAYS} days...`);

    await client.query('BEGIN');

    // 1) Delete screenshots older than retention from DB and disk
    const screenshotResult = await client.query(
      `SELECT id, screenshot_url, thumbnail_url
       FROM screenshots
       WHERE timestamp < NOW() - INTERVAL '${RETENTION_DAYS} days'`
    );

    const oldScreenshots = screenshotResult.rows;
    logger.info(`Found ${oldScreenshots.length} screenshots older than ${RETENTION_DAYS} days to delete`);

    for (const shot of oldScreenshots) {
      try {
        if (shot.screenshot_url) {
          await fs.unlink(shot.screenshot_url).catch(() => {});
        }
        if (shot.thumbnail_url) {
          await fs.unlink(shot.thumbnail_url).catch(() => {});
        }
      } catch (fileErr) {
        logger.warn(`Failed to delete screenshot files for id=${shot.id}: ${fileErr.message}`);
      }
    }

    await client.query(
      `DELETE FROM screenshots
       WHERE timestamp < NOW() - INTERVAL '${RETENTION_DAYS} days'`
    );

    // 2) Delete time-series / log style data tied to old attendance records
    //    We delete child tables first, then the parent attendance_records, then productivity_summary.

    // Delete user_activity_tracking rows for old attendance records
    const userActivityResult = await client.query(
      `DELETE FROM user_activity_tracking
       WHERE attendance_record_id IN (
         SELECT id FROM attendance_records
         WHERE date < NOW() - INTERVAL '${RETENTION_DAYS} days'
       )`
    );

    // Delete activity_logs rows for old attendance records
    const activityLogsResult = await client.query(
      `DELETE FROM activity_logs
       WHERE attendance_record_id IN (
         SELECT id FROM attendance_records
         WHERE date < NOW() - INTERVAL '${RETENTION_DAYS} days'
       )`
    );

    // Delete lunch_breaks rows for old attendance records
    const lunchBreaksResult = await client.query(
      `DELETE FROM lunch_breaks
       WHERE attendance_record_id IN (
         SELECT id FROM attendance_records
         WHERE date < NOW() - INTERVAL '${RETENTION_DAYS} days'
       )`
    );

    // Delete productivity_summary rows older than retention
    const productivityResult = await client.query(
      `DELETE FROM productivity_summary
       WHERE date < NOW() - INTERVAL '${RETENTION_DAYS} days'`
    );

    // Finally, delete the old attendance_records themselves
    const attendanceResult = await client.query(
      `DELETE FROM attendance_records
       WHERE date < NOW() - INTERVAL '${RETENTION_DAYS} days'`
    );

    await client.query('COMMIT');

    logger.info(`Cleanup job completed. Deleted: ${oldScreenshots.length} screenshots, ` +
      `${userActivityResult.rowCount} user_activity_tracking rows, ` +
      `${activityLogsResult.rowCount} activity_logs rows, ` +
      `${lunchBreaksResult.rowCount} lunch_breaks rows, ` +
      `${productivityResult.rowCount} productivity_summary rows, ` +
      `${attendanceResult.rowCount} attendance_records older than ${RETENTION_DAYS} days.`);

    return {
      deletedScreenshots: oldScreenshots.length,
      deletedUserActivity: userActivityResult.rowCount,
      deletedActivityLogs: activityLogsResult.rowCount,
      deletedLunchBreaks: lunchBreaksResult.rowCount,
      deletedProductivitySummaries: productivityResult.rowCount,
      deletedAttendanceRecords: attendanceResult.rowCount,
      retentionDays: RETENTION_DAYS,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Cleanup old data job failed:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = cleanupOldData;


