process.env.SEED_PROFILE = 'rbac';
import { runSeedCli } from './seed.js';

runSeedCli().catch((err) => {
  console.error(err);
  process.exit(1);
});
