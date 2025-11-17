const redis = require('redis');
require('dotenv').config();

let redisClient = null;
let isRedisConnected = false;

async function connectRedis() {
  try {
    redisClient = redis.createClient({
      socket: {
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT || 6379,
        reconnectStrategy: () => false,
      },
    });

    redisClient.on('error', () => {
      isRedisConnected = false;
    });

    redisClient.on('connect', () => {
      console.log('✅ Redis connected successfully');
      isRedisConnected = true;
    });

    await redisClient.connect();
  } catch (error) {
    console.warn('⚠️  Redis connection failed - continuing without caching');
    redisClient = null;
    isRedisConnected = false;
  }
}

const safeRedisClient = {
  async set(...args) {
    if (isRedisConnected && redisClient) {
      try {
        return await redisClient.set(...args);
      } catch (error) {
        console.warn('Redis set operation failed:', error.message);
      }
    }
    return null;
  },
  async get(...args) {
    if (isRedisConnected && redisClient) {
      try {
        return await redisClient.get(...args);
      } catch (error) {
        console.warn('Redis get operation failed:', error.message);
      }
    }
    return null;
  },
  async del(...args) {
    if (isRedisConnected && redisClient) {
      try {
        return await redisClient.del(...args);
      } catch (error) {
        console.warn('Redis del operation failed:', error.message);
      }
    }
    return null;
  },
};

module.exports = { redisClient: safeRedisClient, connectRedis };
