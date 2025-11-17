const pool = require('../config/database');
const { successResponse, errorResponse } = require('../utils/helpers');
const logger = require('../utils/logger');

const getSettings = async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM system_settings ORDER BY setting_key');

    const settings = {};
    result.rows.forEach(row => {
      settings[row.setting_key] = {
        value: row.setting_value,
        description: row.description,
        updated_at: row.updated_at,
      };
    });

    return successResponse(res, { settings });
  } catch (error) {
    logger.error('Get settings error:', error);
    next(error);
  }
};

const updateSetting = async (req, res, next) => {
  try {
    const { key } = req.params;
    const { value, description } = req.body;

    if (!value) {
      return errorResponse(res, 'INVALID_INPUT', 'Setting value is required', 400);
    }

    const result = await pool.query(
      `INSERT INTO system_settings (setting_key, setting_value, description, updated_by, updated_at) 
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (setting_key) 
       DO UPDATE SET setting_value = $2, description = $3, updated_by = $4, updated_at = NOW()
       RETURNING *`,
      [key, JSON.stringify(value), description, req.user.id]
    );

    logger.info(`Setting updated: ${key}`);
    return successResponse(res, { setting: result.rows[0] }, 'Setting updated successfully');
  } catch (error) {
    logger.error('Update setting error:', error);
    next(error);
  }
};

module.exports = {
  getSettings,
  updateSetting,
};
