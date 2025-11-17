const express = require('express');
const router = express.Router();
const screenshotController = require('../controllers/screenshotController');
const { authenticateToken } = require('../middleware/auth');

router.post('/upload', authenticateToken, screenshotController.uploadScreenshot);
router.get('/list', authenticateToken, screenshotController.listScreenshots);
router.get('/:id', authenticateToken, screenshotController.getScreenshot);
router.delete('/:id', authenticateToken, screenshotController.deleteScreenshot);

module.exports = router;
