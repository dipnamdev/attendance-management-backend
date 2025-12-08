const pool = require('../config/database');
const logger = require('./logger');

/**
 * Clean up incorrect idle logs
 * 
 * This script removes idle logs that were created incorrectly due to the old
 * idle detection logic. It removes idle logs that are shorter than 5 minutes
 * (300 seconds) since those should never have been created.
 */
async function cleanupIncorrectIdleLogs() {
    const client = await pool.connect();
    try {
        console.log('Starting cleanup of incorrect idle logs...');

        // Find and delete idle logs shorter than 5 minutes (300 seconds)
        const result = await client.query(
            `DELETE FROM activity_logs 
       WHERE activity_type = 'idle' 
       AND duration IS NOT NULL 
       AND duration < 300
       RETURNING id, user_id, duration`
        );

        console.log(`Deleted ${result.rowCount} incorrect idle logs`);

        if (result.rowCount > 0) {
            console.log('Sample deleted logs:');
            result.rows.slice(0, 5).forEach(log => {
                console.log(`  - Log ID ${log.id}: User ${log.user_id}, Duration: ${log.duration}s`);
            });
        }

        // Also close any open idle logs that have been running for less than 5 minutes
        const openIdleResult = await client.query(
            `UPDATE activity_logs 
       SET end_time = NOW(), 
           duration = EXTRACT(EPOCH FROM (NOW() - start_time))::INTEGER
       WHERE activity_type = 'idle' 
       AND end_time IS NULL 
       AND EXTRACT(EPOCH FROM (NOW() - start_time)) < 300
       RETURNING id, user_id`
        );

        if (openIdleResult.rowCount > 0) {
            console.log(`Closed ${openIdleResult.rowCount} open idle logs that were less than 5 minutes`);

            // Now delete them since they shouldn't exist
            await client.query(
                `DELETE FROM activity_logs 
         WHERE id = ANY($1)`,
                [openIdleResult.rows.map(r => r.id)]
            );
            console.log(`Deleted those ${openIdleResult.rowCount} logs`);
        }

        console.log('Cleanup completed successfully!');
        process.exit(0);
    } catch (error) {
        console.error('Error during cleanup:', error);
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
    }
}

cleanupIncorrectIdleLogs();
