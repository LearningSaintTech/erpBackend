/**
 * Move RM stock from WH-RM-01 Z2 bin into WH-01 Z2 bin (the Sites & layout
 * location users browse), so bin stock is visible on WH-01 → Zone 2.
 */
import mongoose from 'mongoose';
import { connectDatabase } from '../config/database.js';
import { Warehouse } from '../modules/warehouse/warehouse.model.js';
import { StorageBin } from '../modules/warehouse/storageBin.model.js';
import { InventoryBalance } from '../modules/inventory/inventoryBalance.model.js';
import { applySoftDeleteFilter } from '../shared/utils/schema.js';
import '../modules/inventory/material.model.js';
import * as warehouseService from '../modules/warehouse/warehouse.service.js';

await connectDatabase();

const whFg = await Warehouse.findOne(applySoftDeleteFilter({ warehouseCode: 'WH-01' }));
const whRm = await Warehouse.findOne(applySoftDeleteFilter({ warehouseCode: 'WH-RM-01' }));
if (!whFg || !whRm) throw new Error('WH-01 or WH-RM-01 missing');

const target = await StorageBin.findOne(applySoftDeleteFilter({
  warehouseId: whFg._id,
  binCode: 'R-1-S-1',
  zoneCode: 'Z2',
}));
const source = await StorageBin.findOne(applySoftDeleteFilter({
  warehouseId: whRm._id,
  binCode: 'R-1-S-1',
}));
if (!target || !source) throw new Error('Source or target Z2 bin missing');

const balances = await InventoryBalance.find({
  storageBinId: source._id,
  inventoryType: 'RAW_MATERIAL',
  isDeleted: { $ne: true },
  onHand: { $gt: 0 },
});

let moved = 0;
for (const b of balances) {
  b.storageBinId = target._id;
  b.locationId = target._id;
  await b.save();
  moved += 1;
}

console.log(`Moved ${moved} RM balances → WH-01 Z2 / R-1-S-1`);
const contents = await warehouseService.getBinContents(whFg.factoryId, target._id);
console.log('WH-01 Z2 bin now has', contents.rawMaterials?.length, 'raw materials');
await mongoose.disconnect();
