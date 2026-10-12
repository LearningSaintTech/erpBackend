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
  const { default: app, corsOptions } = await import('../app.js');
  const { env } = await import('../config/env.js');
  const http = await import('http');
  const { Server } = await import('socket.io');
  const { initRealtime } = await import('../shared/services/realtime.js');
  const { initChatSocket } = await import('../modules/chat/chat.socket.js');
  // env.js was already evaluated by this file's static imports (seed.js → … → env.js), so it
  // captured MONGODB_URI from .env. Point it at the in-memory server explicitly — otherwise
  // "dev:mem" would connect to (and seed) whatever database .env names.
  env.mongodbUri = uri;

  await connectDatabase();

  await seedIfEmpty();

  // Opt-in performance dataset (in-memory only): SEED_LARGE=true npm run dev:mem
  if (process.env.SEED_LARGE === 'true') {
    const { seedLarge, isLocalMongoUri } = await import('./seed-large.js');
    if (!isLocalMongoUri(uri)) throw new Error('SEED_LARGE refused: database is not local');
    await seedLarge();
  }

  // Same realtime wiring as src/index.js, so live notifications and chat work locally too.
  const server = http.createServer(app);
  const io = new Server(server, { cors: corsOptions });
  initRealtime(io);
  initChatSocket(io);

  server.listen(env.port, () => {
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
