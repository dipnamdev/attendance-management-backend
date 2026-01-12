const jwt = require('jsonwebtoken');
const { errorResponse } = require('../utils/helpers');

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  let token = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  }

  if (!token && req.query && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return errorResponse(res, 'NO_TOKEN', 'Authentication token is required', 401);
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return errorResponse(res, 'INVALID_TOKEN', 'Invalid or expired token', 401);
  }
};

const authorizeRoles = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return errorResponse(res, 'UNAUTHORIZED', 'User not authenticated', 401);
    }

    if (!roles.includes(req.user.role)) {
      return errorResponse(res, 'FORBIDDEN', 'You do not have permission to perform this action', 403);
    }

    next();
  };
};

module.exports = {
  authenticateToken,
  authorizeRoles,
};
