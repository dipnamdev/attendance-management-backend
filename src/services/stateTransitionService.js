const pool = require('../config/database');
const logger = require('../utils/logger');

/**
 * State Transition Service
 * Handles all state transitions for attendance tracking
 * States: WORKING, IDLE, LUNCH
 */
class StateTransitionService {
    /**
     * Apply a state transition to an attendance record
     * @param {Object} attendance - Current attendance record
     * @param {string} newState - New state (WORKING, IDLE, LUNCH)
     * @param {Date} eventTime - Time of the transition
     * @param {Object} client - Optional database client for transactions
     * @returns {Promise<Object>} Updated attendance record
     */
    async applyStateTransition(attendance, newState, eventTime, client = null) {
        const useClient = client || await pool.connect();
        const shouldReleaseClient = !client;

        try {
            // Validate state
            const validStates = ['WORKING', 'IDLE', 'LUNCH'];
            if (!validStates.includes(newState)) {
                throw new Error(`Invalid state: ${newState}. Must be one of: ${validStates.join(', ')}`);
            }

            const currentState = attendance.current_state;
            const lastStateChangeAt = attendance.last_state_change_at;

            // If no current state, this is initialization (should only happen on check-in)
            if (!currentState || !lastStateChangeAt) {
                const result = await useClient.query(
                    `UPDATE attendance_records 
           SET current_state = $1, 
               last_state_change_at = $2,
               updated_at = NOW()
           WHERE id = $3
           RETURNING *`,
                    [newState, eventTime, attendance.id]
                );
                logger.info(`Initialized state for attendance ${attendance.id}: ${newState}`);
                return result.rows[0];
            }

            // Calculate duration in current state
            const durationMs = new Date(eventTime) - new Date(lastStateChangeAt);
            const durationSeconds = Math.floor(durationMs / 1000);

            // Prevent negative durations (clock skew or invalid timestamps)
            if (durationSeconds < 0) {
                logger.warn(`Negative duration detected for attendance ${attendance.id}. Event time: ${eventTime}, Last change: ${lastStateChangeAt}`);
                // Don't update state if time is going backwards
                return attendance;
            }

            // Determine which counter to update based on PREVIOUS state
            let updateField;
            switch (currentState) {
                case 'WORKING':
                    updateField = 'active_seconds';
                    break;
                case 'IDLE':
                    updateField = 'idle_seconds';
                    break;
                case 'LUNCH':
                    updateField = 'lunch_seconds';
                    break;
                default:
                    logger.error(`Unknown current state: ${currentState}`);
                    updateField = 'idle_seconds'; // Default to idle for unknown states
            }

            // Update the attendance record
            const result = await useClient.query(
                `UPDATE attendance_records 
         SET ${updateField} = ${updateField} + $1,
             current_state = $2,
             last_state_change_at = $3,
             updated_at = NOW()
         WHERE id = $4
         RETURNING *`,
                [durationSeconds, newState, eventTime, attendance.id]
            );

            logger.info(
                `State transition for attendance ${attendance.id}: ${currentState} → ${newState} (${durationSeconds}s added to ${updateField})`
            );

            return result.rows[0];
        } catch (error) {
            logger.error('State transition error:', error);
            throw error;
        } finally {
            if (shouldReleaseClient) {
                useClient.release();
            }
        }
    }

    /**
     * Finalize the current state (called on check-out)
     * Closes the current state and adds duration to appropriate counter
     * @param {Object} attendance - Current attendance record
     * @param {Date} eventTime - Time of finalization (check-out time)
     * @param {Object} client - Optional database client for transactions
     * @returns {Promise<Object>} Updated attendance record with finalized totals
     */
    async finalizeState(attendance, eventTime, client = null) {
        const useClient = client || await pool.connect();
        const shouldReleaseClient = !client;

        try {
            const currentState = attendance.current_state;
            const lastStateChangeAt = attendance.last_state_change_at;

            // If no active state, nothing to finalize
            if (!currentState || !lastStateChangeAt) {
                logger.info(`No active state to finalize for attendance ${attendance.id}`);
                return attendance;
            }

            // Calculate final duration
            const durationMs = new Date(eventTime) - new Date(lastStateChangeAt);
            const durationSeconds = Math.max(0, Math.floor(durationMs / 1000));

            // Determine which counter to update
            let updateField;
            switch (currentState) {
                case 'WORKING':
                    updateField = 'active_seconds';
                    break;
                case 'IDLE':
                    updateField = 'idle_seconds';
                    break;
                case 'LUNCH':
                    updateField = 'lunch_seconds';
                    break;
                default:
                    updateField = 'idle_seconds';
            }

            // Update and clear state
            const result = await useClient.query(
                `UPDATE attendance_records 
         SET ${updateField} = ${updateField} + $1,
             current_state = NULL,
             last_state_change_at = NULL,
             updated_at = NOW()
         WHERE id = $2
         RETURNING *`,
                [durationSeconds, attendance.id]
            );

            logger.info(
                `Finalized state for attendance ${attendance.id}: ${currentState} (${durationSeconds}s added to ${updateField})`
            );

            return result.rows[0];
        } catch (error) {
            logger.error('State finalization error:', error);
            throw error;
        } finally {
            if (shouldReleaseClient) {
                useClient.release();
            }
        }
    }

    /**
     * Get current state duration without updating database
     * Used for real-time display
     * @param {Object} attendance - Current attendance record
     * @param {Date} currentTime - Current time for calculation
     * @returns {Object} Current state and duration in seconds
     */
    getCurrentStateDuration(attendance, currentTime = new Date()) {
        if (!attendance.current_state || !attendance.last_state_change_at) {
            return { state: null, duration: 0 };
        }

        const durationMs = currentTime - new Date(attendance.last_state_change_at);
        const durationSeconds = Math.max(0, Math.floor(durationMs / 1000));

        return {
            state: attendance.current_state,
            duration: durationSeconds
        };
    }
}

module.exports = new StateTransitionService();
