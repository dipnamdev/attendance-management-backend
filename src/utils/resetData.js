const pool = require('../config/database');
const logger = require('./logger');

/**
 * Hard reset of all time-series / operational data while keeping:
 * - users (login details and profiles)
 * - system_settings (configuration)
 *
 * Tables cleared:
 *   - screenshots
 *   - user_activity_tracking
 *   - activity_logs
 *   - lunch_breaks
 *   - productivity_summary
 *   - attendance_records
 */
async function resetData() {
  const client = await pool.connect();

  try {
    logger.warn('⚠️  Starting FULL DATA RESET (attendance, activity, screenshots, summaries). Users will be preserved.');

    await client.query('BEGIN');

    // Order matters because of foreign key relationships.
    await client.query('DELETE FROM screenshots');
    await client.query('DELETE FROM user_activity_tracking');
    await client.query('DELETE FROM activity_logs');
    await client.query('DELETE FROM lunch_breaks');
    await client.query('DELETE FROM productivity_summary');
    await client.query('DELETE FROM attendance_records');

    await client.query('COMMIT');

    logger.warn('✅ Data reset completed. All operational records cleared, user accounts preserved.');
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('❌ Data reset failed:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Allow running as a standalone script: `node src/utils/resetData.js`
if (require.main === module) {
  resetData()
    .then(() => {
      process.exit(0);
    })
    .catch(() => {
      process.exit(1);
    });
}

module.exports = resetData;


