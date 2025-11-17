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

const isValidUUID = (uuid) => {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
};

module.exports = {
  successResponse,
  errorResponse,
  calculateDuration,
  getClientIp,
  formatDate,
  isValidUUID,
};
