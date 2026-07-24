import path from 'path';
import { fileURLToPath } from 'url';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { User } from '../modules/user/user.model.js';
import { runSeed } from './seed.js';
import { DEMO_CREDENTIALS_SUMMARY } from '../config/systemRoles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function seedIfEmpty() {  if ((await User.countDocuments()) === 0) {
    console.log('Empty database — seeding demo data...');
    await runSeed();
  }
}

async function start() {
  const mongod = await MongoMemoryServer.create({ instance: { launchTimeout: 120000 } });
  const uri = mongod.getUri();
  process.env.MONGODB_URI = uri;

  const { connectDatabase } = await import('../config/database.js');
  const { default: app } = await import('../app.js');
  const { env } = await import('../config/env.js');

  await connectDatabase();

  await seedIfEmpty();

  const server = app.listen(env.port, () => {
    console.log(`API running on http://localhost:${env.port} (in-memory MongoDB — data resets on restart)`);
    console.log('\n--- Demo credentials ---');
    for (const row of DEMO_CREDENTIALS_SUMMARY) {
      console.log(`${row.role.padEnd(22)} ${row.email.padEnd(32)} ${row.password}`);
    }
    console.log('\nRole accounts (except Super/Factory Admin) use password: Demo@123');
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\nPort ${env.port} is already in use. Stop the other backend process first:`);
      console.error('  netstat -ano | findstr :3000');
      console.error('  taskkill /PID <pid> /F');
      process.exit(1);
    }
    throw err;
  });

  const shutdown = async () => {
    server.close();
    await mongoose.disconnect();
    await mongod.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
