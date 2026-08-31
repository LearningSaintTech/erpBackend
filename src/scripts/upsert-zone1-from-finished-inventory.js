/**
 * Build Zone 1 layout from finished-inventory.import.json:
 *   rack (R-n) → shelf (S-n) → bin = size (XS/S/M/…)
 *
 * Bin codes: {rack}-{shelf}-{size}  e.g. R-19-S-4-XS
 * Capacity: sum of quantities for that size at that location.
 *
 * Usage: node src/scripts/upsert-zone1-from-finished-inventory.js
 */
import mongoose from 'mongoose';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { connectDatabase } from '../config/database.js';
import { Organization } from '../modules/organization/organization.model.js';
import { Factory } from '../modules/organization/factory.model.js';
import { User } from '../modules/user/user.model.js';
import { Warehouse } from '../modules/warehouse/warehouse.model.js';
import { Zone } from '../modules/warehouse/zone.model.js';
import { Rack } from '../modules/warehouse/rack.model.js';
import { Shelf } from '../modules/warehouse/shelf.model.js';
import { StorageBin } from '../modules/warehouse/storageBin.model.js';
import * as warehouseService from '../modules/warehouse/warehouse.service.js';
import * as warehouseExtended from '../modules/warehouse/warehouseExtended.service.js';
import { applySoftDeleteFilter } from '../shared/utils/schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, '../data/finished-inventory.import.json');
const ZONE_CODE = 'Z1';
const ZONE_NAME = 'Zone 1';

function extractLayout(rows) {
  /** @type {Map<string, { rack: string, shelf: string, size: string, capacity: number }>} */
  const bins = new Map();

  for (const row of rows) {
    const zone = String(row.zoneCode || 'ZONE1').toUpperCase().replace(/\s+/g, '');
    if (zone !== 'ZONE1' && zone !== 'Z1') continue;

    for (const [size, locs] of Object.entries(row.sizeLocations || {})) {
      if (!size || !Array.isArray(locs)) continue;
      const qty = Number(row.quantities?.[size]) || 0;
      for (const loc of locs) {
        const rack = String(loc.rack || '').trim();
        const shelf = String(loc.shelf || '').trim();
        if (!/^R-\d+$/i.test(rack) || !/^S-\d+$/i.test(shelf)) continue;
        const key = `${rack}|${shelf}|${size}`;
        const cur = bins.get(key) || { rack, shelf, size, capacity: 0 };
        cur.capacity += qty;
        bins.set(key, cur);
      }
    }
  }

  return [...bins.values()].sort((a, b) => {
    const rn = Number(a.rack.split('-')[1]) - Number(b.rack.split('-')[1]);
    if (rn) return rn;
    const sn = Number(a.shelf.split('-')[1]) - Number(b.shelf.split('-')[1]);
    if (sn) return sn;
    return a.size.localeCompare(b.size);
  });
}

