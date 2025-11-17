const activityService = require('../services/activityService');
const { successResponse, errorResponse } = require('../utils/helpers');
const logger = require('../utils/logger');

const heartbeat = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const activityData = req.body;

    const result = await activityService.processHeartbeat(userId, activityData);

    if (result.error) {
      return errorResponse(res, result.error, result.message, 400);
    }

    return successResponse(res, null, 'Heartbeat recorded');
  } catch (error) {
    logger.error('Heartbeat controller error:', error);
    next(error);
  }
};

const logActivity = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const activityData = req.body;

    const result = await activityService.processHeartbeat(userId, activityData);

    if (result.error) {
      return errorResponse(res, result.error, result.message, 400);
    }

    return successResponse(res, null, 'Activity logged successfully', 201);
  } catch (error) {
    logger.error('Log activity controller error:', error);
    next(error);
  }
};

const getCurrentActivity = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const activity = await activityService.getCurrentActivity(userId);

    return successResponse(res, { activity });
  } catch (error) {
    logger.error('Get current activity controller error:', error);
    next(error);
  }
};

const getActivityHistory = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { date } = req.query;

    const history = await activityService.getActivityHistory(userId, date);

    return successResponse(res, { history, count: history.length });
  } catch (error) {
    logger.error('Get activity history controller error:', error);
    next(error);
  }
};

const startLunchBreak = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { location } = req.body;

    const result = await activityService.startLunchBreak(userId, location);

    if (result.error) {
      return errorResponse(res, result.error, result.message, 400);
    }

    return successResponse(res, result.lunchBreak, 'Lunch break started', 201);
  } catch (error) {
    logger.error('Start lunch break controller error:', error);
    next(error);
  }
};

const endLunchBreak = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { location } = req.body;

    const result = await activityService.endLunchBreak(userId, location);

    if (result.error) {
      return errorResponse(res, result.error, result.message, 400);
    }

    return successResponse(res, result.lunchBreak, 'Lunch break ended');
  } catch (error) {
    logger.error('End lunch break controller error:', error);
    next(error);
  }
};

const getCurrentLunchBreak = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const lunchBreak = await activityService.getCurrentLunchBreak(userId);

    return successResponse(res, { lunchBreak });
  } catch (error) {
    logger.error('Get current lunch break controller error:', error);
    next(error);
  }
};

module.exports = {
  heartbeat,
  logActivity,
  getCurrentActivity,
  getActivityHistory,
  startLunchBreak,
  endLunchBreak,
  getCurrentLunchBreak,
};
