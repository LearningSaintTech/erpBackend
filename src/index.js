import http from 'http';
import { Server } from 'socket.io';
import app, { corsOptions } from './app.js';
import { env } from './config/env.js';
import { connectDatabase } from './config/database.js';
import { User } from './modules/user/user.model.js';
import { runSeed } from './scripts/seed.js';
import { initRealtime } from './shared/services/realtime.js';
import { initChatSocket } from './modules/chat/chat.socket.js';

async function start() {
  await connectDatabase();

  const userCount = await User.countDocuments();
  const shouldSeed = userCount === 0 || process.env.SEED_ON_START === 'true';
  if (shouldSeed) {
    if (userCount === 0) {
      console.log('Empty database — seeding conditions (RBAC + workflow fixtures)...');
    } else {
      console.log('SEED_ON_START=true — refreshing RBAC seed...');
    }
    await runSeed();
  }

  const httpServer = http.createServer(app);
  const io = new Server(httpServer, { cors: corsOptions });
  initRealtime(io);
  initChatSocket(io);

  httpServer.listen(env.port, () => {
    console.log(`API running on http://localhost:${env.port}`);
    if (!shouldSeed) {
      console.log('Tip: run `npm run seed:rbac` for users/roles only, or `npm run seed:demo` for full demo');
    }
  });
}

start().catch((err) => {
  if (err.name === 'MongooseServerSelectionError') {
    console.error(`Cannot connect to MongoDB at ${env.mongodbUri}`);
    console.error('Options:');
    console.error('  1. Start MongoDB on port 27017, then run: npm run dev');
    console.error('  2. No MongoDB installed? Use in-memory dev mode: npm run dev:mem');
  } else {
    console.error('Failed to start:', err);
  }
  process.exit(1);
});