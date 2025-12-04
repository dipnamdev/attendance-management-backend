const express = require('express');
const router = express.Router();
const reportController = require('../controllers/reportController');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');

router.get('/daily', authenticateToken, reportController.getDailyReport);
router.get('/weekly', authenticateToken, reportController.getWeeklyReport);
router.get('/monthly', authenticateToken, reportController.getMonthlyReport);
router.get('/productivity-summary', authenticateToken, reportController.getProductivitySummary);
router.get('/team-overview', authenticateToken, reportController.getTeamOverview);
router.get('/export', authenticateToken, authorizeRoles('admin'), reportController.exportReport);

module.exports = router;  
 