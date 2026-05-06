const axios = require('axios');
const logger = require('../utils/logger');

class TeamsService {
  constructor() {
    this.webhookUrl = process.env.TEAMS_WEBHOOK_URL;
  }

  async sendMessage(payload) {
    if (!this.webhookUrl) {
      logger.warn('TEAMS_WEBHOOK_URL not configured. Skipping notification.');
      return;
    }

    try {
      logger.info(`Attempting to send Teams notification: ${payload.summary}`);
      await axios.post(this.webhookUrl, payload, {
        headers: { 'Content-Type': 'application/json' }
      });
      logger.info('Teams notification sent successfully');
    } catch (error) {
      if (error.response) {
        logger.error(`Failed to send Teams notification. Status: ${error.response.status}`, error.response.data);
      } else {
        logger.error('Failed to send Teams notification:', error.message);
      }
    }
  }

  async sendCheckInAlert(userName, time) {
    const payload = {
      "@type": "MessageCard",
      "@context": "http://schema.org/extensions",
      "summary": "Check-In Alert",
      "themeColor": "0076D7",
      "title": "✅ Employee Checked In",
      "text": `**${userName}** marked in at **${time}**.`
    };
    return this.sendMessage(payload);
  }

  async sendCheckOutAlert(userName, time, workHours) {
    const payload = {
      "@type": "MessageCard",
      "@context": "http://schema.org/extensions",
      "summary": "Check-Out Alert",
      "themeColor": "107C10",
      "title": "🚪 Employee Checked Out",
      "text": `**${userName}** marked out at **${time}**.\n\n**Total Work Hours:** ${workHours}`
    };
    return this.sendMessage(payload);
  }

  async sendAutoCheckOutAlert(userName, time, reason) {
    const payload = {
      "@type": "MessageCard",
      "@context": "http://schema.org/extensions",
      "summary": "Auto Check-Out Alert",
      "themeColor": "E81123",
      "title": "⚠️ Auto Checked Out (Inactivity)",
      "text": `**${userName}** was automatically marked out at **${time}**.\n\n**Reason:** ${reason}`
    };
    return this.sendMessage(payload);
  }

  async sendLunchOutAlert(userName, time) {
    const payload = {
      "@type": "MessageCard",
      "@context": "http://schema.org/extensions",
      "summary": "Lunch Break Start",
      "themeColor": "F8A100",
      "title": "🍕 Lunch Break Started",
      "text": `**${userName}** started lunch at **${time}**.`
    };
    return this.sendMessage(payload);
  }

  async sendLunchInAlert(userName, time, duration) {
    const payload = {
      "@type": "MessageCard",
      "@context": "http://schema.org/extensions",
      "summary": "Lunch Break End",
      "themeColor": "00B7C3",
      "title": "🍱 Lunch Break Ended",
      "text": `**${userName}** returned from lunch at **${time}**.\n\n**Duration:** ${duration}`
    };
    return this.sendMessage(payload);
  }

  async sendDailyReport(reportTable) {
    const payload = {
      "@type": "MessageCard",
      "@context": "http://schema.org/extensions",
      "summary": "Daily Attendance Report",
      "themeColor": "6264A7",
      "title": "📅 Daily Attendance Report",
      "text": reportTable
    };
    return this.sendMessage(payload);
  }
}

module.exports = new TeamsService();
