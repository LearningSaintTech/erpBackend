/**
 * Ensure RM + FG warehouses exist, then feed Zone 1 and Zone 2 with
 * racks R-1..R-20 → shelves S-1..S-8 → one bin per shelf.
 *
 * Usage: node src/scripts/upsert-zones-layout.js
 */
import mongoose from 'mongoose';
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

const RACK_COUNT = 20;
const SHELF_COUNT = 8;
const ZONES = [
  { zoneCode: 'Z1', name: 'Zone 1' },
  { zoneCode: 'Z2', name: 'Zone 2' },
];

const WAREHOUSES = [
  { warehouseCode: 'WH-RM-01', name: 'Raw Material Store', type: 'RAW_MATERIAL', isDefault: true },
  { warehouseCode: 'WH-FG-01', name: 'Finished Goods Store', type: 'FINISHED_GOODS', isDefault: true },
];

async function ensureWarehouse(spec, org, factory, admin) {
  let wh = await Warehouse.findOne(applySoftDeleteFilter({
    factoryId: factory._id,
    warehouseCode: spec.warehouseCode,
  }));
  if (!wh) {
    wh = await warehouseService.createWarehouse({
      organizationId: org._id,
      factoryId: factory._id,
      warehouseCode: spec.warehouseCode,
      name: spec.name,
      type: spec.type,
      isDefault: spec.isDefault,
    }, admin._id);
    console.log(`Created warehouse ${spec.warehouseCode}`);
  } else {
    console.log(`Using warehouse ${wh.warehouseCode}`);
  }
  return wh;
}

async function ensureZoneLayout({ org, factory, admin, wh, zoneCode, zoneName, whToken }) {
  let zone = await Zone.findOne(applySoftDeleteFilter({
    factoryId: factory._id,
    warehouseId: wh._id,
    zoneCode,
  }));
  if (!zone) {
    zone = await warehouseExtended.createZone({
      organizationId: org._id,
      factoryId: factory._id,
      warehouseId: wh._id,
      zoneCode,
      name: zoneName,
    }, admin._id);
    console.log(`  Created zone ${zoneCode} (${zoneName})`);
  } else {
    console.log(`  Using zone ${zone.zoneCode}`);
  }

  let racksCreated = 0;
  let shelvesCreated = 0;
  let binsCreated = 0;

  for (let r = 1; r <= RACK_COUNT; r += 1) {
    const rackCode = `R-${r}`;
    let rack = await Rack.findOne(applySoftDeleteFilter({
      factoryId: factory._id,
      zoneId: zone._id,
      rackCode,
    }));
    if (!rack) {
      rack = await warehouseExtended.createRack({
        organizationId: org._id,
        factoryId: factory._id,
        zoneId: zone._id,
        rackCode,
      }, admin._id);
      racksCreated += 1;
    }

    for (let s = 1; s <= SHELF_COUNT; s += 1) {
      const shelfCode = `S-${s}`;
      let shelf = await Shelf.findOne(applySoftDeleteFilter({
        factoryId: factory._id,
        rackId: rack._id,
        shelfCode,
      }));
      if (!shelf) {
        shelf = await warehouseExtended.createShelf({
          organizationId: org._id,
          factoryId: factory._id,
          rackId: rack._id,
          shelfCode,
        }, admin._id);
        shelvesCreated += 1;
      }

      // Barcode is unique per factory — include warehouse token
      const binCode = `${whToken}-${zoneCode}-${rackCode}-${shelfCode}`;
      const existingBin = await StorageBin.findOne(applySoftDeleteFilter({
        factoryId: factory._id,
        warehouseId: wh._id,
        binCode,
      }));
      if (!existingBin) {
        await warehouseService.createStorageBin({
          organizationId: org._id,
          factoryId: factory._id,
          warehouseId: wh._id,
          zoneId: zone._id,
          rackId: rack._id,
          shelfId: shelf._id,
          zoneCode,
          binCode,
          barcode: binCode,
        }, admin._id);
        binsCreated += 1;
      }
    }
  }

  console.log(`    + racks=${racksCreated} shelves=${shelvesCreated} bins=${binsCreated}`);
  return zone;
}

async function main() {
  await connectDatabase();

  const org = await Organization.findOne({ code: 'DEMO' });
  if (!org) throw new Error('Organization DEMO not found — run seed first');
  const factory = await Factory.findOne({ organizationId: org._id, code: 'F01' });
  if (!factory) throw new Error('Factory F01 not found — run seed first');
  const admin = await User.findOne({ email: 'admin@demo.local' })
    || await User.findOne({ organizationId: org._id });
  if (!admin) throw new Error('No admin user found');

  console.log('\n=== Feed Zone 1 + Zone 2 ===\n');

  // Remove legacy bins from the first run (barcode without WH prefix collided across warehouses)
  const legacy = await StorageBin.deleteMany({
    binCode: { $regex: /^Z[12]-R-\d+-S-\d+$/ },
  });
  if (legacy.deletedCount) {
    console.log(`Removed ${legacy.deletedCount} legacy duplicate bins (Z1/Z2 without WH prefix)\n`);
  }

  for (const spec of WAREHOUSES) {
    const wh = await ensureWarehouse(spec, org, factory, admin);
    const whToken = spec.type === 'FINISHED_GOODS' ? 'FG' : 'RM';
    for (const z of ZONES) {
      await ensureZoneLayout({
        org,
        factory,
        admin,
        wh,
        zoneCode: z.zoneCode,
        zoneName: z.name,
        whToken,
      });
    }
  }

  console.log('\nDone. Zone 1 (Z1) and Zone 2 (Z2) are ready on WH-RM-01 and WH-FG-01.');
  console.log('Example bins: RM-Z1-R-11-S-8 · FG-Z1-R-11-S-8\n');

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
