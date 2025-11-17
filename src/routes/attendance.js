const express = require('express');
const router = express.Router();
const attendanceController = require('../controllers/attendanceController');
const { authenticateToken } = require('../middleware/auth');
const { checkInValidation } = require('../utils/validators');

router.post('/check-in', authenticateToken, checkInValidation, attendanceController.checkIn);
router.post('/check-out', authenticateToken, checkInValidation, attendanceController.checkOut);
router.get('/status', authenticateToken, attendanceController.getStatus);
router.get('/today', authenticateToken, attendanceController.getToday);
router.get('/history', authenticateToken, attendanceController.getHistory);
router.put('/:id/notes', authenticateToken, attendanceController.updateNotes);

module.exports = router;
