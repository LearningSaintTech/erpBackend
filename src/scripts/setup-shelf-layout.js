/**
 * Lay out racks and shelves in one zone, each shelf with its whole-shelf bin.
 *
 * Dry run by default (writes nothing). Safe to re-run: existing racks/shelves/bins are kept,
 * only what is missing is created. Never reads .env — pass the database explicitly.
 *
 *   node src/scripts/setup-shelf-layout.js --uri="mongodb+srv://…/erpBackend" --warehouse=wa-01 --zone=z1 --racks=18 --shelves=3
 *   …same command… --apply
 *
 * Codes: racks R01…R18, shelves R01-S1…R01-S3, whole-shelf bins R01-S1… (same as the shelf code).
 */
import mongoose from 'mongoose';
import { Warehouse } from '../modules/warehouse/warehouse.model.js';
import { Zone } from '../modules/warehouse/zone.model.js';
import { Rack } from '../modules/warehouse/rack.model.js';
import { Shelf } from '../modules/warehouse/shelf.model.js';
import { StorageBin } from '../modules/warehouse/storageBin.model.js';
import * as warehouseExt from '../modules/warehouse/warehouseExtended.service.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.length ? v.join('=') : true];
}));
const uri = args.uri || process.env.SETUP_URI;
if (!uri) {
  console.error('Refusing to run: pass the database explicitly with --uri=… (this script never reads .env).');
  process.exit(1);
}
const apply = args.apply === true;
const warehouseCode = args.warehouse;
const zoneCode = args.zone;
const rackCount = Number(args.racks);
const shelfCount = Number(args.shelves);
const rackPrefix = args['rack-prefix'] || 'R';
if (!warehouseCode || !zoneCode || !(rackCount > 0) || !(shelfCount > 0)) {
  console.error('Usage: --uri=… --warehouse=<code> --zone=<code> --racks=<n> --shelves=<n per rack> [--rack-prefix=R] [--apply]');
  process.exit(1);
}

const pad = String(rackCount).length < 2 ? 2 : String(rackCount).length;
const live = { isDeleted: { $ne: true } };

async function main() {
  await mongoose.connect(uri);
  const whs = await Warehouse.find({ warehouseCode, ...live });
  if (whs.length !== 1) throw new Error(`Expected exactly one warehouse "${warehouseCode}", found ${whs.length}`);
  const wh = whs[0];
  const zone = await Zone.findOne({ factoryId: wh.factoryId, warehouseId: wh._id, zoneCode, ...live });
  if (!zone) throw new Error(`Zone "${zoneCode}" not found in ${warehouseCode}`);
  const userId = wh.updatedBy || wh.createdBy;
  const base = { factoryId: wh.factoryId, organizationId: wh.organizationId };

  console.log(`${apply ? 'APPLYING' : 'DRY RUN (nothing is written)'} — ${warehouseCode} / zone ${zoneCode}: ${rackCount} racks × ${shelfCount} shelves\n`);
  const plan = { racks: 0, shelves: 0, bins: 0, skipped: [] };

  for (let r = 1; r <= rackCount; r += 1) {
    const rackCode = `${rackPrefix}${String(r).padStart(pad, '0')}`;
    let rack = await Rack.findOne({ ...base, zoneId: zone._id, rackCode, ...live });
    if (!rack) {
      plan.racks += 1;
      if (apply) rack = await warehouseExt.createRack({ ...base, zoneId: zone._id, rackCode, name: `Rack ${rackCode}` }, userId);
    }
    for (let s = 1; s <= shelfCount; s += 1) {
      const shelfCode = `${rackCode}-S${s}`;
      const binCode = warehouseExt.shelfBinCode(rackCode, shelfCode);
      let shelf = rack && await Shelf.findOne({ ...base, rackId: rack._id, shelfCode, ...live });
      const hasShelfBin = shelf && await StorageBin.exists({ ...base, shelfId: shelf._id, isShelfBin: true, ...live });
      const codeTaken = !hasShelfBin && await StorageBin.exists({ ...base, warehouseId: wh._id, binCode, ...live });
      if (!shelf) plan.shelves += 1;
      if (!hasShelfBin) {
        if (codeTaken) plan.skipped.push(`${binCode}: a different bin already uses this code — whole-shelf bin not created`);
        else plan.bins += 1;
      }
      if (!apply) continue;
      if (!shelf) {
        const created = await warehouseExt.createShelf({ ...base, rackId: rack._id, shelfCode }, userId);
        shelf = await Shelf.findById(created._id);
      } else if (!hasShelfBin) {
        await warehouseExt.ensureShelfBin(shelf, rack, userId);
      }
    }
  }

  console.log(`racks to create:   ${plan.racks}`);
  console.log(`shelves to create: ${plan.shelves}`);
  console.log(`whole-shelf bins:  ${plan.bins}`);
  if (plan.skipped.length) console.log(`\nskipped:\n  ${plan.skipped.join('\n  ')}`);
  console.log(apply ? '\nDone.' : '\nNothing written. Re-run with --apply to create these.');
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('Setup failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
