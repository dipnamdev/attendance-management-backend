const pool = require('../config/database');
const logger = require('../utils/logger');

/**
 * Create an attendance_records row for every active user for the given date (or today).
 * Rows are created with null check_in/check_out so the UI can show 'N/A' until user acts.
 */
async function createDailyAttendance(targetDate) {
  const client = await pool.connect();
  try {
    const dateToUse = targetDate ? new Date(targetDate) : new Date();
    const dateStr = dateToUse.toISOString().slice(0, 10); // YYYY-MM-DD
    logger.info(`Creating daily attendance entries for date ${dateStr}...`);

    // Insert a row per active user if not exists. Adjust users selection as needed (e.g., active flag).
    const sql = `
      INSERT INTO attendance_records (user_id, date, created_at)
      SELECT u.id, $1::date, NOW()
      FROM users u
      WHERE (u.is_active IS NULL OR u.is_active = true)
        AND NOT EXISTS (
          SELECT 1 FROM attendance_records ar WHERE ar.user_id = u.id AND ar.date::date = $1::date
        )
    `;

    const res = await client.query(sql, [dateStr]);
    logger.info('Daily attendance creation completed.');
    return { created: res.rowCount || 0 };
  } catch (error) {
    logger.error('Error creating daily attendance entries:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = createDailyAttendance;
