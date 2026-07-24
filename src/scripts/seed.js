import { connectDatabase } from '../config/database.js';
import { runSeed } from './seed/index.js';
import mongoose from 'mongoose';

export { runSeed };

export async function runSeedCli() {
  await connectDatabase();
  await runSeed();
  await mongoose.disconnect();
}

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('/scripts/seed.js');
if (isMain) {
  runSeedCli().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
