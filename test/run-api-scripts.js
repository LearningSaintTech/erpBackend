/**
 * Runs the existing HTTP-level scripts (smoke / rbac / security) with a safe environment:
 * in-memory Mongo only, no Redis, no e-mail. Cross-platform replacement for
 * `REDIS_URL= AUTH_PHONE_OTP_ONLY=false MONGODB_URI=mongodb://127.0.0.1:1/none EMAIL_NOTIFICATIONS=false npm run …`.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = {
  ...process.env,
  REDIS_URL: '',
  AUTH_PHONE_OTP_ONLY: 'false',
  MONGODB_URI: 'mongodb://127.0.0.1:1/none',
  EMAIL_NOTIFICATIONS: 'false',
  DISABLE_RATE_LIMIT: 'true',
};

const scripts = [
  'src/scripts/smoke-test.js',
  'src/scripts/rbac-test.js',
  'src/scripts/security-regression-test.js',
];

let failed = 0;
for (const script of scripts) {
  console.log(`\n▶ ${script}`);
  const res = spawnSync(process.execPath, [script], { cwd: root, env, stdio: 'inherit' });
  if (res.status !== 0) {
    failed += 1;
    console.error(`✖ ${script} exited with ${res.status ?? res.signal}`);
  } else {
    console.log(`✔ ${script}`);
  }
}
process.exit(failed ? 1 : 0);
