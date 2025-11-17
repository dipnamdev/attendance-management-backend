const attendanceService = require('../services/attendanceService');
const { successResponse, errorResponse, getClientIp } = require('../utils/helpers');
const logger = require('../utils/logger');

const checkIn = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const ipAddress = getClientIp(req);
    const { location } = req.body;

    const result = await attendanceService.checkIn(userId, ipAddress, location);

    if (result.error) {
      return errorResponse(res, result.error, result.message, 400);
    }

    return successResponse(res, result.attendance, 'Checked in successfully', 201);
  } catch (error) {
    logger.error('Check-in controller error:', error);
    next(error);
  }
};

const checkOut = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const ipAddress = getClientIp(req);
    const { location } = req.body;

    const result = await attendanceService.checkOut(userId, ipAddress, location);

    if (result.error) {
      return errorResponse(res, result.error, result.message, 400);
    }

    return successResponse(res, result.attendance, 'Checked out successfully');
  } catch (error) {
    logger.error('Check-out controller error:', error);
    next(error);
  }
};

const getStatus = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const attendance = await attendanceService.getTodayAttendance(userId);

    const status = {
      isCheckedIn: !!attendance,
      isCheckedOut: attendance?.check_out_time ? true : false,
      attendance: attendance || null,
    };

    return successResponse(res, status);
  } catch (error) {
    logger.error('Get status controller error:', error);
    next(error);
  }
};

const getToday = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const attendance = await attendanceService.getTodayAttendance(userId);

    if (!attendance) {
      return errorResponse(res, 'NO_ATTENDANCE', 'No attendance record found for today', 404);
    }

    return successResponse(res, { attendance });
  } catch (error) {
    logger.error('Get today controller error:', error);
    next(error);
  }
};

const getHistory = async (req, res, next) => {
  try {
    const { start_date, end_date, user_id } = req.query;
    
    const targetUserId = req.user.role === 'admin' && user_id ? user_id : req.user.id;
    
    const history = await attendanceService.getAttendanceHistory(
      targetUserId,
      start_date,
      end_date
    );

    return successResponse(res, { history, count: history.length });
  } catch (error) {
    logger.error('Get history controller error:', error);
    next(error);
  }
};

const updateNotes = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;
    const userId = req.user.id;
    const isAdmin = req.user.role === 'admin';

    const attendance = await attendanceService.updateNotes(id, userId, notes, isAdmin);

    if (!attendance) {
      return errorResponse(res, 'ATTENDANCE_NOT_FOUND', 'Attendance record not found', 404);
    }

    return successResponse(res, { attendance }, 'Notes updated successfully');
  } catch (error) {
    logger.error('Update notes controller error:', error);
    next(error);
  }
};

module.exports = {
  checkIn,
  checkOut,
  getStatus,
  getToday,
  getHistory,
  updateNotes,
};
