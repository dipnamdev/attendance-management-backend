const express = require('express');
const router = express.Router();
const activityController = require('../controllers/activityController');
const { authenticateToken } = require('../middleware/auth');
const { activityHeartbeatValidation, dateQueryValidation } = require('../utils/validators');

router.post('/heartbeat', authenticateToken, activityHeartbeatValidation, activityController.heartbeat);
router.post('/log', authenticateToken, activityController.logActivity);
router.get('/current', authenticateToken, activityController.getCurrentActivity);
router.get('/history', authenticateToken, dateQueryValidation, activityController.getActivityHistory);

module.exports = router;
