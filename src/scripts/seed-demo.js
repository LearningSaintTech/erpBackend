process.env.SEED_PROFILE = 'heavy';
import { runSeedCli } from './seed.js';

runSeedCli().catch((err) => {
  console.error(err);
  process.exit(1);
});
