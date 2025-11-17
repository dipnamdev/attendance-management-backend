const pool = require('../config/database');
const { formatDate } = require('../utils/helpers');

class ReportService {
  async getDailyReport(userId, date) {
    const targetDate = date || formatDate(new Date());

    const attendance = await pool.query(
      'SELECT * FROM attendance_records WHERE user_id = $1 AND date = $2',
      [userId, targetDate]
    );

    if (attendance.rows.length === 0) {
      return null;
    }

    const activities = await pool.query(
      `SELECT activity_type, SUM(duration) as total_duration, COUNT(*) as count
       FROM activity_logs
       WHERE user_id = $1 AND attendance_record_id = $2
       GROUP BY activity_type`,
      [userId, attendance.rows[0].id]
    );

    const screenshots = await pool.query(
      'SELECT COUNT(*) as count FROM screenshots WHERE user_id = $1 AND attendance_record_id = $2',
      [userId, attendance.rows[0].id]
    );

    const activityTracking = await pool.query(
      `SELECT 
         SUM(mouse_clicks) as total_clicks,
         SUM(keyboard_strokes) as total_strokes,
         active_application,
         COUNT(*) as usage_count
       FROM user_activity_tracking
       WHERE user_id = $1 AND attendance_record_id = $2
       GROUP BY active_application
       ORDER BY usage_count DESC
       LIMIT 10`,
      [userId, attendance.rows[0].id]
    );

    return {
      attendance: attendance.rows[0],
      activities: activities.rows,
      screenshot_count: parseInt(screenshots.rows[0].count),
      top_applications: activityTracking.rows,
      total_mouse_clicks: activityTracking.rows.reduce((sum, row) => sum + parseInt(row.total_clicks || 0), 0),
      total_keyboard_strokes: activityTracking.rows.reduce((sum, row) => sum + parseInt(row.total_strokes || 0), 0),
    };
  }

  async getWeeklyReport(userId, startDate) {
    const start = startDate || formatDate(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
    const end = formatDate(new Date());

    const attendance = await pool.query(
      `SELECT * FROM attendance_records 
       WHERE user_id = $1 AND date >= $2 AND date <= $3
       ORDER BY date DESC`,
      [userId, start, end]
    );

    const summary = await pool.query(
      `SELECT 
         COUNT(*) as total_days,
         SUM(total_work_duration) as total_work,
         SUM(total_active_duration) as total_active,
         SUM(total_idle_duration) as total_idle,
         SUM(total_break_duration) as total_break,
         AVG(total_active_duration) as avg_active
       FROM attendance_records
       WHERE user_id = $1 AND date >= $2 AND date <= $3`,
      [userId, start, end]
    );

    return {
      period: { start, end },
      attendance_records: attendance.rows,
      summary: summary.rows[0],
    };
  }

  async getMonthlyReport(userId, month, year) {
    const currentDate = new Date();
    const targetMonth = month || (currentDate.getMonth() + 1);
    const targetYear = year || currentDate.getFullYear();

    const startDate = `${targetYear}-${String(targetMonth).padStart(2, '0')}-01`;
    const endDate = new Date(targetYear, targetMonth, 0);
    const endDateStr = formatDate(endDate);

    const attendance = await pool.query(
      `SELECT * FROM attendance_records 
       WHERE user_id = $1 AND date >= $2 AND date <= $3
       ORDER BY date DESC`,
      [userId, startDate, endDateStr]
    );

    const summary = await pool.query(
      `SELECT 
         COUNT(*) as total_days,
         SUM(total_work_duration) as total_work,
         SUM(total_active_duration) as total_active,
         SUM(total_idle_duration) as total_idle,
         SUM(total_break_duration) as total_break,
         AVG(total_active_duration) as avg_active,
         COUNT(CASE WHEN status = 'present' THEN 1 END) as present_days,
         COUNT(CASE WHEN status = 'absent' THEN 1 END) as absent_days
       FROM attendance_records
       WHERE user_id = $1 AND date >= $2 AND date <= $3`,
      [userId, startDate, endDateStr]
    );

    const productivity = await pool.query(
      `SELECT * FROM productivity_summary
       WHERE user_id = $1 AND date >= $2 AND date <= $3
       ORDER BY date DESC`,
      [userId, startDate, endDateStr]
    );

    return {
      period: { month: targetMonth, year: targetYear, start: startDate, end: endDateStr },
      attendance_records: attendance.rows,
      summary: summary.rows[0],
      productivity_summaries: productivity.rows,
    };
  }

  async getProductivitySummary(userId, period = 'week') {
    let startDate;
    const endDate = formatDate(new Date());

    if (period === 'week') {
      startDate = formatDate(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
    } else if (period === 'month') {
      startDate = formatDate(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
    } else {
      startDate = formatDate(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
    }

    const result = await pool.query(
      `SELECT * FROM productivity_summary
       WHERE user_id = $1 AND date >= $2 AND date <= $3
       ORDER BY date DESC`,
      [userId, startDate, endDate]
    );

    return {
      period: { start: startDate, end: endDate, type: period },
      summaries: result.rows,
    };
  }

  async getTeamOverview(date) {
    const targetDate = date || formatDate(new Date());

    const overview = await pool.query(
      `SELECT 
         u.id,
         u.name,
         u.email,
         u.employee_id,
         ar.check_in_time,
         ar.check_out_time,
         ar.total_work_duration,
         ar.total_active_duration,
         ar.total_idle_duration,
         ar.status
       FROM users u
       LEFT JOIN attendance_records ar ON u.id = ar.user_id AND ar.date = $1
       WHERE u.role = 'employee' AND u.status = 'active'
       ORDER BY u.name`,
      [targetDate]
    );

    const summary = await pool.query(
      `SELECT 
         COUNT(DISTINCT user_id) as total_checked_in,
         COUNT(CASE WHEN check_out_time IS NOT NULL THEN 1 END) as total_checked_out,
         AVG(total_active_duration) as avg_active_duration
       FROM attendance_records
       WHERE date = $1`,
      [targetDate]
    );

    return {
      date: targetDate,
      employees: overview.rows,
      summary: summary.rows[0],
    };
  }
}

module.exports = new ReportService();
