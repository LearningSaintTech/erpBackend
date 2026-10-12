/**
 * Read-only pre-deploy check: users sharing a phone number.
 *
 * The unique index on users.phone (partial: non-empty strings) could never be built before,
 * so production may already hold duplicates — and the index build will fail until they are
 * resolved (give one of the users a different number, or clear it).
 *
 * Never reads .env — pass the database explicitly. Writes nothing.
 *   node src/scripts/check-duplicate-phones.js --uri="mongodb+srv://…/erpBackend"
 */
import mongoose from 'mongoose';

const arg = process.argv.slice(2).find((a) => a.startsWith('--uri='));
const uri = arg ? arg.slice('--uri='.length) : process.env.CHECK_URI;
if (!uri) {
  console.error('Refusing to run: pass the database explicitly with --uri=… (this script never reads .env).');
  process.exit(1);
}

async function main() {
  await mongoose.connect(uri);
  const users = mongoose.connection.db.collection('users');
  const dupes = await users.aggregate([
    { $match: { phone: { $type: 'string', $gt: '' } } },
    {
      $group: {
        _id: '$phone',
        count: { $sum: 1 },
        users: { $push: { email: '$email', name: { $concat: [{ $ifNull: ['$firstName', ''] }, ' ', { $ifNull: ['$lastName', ''] }] }, deleted: '$isDeleted' } },
      },
    },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } },
  ]).toArray();

  if (!dupes.length) {
    console.log('No duplicate phone numbers — the unique phone index will build cleanly.');
  } else {
    console.log(`${dupes.length} phone number(s) are shared by more than one user. Resolve these before deploying:\n`);
    for (const d of dupes) {
      console.log(`  ${d._id}:`);
      for (const u of d.users) console.log(`    - ${u.name.trim() || '(no name)'} <${u.email}>${u.deleted ? ' [deleted]' : ''}`);
    }
    process.exitCode = 2;
  }
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('Check failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
