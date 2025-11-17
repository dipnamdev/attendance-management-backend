const express = require('express');
const router = express.Router();
const activityController = require('../controllers/activityController');
const { authenticateToken } = require('../middleware/auth');

router.post('/start', authenticateToken, activityController.startLunchBreak);
router.post('/end', authenticateToken, activityController.endLunchBreak);
router.get('/current', authenticateToken, activityController.getCurrentLunchBreak);

module.exports = router;
