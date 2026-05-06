const express = require('express');
const router = express.Router();
const settingsController = require('../controllers/settingsController');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');
const { formatTime } = require('../utils/helpers');

router.get('/', authenticateToken, settingsController.getSettings);
router.put('/:key', authenticateToken, authorizeRoles('admin'), settingsController.updateSetting);
 
// Diagnostic route for Teams
router.get('/test-teams', async (req, res) => {
  const webhookUrl = process.env.TEAMS_WEBHOOK_URL;
  if (!webhookUrl) {
    return res.status(400).json({ success: false, message: 'TEAMS_WEBHOOK_URL is not set in environment' });
  }
  
  try {
    const teamsService = require('../services/teamsService');
    await teamsService.sendCheckInAlert('Diagnostic Test', formatTime(new Date()));
    res.json({ 
      success: true, 
      message: 'Test message sent. Check Teams.',
      webhook_prefix: webhookUrl.substring(0, 50) + '...'
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
