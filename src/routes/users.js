const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');
const { registerValidation } = require('../utils/validators');

router.get('/', authenticateToken, authorizeRoles('admin'), userController.getAllUsers);
router.post('/', authenticateToken, authorizeRoles('admin'), registerValidation, userController.createUser);
router.get('/:id', authenticateToken, authorizeRoles('admin'), userController.getUserById);
router.put('/:id', authenticateToken, authorizeRoles('admin'), userController.updateUser);
router.delete('/:id', authenticateToken, authorizeRoles('admin'), userController.deleteUser);
router.get('/:id/attendance-summary', authenticateToken, authorizeRoles('admin'), userController.getUserAttendanceSummary);

module.exports = router;
