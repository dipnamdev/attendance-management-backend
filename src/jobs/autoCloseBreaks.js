const pool = require('../config/database');
const logger = require('../utils/logger');

const MAX_BREAK_DURATION = 2 * 60 * 60; // 2 hours in seconds

function clampDurations(totalWork, totalActive, totalIdle) {
  const work = Math.max(0, totalWork || 0);
  let active = Math.max(0, totalActive || 0);
  let idle = Math.max(0, totalIdle || 0);
  if (work === 0) return { totalWork: 0, totalActive: 0, totalIdle: 0 };
  const sum = active + idle;
  if (sum > work) {
    const excess = sum - work;
    const newIdle = Math.max(0, idle - excess);
    const remainingExcess = Math.max(0, excess - (idle - newIdle));
    const newActive = Math.max(0, active - remainingExcess);
    return { totalWork: work, totalActive: newActive, totalIdle: newIdle };
  }
  return { totalWork: work, totalActive: active, totalIdle: idle };
}

async function autoCloseExcessiveBreaks() {
  const client = await pool.connect();

  try {
    logger.info('Running auto-close excessive breaks job...');

    // Find all open breaks that have exceeded 2 hours
    const excessiveBreaks = await client.query(`
      SELECT 
        lb.id as break_id,
        lb.user_id,
        lb.attendance_record_id,
        lb.break_start_time,
        ar.check_in_time,
        EXTRACT(EPOCH FROM (NOW() - lb.break_start_time))::INTEGER as current_duration
      FROM lunch_breaks lb
      JOIN attendance_records ar ON lb.attendance_record_id = ar.id
      WHERE lb.break_end_time IS NULL
        AND ar.check_out_time IS NULL
        AND EXTRACT(EPOCH FROM (NOW() - lb.break_start_time))::INTEGER > $1
    `, [MAX_BREAK_DURATION]);

    if (excessiveBreaks.rows.length === 0) {
      logger.info('No excessive breaks found to auto-close');
      return { closed: 0, checkedOut: 0 };
    }

    logger.info(`Found ${excessiveBreaks.rows.length} breaks exceeding 2 hours, auto-closing and checking out employees...`);

    let closedCount = 0;
    let checkedOutCount = 0;

    for (const brk of excessiveBreaks.rows) {
      await client.query('BEGIN');

      try {
        // Calculate the break end time as 2 hours after start
        const breakEndTime = new Date(new Date(brk.break_start_time).getTime() + (MAX_BREAK_DURATION * 1000));

        // Fetch current attendance record
        const attendanceResult = await client.query(
          'SELECT * FROM attendance_records WHERE id = $1',
          [brk.attendance_record_id]
        );
        let attendance = attendanceResult.rows[0];

        // Finalize current state at break end time
        const stateTransitionService = require('../services/stateTransitionService');
        attendance = await stateTransitionService.finalizeState(
          attendance,
          breakEndTime,
          client
        );

        // Close the break with 2-hour duration
        await client.query(`
          UPDATE lunch_breaks
          SET break_end_time = $1,
              duration = $2
          WHERE id = $3
        `, [breakEndTime, MAX_BREAK_DURATION, brk.break_id]);

        // Calculate totals from state-based counters
        const totalActive = attendance.active_seconds || 0;
        const totalIdle = attendance.idle_seconds || 0;
        const totalBreak = attendance.lunch_seconds || 0;
        const totalWork = totalActive + totalIdle;

        // Auto check-out the employee at the break end time
        await client.query(`
          UPDATE attendance_records
          SET check_out_time = $1,
              total_work_duration = $2,
              total_active_duration = $3,
              total_idle_duration = $4,
              total_break_duration = $5,
              updated_at = NOW()
          WHERE id = $6
        `, [breakEndTime, totalWork, totalActive, totalIdle, totalBreak, brk.attendance_record_id]);

        await client.query('COMMIT');

        logger.info(`Auto-closed break and checked out user ${brk.user_id.substring(0, 8)}... (break was ${Math.floor(brk.current_duration / 3600)}h, capped at 2h, state-based totals: work=${totalWork}s, active=${totalActive}s, idle=${totalIdle}s, lunch=${totalBreak}s)`);
        closedCount++;
        checkedOutCount++;

      } catch (error) {
        await client.query('ROLLBACK');
        logger.error(`Failed to auto-close break ${brk.break_id}:`, error);
      }
    }

    logger.info(`Auto-closed ${closedCount} excessive breaks and checked out ${checkedOutCount} employees`);
    return { closed: closedCount, checkedOut: checkedOutCount };

  } catch (error) {
    logger.error('Error in auto-close excessive breaks job:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = autoCloseExcessiveBreaks;
