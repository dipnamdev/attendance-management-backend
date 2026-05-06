const successResponse = (res, data, message = null, statusCode = 200) => {
  return res.status(statusCode).json({
    success: true,
    data,
    message,
  });
};

const errorResponse = (res, code, message, statusCode = 400) => {
  return res.status(statusCode).json({
    success: false,
    error: {
      code,
      message,
    },
  });
};

const calculateDuration = (startTime, endTime) => {
  const start = new Date(startTime);
  const end = new Date(endTime);
  return Math.floor((end - start) / 1000);
};

const getClientIp = (req) => {
  return req.headers['x-forwarded-for']?.split(',')[0] || 
         req.socket.remoteAddress || 
         req.connection.remoteAddress;
};

const formatDate = (date) => {
  return new Date(date).toISOString().split('T')[0];
};

const formatTime = (date) => {
  if (!date) return '-';
  try {
    return new Date(date).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
      timeZone: 'Asia/Kolkata'
    });
  } catch (e) {
    return new Date(date).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
  }
};

module.exports = {
  successResponse,
  errorResponse,
  calculateDuration,
  getClientIp,
  formatDate,
  formatTime,
  isValidUUID,
};
