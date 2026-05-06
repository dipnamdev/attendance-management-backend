const cron = require('node-cron');
const reportService = require('../services/reportService');
const teamsService = require('../services/teamsService');
const { formatDate } = require('../utils/helpers');
const logger = require('../utils/logger');

const formatDuration = (seconds) => {
  if (seconds === undefined || seconds === null) return '0h 0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
};

const formatTime = (date) => {
  if (!date) return '-';
  // Use a fixed locale for consistent reporting
  return new Date(date).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
};

const runDailyReport = async () => {
  try {
    // Get yesterday's date
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = formatDate(yesterday);

    logger.info(`Running daily report job for ${dateStr}`);
    const data = await reportService.getTeamOverview(dateStr);
    
    if (!data.employees || data.employees.length === 0) {
      logger.info('No attendance records found for yesterday. Skipping report.');
      return;
    }

    // Header
    let markdownTable = `### Daily Attendance Summary: ${dateStr}\n\n`;
    markdownTable += "| Employee | In Time | Out Time | Lunch | Work | Active |\n";
    markdownTable += "| :--- | :--- | :--- | :--- | :--- | :--- |\n";

    for (const emp of data.employees) {
      // Skip users who didn't check in at all
      if (!emp.check_in_time) continue;

      const inTime = formatTime(emp.check_in_time);
      const outTime = formatTime(emp.check_out_time);
      const lunch = formatDuration(emp.total_break_duration);
      const work = formatDuration(emp.total_work_duration);
      const active = formatDuration(emp.total_active_duration);
      
      markdownTable += `| **${emp.name}** | ${inTime} | ${outTime} | ${lunch} | ${work} | ${active} |\n`;
    }

    // Check if we actually have any rows (excluding those who didn't check in)
    if (markdownTable.split('\n').length <= 4) {
      logger.info('No check-ins found for yesterday. Skipping report.');
      return;
    }

    await teamsService.sendDailyReport(markdownTable);
    logger.info(`Daily report for ${dateStr} sent to Teams.`);
  } catch (error) {
    logger.error('Failed to run daily report job:', error);
  }
};

module.exports = { runDailyReport };
