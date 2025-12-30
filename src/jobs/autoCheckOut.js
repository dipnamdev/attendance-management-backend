const pool = require('../config/database');
const logger = require('../utils/logger');

function clampDurations(totalWork, totalActive, totalIdle) {
    const work = Math.max(0, totalWork || 0);
    let active = Math.max(0, totalActive || 0);
    let idle = Math.max(0, totalIdle || 0);
    if (work === 0) return { totalWork: 0, totalActive: 0, totalIdle: 0 };
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

async function autoCheckOutUsers(targetDate) {
    const client = await pool.connect();

    try {
        const targetDesc = targetDate ? String(targetDate) : 'today';
        logger.info(`Running auto-checkout job for end of day (${targetDesc})...`);

        // Compute endOfDay for targetDate if provided, else use current date's end
        const now = new Date();
        let endOfDay = new Date(now);
        if (targetDate) {
            const t = new Date(targetDate);
            endOfDay = new Date(t);
        }
        endOfDay.setHours(23, 59, 59, 999);

        // Find all users who are still checked in for the target date
        let openRecords;
        if (targetDate) {
            openRecords = await client.query(`
                        SELECT id, user_id, check_in_time, date
                        FROM attendance_records
                        WHERE date::date = $1::date
                            AND check_out_time IS NULL
                    `, [targetDate]);
        } else {
            openRecords = await client.query(`
                        SELECT id, user_id, check_in_time, date
                        FROM attendance_records
                        WHERE date = CURRENT_DATE
                            AND check_out_time IS NULL
                    `);
        }

        if (openRecords.rows.length === 0) {
            logger.info('No open attendance records found to auto-checkout.');
            return { checkedOut: 0 };
        }

        logger.info(`Found ${openRecords.rows.length} users to auto-checkout...`);

        let checkedOutCount = 0;

        for (const record of openRecords.rows) {
            await client.query('BEGIN');

            try {
                const recordEndOfDay = endOfDay;

                // Fetch current attendance record with state info
                const attendanceResult = await client.query(
                    'SELECT * FROM attendance_records WHERE id = $1',
                    [record.id]
                );
                let attendance = attendanceResult.rows[0];

                // Finalize current state at end of day
                // Finalize current state at end of day
                const stateTransitionService = require('../services/stateTransitionService');

                // FIX: Detect if user stopped sending heartbeats (e.g. PC shutdown/Sleep) while WORKING
                if (attendance.current_state === 'WORKING') {
                    const lastActivityRes = await client.query(
                        `SELECT MAX(timestamp) as last_ts FROM user_activity_tracking WHERE attendance_record_id = $1`,
                        [attendance.id]
                    );
                    const lastHeartbeat = lastActivityRes.rows[0]?.last_ts ? new Date(lastActivityRes.rows[0].last_ts) : null;

                    // If last heartbeat was significantly before EndOfDay (e.g. > 15 mins), assume they went idle/offline then
                    if (lastHeartbeat && (recordEndOfDay.getTime() - lastHeartbeat.getTime() > 15 * 60 * 1000)) {
                        logger.info(`User ${record.user_id} stopped tracking at ${lastHeartbeat.toISOString()}. Switching to IDLE before auto-checkout.`);
                        // Transition to IDLE effectively at user's last known active time
                        // This ensures the time from Shutdown -> EndOfDay counts as IDLE, not ACTIVE
                        attendance = await stateTransitionService.applyStateTransition(
                            attendance,
                            'IDLE',
                            lastHeartbeat,
                            client
                        );
                    }
                }

                attendance = await stateTransitionService.finalizeState(
                    attendance,
                    recordEndOfDay,
                    client
                );

                // 1. Close any open activity logs for audit trail
                await client.query(`
                    UPDATE activity_logs 
                    SET end_time = $1, 
                            duration = EXTRACT(EPOCH FROM ($1 - start_time))::INTEGER
                    WHERE attendance_record_id = $2 AND end_time IS NULL
                `, [recordEndOfDay, record.id]);

                // 2. Close any open lunch breaks
                await client.query(`
                    UPDATE lunch_breaks 
                    SET break_end_time = $1, 
                            duration = EXTRACT(EPOCH FROM ($1 - break_start_time))::INTEGER
                    WHERE attendance_record_id = $2 AND break_end_time IS NULL
                `, [recordEndOfDay, record.id]);

                // 3. Calculate totals from state-based counters
                const totalActive = attendance.active_seconds || 0;
                const totalIdle = attendance.idle_seconds || 0;
                const totalBreak = attendance.lunch_seconds || 0;
                const totalWork = totalActive + totalIdle;

                // 4. Update attendance record with final totals
                await client.query(`
                    UPDATE attendance_records
                    SET check_out_time = $1,
                            total_work_duration = $2,
                            total_active_duration = $3,
                            total_idle_duration = $4,
                            total_break_duration = $5,
                            updated_at = NOW()
                    WHERE id = $6
                `, [recordEndOfDay, totalWork, totalActive, totalIdle, totalBreak, record.id]);

                await client.query('COMMIT');
                const userIdDisplay = record.user_id ? String(record.user_id).substring(0, 8) : 'unknown';
                logger.info(`Auto-checked out user ${userIdDisplay} for date ${record.date} at ${recordEndOfDay.toISOString()} (state-based: work=${totalWork}s, active=${totalActive}s, idle=${totalIdle}s, lunch=${totalBreak}s)`);
                checkedOutCount++;

            } catch (error) {
                await client.query('ROLLBACK');
                logger.error(`Failed to auto-checkout record ${record.id}:`, error);
            }
        }

        logger.info(`Auto-checkout job completed. Checked out ${checkedOutCount} users.`);
        return { checkedOut: checkedOutCount };

    } catch (error) {
        logger.error('Error in auto-checkout job:', error);
        throw error;
    } finally {
        client.release();
    }
}

// Backfill missed auto-checkouts for past dates (records with date < CURRENT_DATE)
async function backfillMissedAutoCheckOuts() {
    const client = await pool.connect();
    try {
        logger.info('Running backfill for missed auto-checkouts...');
        const res = await client.query(`
            SELECT id, user_id, check_in_time, date
            FROM attendance_records
            WHERE date::date < CURRENT_DATE::date
                AND check_out_time IS NULL
            ORDER BY date ASC
        `);

        if (res.rows.length === 0) {
            logger.info('No missed attendance records found for backfill.');
            return { backfilled: 0 };
        }

        logger.info(`Found ${res.rows.length} missed records to backfill.`);
        let backfilled = 0;

        // Process each record by invoking autoCheckOutUsers for that date
        const processedDates = new Set();
        for (const record of res.rows) {
            const dateStr = new Date(record.date).toISOString().slice(0, 10);
            if (processedDates.has(dateStr)) continue; // we'll process per-date
            processedDates.add(dateStr);

            try {
                const result = await autoCheckOutUsers(dateStr);
                backfilled += result.checkedOut || 0;
            } catch (err) {
                logger.error(`Failed backfilling date ${dateStr}:`, err);
            }
        }

        logger.info(`Backfill completed. Backfilled ${backfilled} records.`);
        return { backfilled };
    } catch (error) {
        logger.error('Error in backfill missed auto-checkouts:', error);
        throw error;
    } finally {
        client.release();
    }
}

module.exports = autoCheckOutUsers;
module.exports.backfillMissed = backfillMissedAutoCheckOuts;
