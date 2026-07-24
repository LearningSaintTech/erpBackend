import Redis from 'ioredis';
import { env } from './env.js';

let redis = null;

export function getRedis() {
  if (!redis) {
    redis = new Redis(env.redisUrl, { maxRetriesPerRequest: null });
  }
  return redis;
}
