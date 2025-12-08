const pool = require('../config/database');
const logger = require('./logger');

/**
 * Clean up incorrect idle logs
 * 
 * This script removes idle logs that were created incorrectly due to the old
 * idle detection logic. Since the old logic was creating idle logs immediately
 * on any brief pause, we'll delete ALL idle logs from today and let the fixed
 * logic create new ones correctly.
 */
async function cleanupIncorrectIdleLogs() {
    const client = await pool.connect();
    try {
        console.log('Starting cleanup of incorrect idle logs...');

        // Get today's date
        const today = new Date().toISOString().split('T')[0];
        console.log(`Cleaning up idle logs for date: ${today}`);

        // Delete ALL idle logs from today since they were created by buggy logic
        const result = await client.query(
            `DELETE FROM activity_logs 
       WHERE activity_type = 'idle' 
       AND DATE(start_time) = $1
       RETURNING id, user_id, duration`,
            [today]
        );

        console.log(`Deleted ${result.rowCount} idle logs from today`);

        if (result.rowCount > 0) {
            console.log('Sample deleted logs:');
            result.rows.slice(0, 5).forEach(log => {
                console.log(`  - Log ID ${log.id}: User ${log.user_id}, Duration: ${log.duration}s`);
            });
        }

        console.log('Cleanup completed successfully!');
        console.log('Users should Mark Out and Mark In again to start fresh with the fixed logic.');
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
