const reportService = require('../services/reportService');
const { successResponse, errorResponse } = require('../utils/helpers');
const logger = require('../utils/logger');

const getDailyReport = async (req, res, next) => {
  try {
    const { date, user_id } = req.query;
    const isAdmin = req.user.role === 'admin';
    const targetUserId = isAdmin && user_id ? user_id : req.user.id;

    const report = await reportService.getDailyReport(targetUserId, date);

    if (!report) {
      return errorResponse(res, 'NO_DATA', 'No attendance data found for the specified date', 404);
    }

    return successResponse(res, { report });
  } catch (error) {
    logger.error('Get daily report error:', error);
    next(error);
  }
};

const getWeeklyReport = async (req, res, next) => {
  try {
    const { start_date, user_id } = req.query;
    const isAdmin = req.user.role === 'admin';
    const targetUserId = isAdmin && user_id ? user_id : req.user.id;

    const report = await reportService.getWeeklyReport(targetUserId, start_date);

    return successResponse(res, { report });
  } catch (error) {
    logger.error('Get weekly report error:', error);
    next(error);
  }
};

const getMonthlyReport = async (req, res, next) => {
  try {
    const { month, year, user_id } = req.query;
    const isAdmin = req.user.role === 'admin';
    const targetUserId = isAdmin && user_id ? user_id : req.user.id;

    const report = await reportService.getMonthlyReport(
      targetUserId,
      month ? parseInt(month) : undefined,
      year ? parseInt(year) : undefined
    );

    return successResponse(res, { report });
  } catch (error) {
    logger.error('Get monthly report error:', error);
    next(error);
  }
};

const getProductivitySummary = async (req, res, next) => {
  try {
    const { user_id, period = 'week' } = req.query;
    const isAdmin = req.user.role === 'admin';
    const targetUserId = isAdmin && user_id ? user_id : req.user.id;

    const summary = await reportService.getProductivitySummary(targetUserId, period);

    return successResponse(res, { summary });
  } catch (error) {
    logger.error('Get productivity summary error:', error);
    next(error);
  }
};

const getTeamOverview = async (req, res, next) => {
  try {
    const { date } = req.query;

    if (req.user.role !== 'admin') {
      return errorResponse(res, 'FORBIDDEN', 'Only admins can access team overview', 403);
    }

    const overview = await reportService.getTeamOverview(date);

    return successResponse(res, { overview });
  } catch (error) {
    logger.error('Get team overview error:', error);
    next(error);
  }
};

const exportReport = async (req, res, next) => {
  try {
    return successResponse(res, null, 'Export feature coming soon');
  } catch (error) {
    logger.error('Export report error:', error);
    next(error);
  }
};

module.exports = {
  getDailyReport,
  getWeeklyReport,
  getMonthlyReport,
  getProductivitySummary,
  getTeamOverview,
  exportReport,
};
