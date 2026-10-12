/**
 * Must be the FIRST import of every test file (directly or via db.js).
 *
 * src/config/env.js calls dotenv.config(), and backend/.env points at a PRODUCTION Atlas DB.
 * dotenv never overrides a variable that is already present in process.env, so pinning these
 * before any src/ module is evaluated keeps tests away from real infrastructure. The tests
 * also never call connectDatabase(); they connect mongoose to a MongoMemoryServer themselves.
 */
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:1/erp-tests-must-never-use-this';
process.env.REDIS_URL = '';
process.env.EMAIL_NOTIFICATIONS = 'false';
process.env.AUTH_PHONE_OTP_ONLY = 'false';
process.env.DISABLE_RATE_LIMIT = 'true';
process.env.SMTP_HOST = '';
process.env.S3_BUCKET = '';
process.env.TWOFACTOR_API_KEY = '';
