const pool = require('../config/database');
const logger = require('../utils/logger');
const { redisClient } = require('../config/redis');

const MAX_IDLE_DURATION = 30 * 60; // 30 minutes in seconds

async function autoCheckOutIdleUsers() {
    const client = await pool.connect();

    try {
        logger.info('Running auto-checkout for excessive idle users...');

        // Find all users who are currently IDLE for more than 30 minutes
        const excessiveIdleUsers = await client.query(`
      SELECT 
        id,
        user_id,
        check_in_time,
        last_state_change_at,
        EXTRACT(EPOCH FROM (NOW() - last_state_change_at))::INTEGER as current_duration
      FROM attendance_records
      WHERE check_out_time IS NULL
        AND current_state = 'IDLE'
        AND EXTRACT(EPOCH FROM (NOW() - last_state_change_at))::INTEGER > $1
    `, [MAX_IDLE_DURATION]);

        if (excessiveIdleUsers.rows.length === 0) {
            // logger.info('No excessive idle users found'); // Reduce noise
            return { checkedOut: 0 };
        }

        logger.info(`Found ${excessiveIdleUsers.rows.length} users idle > 30 mins. Auto-checking out...`);

        let checkedOutCount = 0;

        for (const record of excessiveIdleUsers.rows) {
            await client.query('BEGIN');

            try {
                // Calculate the check-out time as exactly 30 mins after they went idle
                // This caps the credited idle time at 30 mins
                const checkOutTime = new Date(new Date(record.last_state_change_at).getTime() + (MAX_IDLE_DURATION * 1000));

                // Fetch current attendance record full data
                const attendanceResult = await client.query(
                    'SELECT * FROM attendance_records WHERE id = $1',
                    [record.id]
                );
                let attendance = attendanceResult.rows[0];

                // Finalize current state at the capped time
                const stateTransitionService = require('../services/stateTransitionService');
                attendance = await stateTransitionService.finalizeState(
                    attendance,
                    checkOutTime,
                    client
                );

                // Close any open activity logs at the same time
                await client.query(`
          UPDATE activity_logs 
          SET end_time = $1, 
              duration = EXTRACT(EPOCH FROM ($1 - start_time))::INTEGER
          WHERE attendance_record_id = $2 AND end_time IS NULL
        `, [checkOutTime, record.id]);

                // Close any open lunch breaks (unlikely if state is IDLE, but safe to check)
                await client.query(`
          UPDATE lunch_breaks 
          SET break_end_time = $1, 
              duration = EXTRACT(EPOCH FROM ($1 - break_start_time))::INTEGER
          WHERE attendance_record_id = $2 AND break_end_time IS NULL
        `, [checkOutTime, record.id]);

                // Calculate totals from state-based counters
                const totalActive = attendance.active_seconds || 0;
                const totalIdle = attendance.idle_seconds || 0;
                const totalBreak = attendance.lunch_seconds || 0;
                const totalWork = totalActive + totalIdle;

                // Auto check-out the employee
                await client.query(`
          UPDATE attendance_records
          SET check_out_time = $1,
              total_work_duration = $2,
              total_active_duration = $3,
              total_idle_duration = $4,
              total_break_duration = $5,
              updated_at = NOW()
          WHERE id = $6
        `, [checkOutTime, totalWork, totalActive, totalIdle, totalBreak, record.id]);

                // Clear Redis for this user
                if (record.user_id) {
                    await redisClient.del(`user:${record.user_id}:attendance`);
                    await redisClient.del(`user:${record.user_id}:current_activity`);
                    await redisClient.del(`user:${record.user_id}:current_state`);
                    await redisClient.del(`user:${record.user_id}:last_activity`);
                }

                await client.query('COMMIT');

                const userIdDisplay = record.user_id ? String(record.user_id).substring(0, 8) : 'unknown';
                logger.info(`Auto-checked out idle user ${userIdDisplay}. (Idle > 30m, capped at 30m)`);
                checkedOutCount++;

            } catch (error) {
                await client.query('ROLLBACK');
                logger.error(`Failed to auto-checkout idle user ${record.user_id}:`, error);
            }
        }

        return { checkedOut: checkedOutCount };

    } catch (error) {
        logger.error('Error in auto-checkout idle users job:', error);
        throw error;
    } finally {
        client.release();
    }
}

module.exports = autoCheckOutIdleUsers;
