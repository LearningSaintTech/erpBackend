/**
 * One-off backfill for orders/batches created before QC results were tracked on them.
 *
 * Rebuilds, from COMPLETED quality inspections:
 *   batch.rejectedQuantity       = Σ failed of IN_PROCESS inspections of the batch
 *   batch.passedQuantity         = Σ passed of FINAL inspections of the batch
 *   batch.finalRejectedQuantity  = Σ failed of FINAL inspections of the batch
 *   order.passedQuantity         = Σ batch.passedQuantity
 *   order.rejectedQuantity       = Σ batch.rejectedQuantity + finalRejectedQuantity
 * (cancelled batches included — their rejects really happened; REWORK inspections post nothing)
 * The same rules the live code uses, so the result is idempotent: a second run changes nothing.
 * It also lists in-progress orders that are now complete (every batch passed final QC and
 * passed ≥ planned) so they can be closed from the app — it does not change statuses itself.
 *
 * Safe by default:
 *   - never reads .env — the database must be given explicitly
 *   - dry run unless --apply is passed
 *
 * Usage:
 *   node src/scripts/backfill-qc-quantities.js --uri="mongodb+srv://…/erpBackend"            # dry run
 *   node src/scripts/backfill-qc-quantities.js --uri="mongodb+srv://…/erpBackend" --apply    # write
 * Take a backup first.
 */
import mongoose from 'mongoose';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.length ? v.join('=') : true];
}));
const uri = typeof args.uri === 'string' ? args.uri : process.env.BACKFILL_URI;
const apply = args.apply === true;

if (!uri) {
  console.error('Refusing to run: pass the database explicitly with --uri=… (this script never reads .env).');
  process.exit(1);
}

const round = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

async function main() {
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  console.log(`Connected to ${db.databaseName} — ${apply ? 'APPLY mode: changes will be written' : 'dry run: nothing is written'}\n`);

  const inspections = db.collection('qualityinspections');
  const batches = db.collection('productionbatches');
  const orders = db.collection('productionorders');

  // Per-batch QC totals from completed inspections.
  const qc = new Map();
  const rows = await inspections.aggregate([
    // REWORK dispositions send the batch back a stage and post no quantities (same as live code).
    {
      $match: {
        referenceType: 'PRODUCTION_BATCH',
        status: 'COMPLETED',
        isDeleted: { $ne: true },
        disposition: { $ne: 'REWORK' },
        result: { $ne: 'REWORK' },
      },
    },
    {
      $group: {
        _id: { batch: '$referenceId', type: '$inspectionType' },
        passed: { $sum: { $ifNull: ['$passedQuantity', 0] } },
        failed: { $sum: { $ifNull: ['$failedQuantity', 0] } },
        count: { $sum: 1 },
      },
    },
  ]).toArray();
  for (const r of rows) {
    const key = String(r._id.batch);
    const e = qc.get(key) || { inProcessFailed: 0, finalPassed: 0, finalFailed: 0, finalCount: 0 };
    if (r._id.type === 'IN_PROCESS') e.inProcessFailed += r.failed;
    if (r._id.type === 'FINAL') { e.finalPassed += r.passed; e.finalFailed += r.failed; e.finalCount += r.count; }
    qc.set(key, e);
  }

  let batchChanges = 0;
  let orderChanges = 0;
  const completable = [];
  const batchOps = [];
  const orderOps = [];

  const allOrders = await orders.find({ isDeleted: { $ne: true }, status: { $ne: 'CANCELLED' } }).toArray();
  for (const order of allOrders) {
    const orderBatches = await batches.find({ productionOrderId: order._id, isDeleted: { $ne: true } }).toArray();
    let passed = 0;
    let rejected = 0;
    let allFinalDone = orderBatches.length > 0;

    for (const b of orderBatches) {
      const e = qc.get(String(b._id)) || { inProcessFailed: 0, finalPassed: 0, finalFailed: 0, finalCount: 0 };
      const want = {
        rejectedQuantity: round(e.inProcessFailed),
        passedQuantity: round(e.finalPassed),
        finalRejectedQuantity: round(e.finalFailed),
      };
      const changed = Object.entries(want).filter(([k, v]) => round(b[k]) !== v);
      if (changed.length) {
        batchChanges += 1;
        console.log(`  batch ${b.batchNumber}: ${changed.map(([k, v]) => `${k} ${b[k] ?? '∅'} → ${v}`).join(', ')}`);
        batchOps.push({ updateOne: { filter: { _id: b._id }, update: { $set: want } } });
      }
      passed += want.passedQuantity;
      rejected += want.rejectedQuantity + want.finalRejectedQuantity;
      if (b.status !== 'CANCELLED' && (b.status !== 'COMPLETED' || !e.finalCount)) allFinalDone = false;
    }

    const wantOrder = { passedQuantity: round(passed), rejectedQuantity: round(rejected) };
    const orderChanged = Object.entries(wantOrder).filter(([k, v]) => round(order[k]) !== v);
    if (orderChanged.length) {
      orderChanges += 1;
      console.log(`order ${order.orderNumber}: ${orderChanged.map(([k, v]) => `${k} ${order[k] ?? '∅'} → ${v}`).join(', ')}`);
      orderOps.push({ updateOne: { filter: { _id: order._id }, update: { $set: wantOrder } } });
    }
    if (order.status === 'IN_PROGRESS' && allFinalDone && wantOrder.passedQuantity >= (order.plannedQuantity || 0)) {
      completable.push(`${order.orderNumber} (passed ${wantOrder.passedQuantity} of ${order.plannedQuantity})`);
    }
  }

  console.log(`\n${batchChanges} batch(es) and ${orderChanges} order(s) ${apply ? 'updated' : 'would change'}.`);
  if (completable.length) {
    console.log(`\nIn-progress orders that are now complete (close them from the app):\n  ${completable.join('\n  ')}`);
  }

  if (apply) {
    if (batchOps.length) await batches.bulkWrite(batchOps);
    if (orderOps.length) await orders.bulkWrite(orderOps);
    console.log('\nDone.');
  } else {
    console.log('\nDry run only. Re-run with --apply to write these changes (after taking a backup).');
  }
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('Backfill failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