async function main() {
  await connectDatabase();

  const rows = JSON.parse(readFileSync(DATA_PATH, 'utf8'));
  const layout = extractLayout(rows);
  if (!layout.length) throw new Error('No rack/shelf/size locations found in import file');

  const org = await Organization.findOne({ code: 'DEMO' });
  if (!org) throw new Error('Organization DEMO not found');
  const factory = await Factory.findOne({ organizationId: org._id, code: 'F01' });
  if (!factory) throw new Error('Factory F01 not found');
  const admin = await User.findOne({ email: 'admin@demo.local' })
    || await User.findOne({ organizationId: org._id });
  if (!admin) throw new Error('No admin user found');

  let wh = await Warehouse.findOne(applySoftDeleteFilter({
    factoryId: factory._id,
    warehouseCode: 'WH-01',
  }));
  if (!wh) {
    wh = await warehouseService.createWarehouse({
      organizationId: org._id,
      factoryId: factory._id,
      warehouseCode: 'WH-01',
      name: 'Main Warehouse',
      type: 'FINISHED_GOODS',
      isDefault: true,
    }, admin._id);
    console.log('Created warehouse WH-01');
  } else if (wh.type !== 'FINISHED_GOODS') {
    wh.type = 'FINISHED_GOODS';
    wh.name = wh.name || 'Main Warehouse';
    await wh.save();
    console.log('Updated WH-01 type → FINISHED_GOODS');
  } else {
    console.log('Using warehouse WH-01');
  }

  let zone = await Zone.findOne(applySoftDeleteFilter({
    factoryId: factory._id,
    warehouseId: wh._id,
    zoneCode: ZONE_CODE,
  }));
  if (!zone) {
    zone = await warehouseExtended.createZone({
      organizationId: org._id,
      factoryId: factory._id,
      warehouseId: wh._id,
      zoneCode: ZONE_CODE,
      name: ZONE_NAME,
    }, admin._id);
    console.log(`Created zone ${ZONE_CODE}`);
  } else {
    console.log(`Using zone ${ZONE_CODE}`);
  }

  const rackCache = new Map();
  const shelfCache = new Map();
  let racksCreated = 0;
  let shelvesCreated = 0;
  let binsCreated = 0;
  let binsUpdated = 0;

  for (const item of layout) {
    let rack = rackCache.get(item.rack);
    if (!rack) {
      rack = await Rack.findOne(applySoftDeleteFilter({
        factoryId: factory._id,
        zoneId: zone._id,
        rackCode: item.rack,
      }));
      if (!rack) {
        rack = await warehouseExtended.createRack({
          organizationId: org._id,
          factoryId: factory._id,
          zoneId: zone._id,
          rackCode: item.rack,
        }, admin._id);
        racksCreated += 1;
      }
      rackCache.set(item.rack, rack);
    }

    const shelfKey = `${item.rack}|${item.shelf}`;
    let shelf = shelfCache.get(shelfKey);
    if (!shelf) {
      shelf = await Shelf.findOne(applySoftDeleteFilter({
        factoryId: factory._id,
        rackId: rack._id,
        shelfCode: item.shelf,
      }));
      if (!shelf) {
        shelf = await warehouseExtended.createShelf({
          organizationId: org._id,
          factoryId: factory._id,
          rackId: rack._id,
          shelfCode: item.shelf,
        }, admin._id);
        shelvesCreated += 1;
      }
      shelfCache.set(shelfKey, shelf);
    }

    // Bin identity = size at this rack/shelf (unique within warehouse)
    const binCode = `${item.rack}-${item.shelf}-${item.size}`;
    let bin = await StorageBin.findOne(applySoftDeleteFilter({
      factoryId: factory._id,
      warehouseId: wh._id,
      binCode,
    }));
    if (!bin) {
      await warehouseService.createStorageBin({
        organizationId: org._id,
        factoryId: factory._id,
        warehouseId: wh._id,
        zoneId: zone._id,
        rackId: rack._id,
        shelfId: shelf._id,
        zoneCode: ZONE_CODE,
        binCode,
        barcode: `WH01-${binCode}`,
        capacity: item.capacity || undefined,
      }, admin._id);
      binsCreated += 1;
    } else {
      let dirty = false;
      if (bin.capacity !== item.capacity) {
        bin.capacity = item.capacity;
        dirty = true;
      }
      if (!bin.rackId || !bin.shelfId || !bin.zoneId) {
        bin.zoneId = zone._id;
        bin.rackId = rack._id;
        bin.shelfId = shelf._id;
        bin.zoneCode = ZONE_CODE;
        dirty = true;
      }
      if (dirty) {
        bin.updatedBy = admin._id;
        await bin.save();
        binsUpdated += 1;
      }
    }
  }

  const rackTotal = await Rack.countDocuments(applySoftDeleteFilter({ factoryId: factory._id, zoneId: zone._id }));
  const binTotal = await StorageBin.countDocuments(applySoftDeleteFilter({
    factoryId: factory._id,
    warehouseId: wh._id,
    zoneId: zone._id,
  }));

  console.log('\nDone — Zone 1 layout from finished inventory');
  console.log(`  unique size-bins extracted: ${layout.length}`);
  console.log(`  created: racks=${racksCreated} shelves=${shelvesCreated} bins=${binsCreated} updated=${binsUpdated}`);
  console.log(`  totals in Z1: racks=${rackTotal} bins=${binTotal}`);
  console.log('  example: R-19 / S-4 / size XS → bin R-19-S-4-XS\n');

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
