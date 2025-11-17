const express = require('express');
const router = express.Router();
const settingsController = require('../controllers/settingsController');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');

router.get('/', authenticateToken, settingsController.getSettings);
router.put('/:key', authenticateToken, authorizeRoles('admin'), settingsController.updateSetting);

module.exports = router;
