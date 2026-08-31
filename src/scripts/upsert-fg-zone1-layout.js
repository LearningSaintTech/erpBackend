/**
 * Seed FG warehouse Zone 1 layout from inventory sheet conventions:
 *   R-11 = rack 11, S-8 = shelf 8, all under Zone 1.
 *
 * Creates WH-FG-01 → Zone Z1 → racks R-1..R-20 → shelves S-1..S-8
 * and one bin per shelf (binCode Z1-R{n}-S{m}).
 *
 * Usage: node src/scripts/upsert-fg-zone1-layout.js
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

const RACK_COUNT = 20; // sheet uses up to R-20 (R-18 unused in data)
const SHELF_COUNT = 8; // user: shelves go to S-8
const ZONE_CODE = 'Z1';
const ZONE_NAME = 'Zone 1';

async function main() {
  await connectDatabase();

  const org = await Organization.findOne({ code: 'DEMO' });
  if (!org) throw new Error('Organization DEMO not found — run seed first');
  const factory = await Factory.findOne({ organizationId: org._id, code: 'F01' });
  if (!factory) throw new Error('Factory F01 not found — run seed first');
  const admin = await User.findOne({ email: 'admin@demo.local' })
    || await User.findOne({ organizationId: org._id });
  if (!admin) throw new Error('No admin user found');

  let wh = await Warehouse.findOne(applySoftDeleteFilter({
    factoryId: factory._id,
    warehouseCode: 'WH-FG-01',
  }));
  if (!wh) {
    wh = await warehouseService.createWarehouse({
      organizationId: org._id,
      factoryId: factory._id,
      warehouseCode: 'WH-FG-01',
      name: 'Finished Goods Store',
      type: 'FINISHED_GOODS',
      isDefault: true,
    }, admin._id);
    console.log('Created warehouse WH-FG-01');
  } else {
    console.log(`Using warehouse ${wh.warehouseCode}`);
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
    console.log(`Created zone ${ZONE_CODE} (${ZONE_NAME})`);
  } else {
    console.log(`Using zone ${zone.zoneCode}`);
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

      const binCode = `${ZONE_CODE}-${rackCode}-${shelfCode}`;
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
          zoneCode: ZONE_CODE,
          binCode,
          barcode: binCode,
        }, admin._id);
        binsCreated += 1;
      }
    }
  }

  const rackTotal = await Rack.countDocuments(applySoftDeleteFilter({ factoryId: factory._id, zoneId: zone._id }));
  const shelfTotal = await Shelf.countDocuments({
    factoryId: factory._id,
    rackId: { $in: (await Rack.find(applySoftDeleteFilter({ factoryId: factory._id, zoneId: zone._id })).select('_id')).map((x) => x._id) },
    isDeleted: { $ne: true },
  });
  const binTotal = await StorageBin.countDocuments(applySoftDeleteFilter({
    factoryId: factory._id,
    warehouseId: wh._id,
    zoneId: zone._id,
  }));

  console.log(`\nDone.`);
  console.log(`  created: racks=${racksCreated} shelves=${shelvesCreated} bins=${binsCreated}`);
  console.log(`  totals in ${ZONE_CODE}: racks=${rackTotal} shelves=${shelfTotal} bins=${binTotal}`);
  console.log(`  example location: R-11 / S-8 → bin ${ZONE_CODE}-R-11-S-8`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
