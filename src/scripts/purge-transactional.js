/**
 * Purge all operational / demo data while keeping:
 * - Users (ids, password hashes)
 * - Roles + permissions + role assignments
 * - Organizations / factories (required for login)
 * - Factory settings
 *
 * Sessions and everything else (designs, inventory, POs, warehouses, chat, …)
 * are cleared so users must log in again.
 *
 * Usage: node src/scripts/purge-transactional.js
 */
import mongoose from 'mongoose';
import { connectDatabase } from '../config/database.js';

/** Collections to keep (MongoDB pluralized / lowercase names). */
const KEEP = new Set([
  'permissions',
  'roles',
  'users',
  'userroleassignments',
  'organizations',
  'factories',
  'factorysettings',
]);

async function purge() {
  await connectDatabase();
  const db = mongoose.connection.db;
  const cols = await db.listCollections().toArray();
  const names = cols.map((c) => c.name).sort();

  console.log('\n=== Purge transactional data ===\n');
  console.log(`Keep: ${[...KEEP].filter((n) => !n.startsWith('system.')).join(', ')}`);

  let cleared = 0;
  let kept = 0;

  for (const name of names) {
    if (KEEP.has(name) || name.startsWith('system.')) {
      const count = await db.collection(name).countDocuments();
      console.log(`  KEEP  ${name.padEnd(28)} (${count} docs)`);
      kept += 1;
      continue;
    }
    const count = await db.collection(name).countDocuments();
    await db.collection(name).deleteMany({});
    console.log(`  CLEAR ${name.padEnd(28)} (removed ${count})`);
    cleared += 1;
  }

  console.log(`\nDone. Cleared ${cleared} collections; kept ${kept}.`);
  console.log('Users, roles, passwords, org/factory, and settings were preserved.');
  console.log('Sessions were cleared — log in again at http://localhost:5173/login\n');

  await mongoose.disconnect();
}

purge().catch((err) => {
  console.error(err);
  process.exit(1);
});
