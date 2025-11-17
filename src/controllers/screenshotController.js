const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs').promises;
const pool = require('../config/database');
const { successResponse, errorResponse, formatDate } = require('../utils/helpers');
const logger = require('../utils/logger');

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const userId = req.user.id;
    const today = formatDate(new Date());
    const uploadPath = path.join(process.env.UPLOAD_DIR || './uploads', 'screenshots', userId, today);
    
    try {
      await fs.mkdir(uploadPath, { recursive: true });
      cb(null, uploadPath);
    } catch (error) {
      cb(error);
    }
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const ext = path.extname(file.originalname);
    cb(null, `screenshot_${timestamp}${ext}`);
  },
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png'];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only JPEG and PNG are allowed.'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE) || 5 * 1024 * 1024,
  },
}).single('screenshot');

const uploadScreenshot = async (req, res, next) => {
  upload(req, res, async (err) => {
    if (err) {
      logger.error('Upload error:', err);
      if (err instanceof multer.MulterError) {
        return errorResponse(res, 'UPLOAD_ERROR', err.message, 400);
      }
      return errorResponse(res, 'UPLOAD_ERROR', err.message, 400);
    }

    if (!req.file) {
      return errorResponse(res, 'NO_FILE', 'No screenshot file provided', 400);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const userId = req.user.id;
      const today = formatDate(new Date());

      const attendanceResult = await client.query(
        'SELECT * FROM attendance_records WHERE user_id = $1 AND date = $2',
        [userId, today]
      );

      if (attendanceResult.rows.length === 0) {
        await fs.unlink(req.file.path);
        await client.query('ROLLBACK');
        return errorResponse(res, 'NOT_CHECKED_IN', 'Please check in first', 400);
      }

      const attendance = attendanceResult.rows[0];
      const filePath = req.file.path;
      const fileName = req.file.filename;
      const thumbnailName = `thumb_${fileName}`;
      const thumbnailPath = path.join(path.dirname(filePath), thumbnailName);

      await sharp(filePath)
        .resize(200, 150, { fit: 'inside' })
        .toFile(thumbnailPath);

      const fileStats = await fs.stat(filePath);
      const fileSizeKB = Math.round(fileStats.size / 1024);

      const { active_window_title, active_application, screen_resolution } = req.body;

      const screenshotResult = await client.query(
        `INSERT INTO screenshots 
         (user_id, attendance_record_id, timestamp, screenshot_url, thumbnail_url, 
          file_size_kb, active_window_title, active_application, screen_resolution) 
         VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7, $8) 
         RETURNING *`,
        [
          userId,
          attendance.id,
          filePath,
          thumbnailPath,
          fileSizeKB,
          active_window_title,
          active_application,
          screen_resolution,
        ]
      );

      await client.query('COMMIT');

      logger.info(`Screenshot uploaded for user ${userId}`);
      return successResponse(res, { screenshot: screenshotResult.rows[0] }, 'Screenshot uploaded successfully', 201);
    } catch (error) {
      await client.query('ROLLBACK');
      if (req.file) {
        await fs.unlink(req.file.path).catch(() => {});
      }
      logger.error('Screenshot upload error:', error);
      next(error);
    } finally {
      client.release();
    }
  });
};

const listScreenshots = async (req, res, next) => {
  try {
    const { date, user_id } = req.query;
    const isAdmin = req.user.role === 'admin';
    
    const targetUserId = isAdmin && user_id ? user_id : req.user.id;
    const targetDate = date || formatDate(new Date());

    const result = await pool.query(
      `SELECT s.* 
       FROM screenshots s
       JOIN attendance_records ar ON s.attendance_record_id = ar.id
       WHERE s.user_id = $1 AND ar.date = $2
       ORDER BY s.timestamp DESC`,
      [targetUserId, targetDate]
    );

    return successResponse(res, { screenshots: result.rows, count: result.rows.length });
  } catch (error) {
    logger.error('List screenshots error:', error);
    next(error);
  }
};

const getScreenshot = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const isAdmin = req.user.role === 'admin';

    const query = isAdmin
      ? 'SELECT * FROM screenshots WHERE id = $1'
      : 'SELECT * FROM screenshots WHERE id = $1 AND user_id = $2';

    const params = isAdmin ? [id] : [id, userId];
    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
      return errorResponse(res, 'SCREENSHOT_NOT_FOUND', 'Screenshot not found', 404);
    }

    return successResponse(res, { screenshot: result.rows[0] });
  } catch (error) {
    logger.error('Get screenshot error:', error);
    next(error);
  }
};

const deleteScreenshot = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const isAdmin = req.user.role === 'admin';

    const query = isAdmin
      ? 'SELECT * FROM screenshots WHERE id = $1'
      : 'SELECT * FROM screenshots WHERE id = $1 AND user_id = $2';

    const params = isAdmin ? [id] : [id, userId];
    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
      return errorResponse(res, 'SCREENSHOT_NOT_FOUND', 'Screenshot not found', 404);
    }

    const screenshot = result.rows[0];

    await fs.unlink(screenshot.screenshot_url).catch(() => {});
    if (screenshot.thumbnail_url) {
      await fs.unlink(screenshot.thumbnail_url).catch(() => {});
    }

    await pool.query('DELETE FROM screenshots WHERE id = $1', [id]);

    logger.info(`Screenshot ${id} deleted`);
    return successResponse(res, null, 'Screenshot deleted successfully');
  } catch (error) {
    logger.error('Delete screenshot error:', error);
    next(error);
  }
};

module.exports = {
  uploadScreenshot,
  listScreenshots,
  getScreenshot,
  deleteScreenshot,
};
