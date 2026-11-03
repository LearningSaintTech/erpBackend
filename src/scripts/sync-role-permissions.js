/**
 * Add permissions that the code now gives a system role (config/systemRoles.js) but an existing
 * database's copy of that role is missing — e.g. QUALITY_INSPECTOR gaining warehouse.read.
 *
 * Add-only: never removes a permission, so changes a factory admin made to a role are kept.
 * Dry run by default (writes nothing). Never reads .env — pass the database explicitly.
 *   node src/scripts/sync-role-permissions.js --uri="mongodb+srv://…/erpBackend"
 *   …same command… --apply
 */
import mongoose from 'mongoose';
import { SYSTEM_ROLES } from '../config/systemRoles.js';

const args = process.argv.slice(2);
const uriArg = args.find((a) => a.startsWith('--uri='));
const uri = uriArg ? uriArg.slice('--uri='.length) : process.env.SYNC_URI;
const apply = args.includes('--apply');
if (!uri) {
  console.error('Refusing to run: pass the database explicitly with --uri=… (this script never reads .env).');
  process.exit(1);
}

async function main() {
  await mongoose.connect(uri);
  const roles = mongoose.connection.db.collection('roles');
  console.log(apply ? 'APPLYING — adding missing permissions\n' : 'DRY RUN (nothing is written)\n');
  let changed = 0;
  for (const def of SYSTEM_ROLES) {
    const docs = await roles.find({ code: def.code, isDeleted: { $ne: true } }).toArray();
    for (const doc of docs) {
      const have = new Set(doc.permissions || []);
      const missing = def.permissions.filter((p) => !have.has(p));
      if (!missing.length) continue;
      changed += 1;
      console.log(`  ${def.code} (${doc._id}): + ${missing.join(', ')}`);
      if (apply) {
        await roles.updateOne({ _id: doc._id }, { $addToSet: { permissions: { $each: missing } }, $set: { updatedAt: new Date() } });
      }
    }
  }
  console.log(changed
    ? `\n${changed} role(s) ${apply ? 'updated' : 'would be updated'}.${apply ? ' Users get the new access on their next login / token refresh.' : ' Re-run with --apply to write.'}`
    : '\nAll system roles already have their permissions — nothing to do.');
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('Sync failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
