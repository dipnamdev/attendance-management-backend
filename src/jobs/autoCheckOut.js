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
                                const recordEndOfDay = endOfDay; // for targetDate all records share same endOfDay; for backfill caller will call per-record

                                // 1. Close any open activity logs
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

                                // 3. Calculate final durations
                                const activityStats = await client.query(`
                    SELECT 
                        COALESCE(SUM(CASE WHEN activity_type = 'active' THEN duration ELSE 0 END), 0) as total_active,
                        COALESCE(SUM(CASE WHEN activity_type = 'idle' THEN duration ELSE 0 END), 0) as total_idle
                    FROM activity_logs 
                    WHERE attendance_record_id = $1
                `, [record.id]);

                                const breakStats = await client.query(`
                    SELECT COALESCE(SUM(duration), 0) as total_break 
                    FROM lunch_breaks 
                    WHERE attendance_record_id = $1
                `, [record.id]);

                                const totalActive = parseInt(activityStats.rows[0].total_active) || 0;
                                const totalIdle = parseInt(activityStats.rows[0].total_idle) || 0;
                                const totalBreak = parseInt(breakStats.rows[0].total_break) || 0;

                                // Calculate total work: from check-in to end of day, minus breaks
                                const totalElapsed = Math.floor((recordEndOfDay - new Date(record.check_in_time)) / 1000);
                                const totalWork = totalElapsed - totalBreak;
                                const clamped = clampDurations(totalWork, totalActive, totalIdle);

                                // 4. Update attendance record
                                await client.query(`
                    UPDATE attendance_records
                    SET check_out_time = $1,
                            total_work_duration = $2,
                            total_active_duration = $3,
                            total_idle_duration = $4,
                            total_break_duration = $5,
                            updated_at = NOW()
                    WHERE id = $6
                `, [recordEndOfDay, clamped.totalWork, clamped.totalActive, clamped.totalIdle, totalBreak, record.id]);

                                await client.query('COMMIT');
                                const userIdDisplay = record.user_id ? String(record.user_id).substring(0, 8) : 'unknown';
                                logger.info(`Auto-checked out user ${userIdDisplay} for date ${record.date} at ${recordEndOfDay.toISOString()}`);
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
