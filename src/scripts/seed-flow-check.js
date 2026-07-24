/**
 * Post-seed integration check for inventory → warehouse → sampling → production → QC flow.
 */
import { connectDatabase } from '../config/database.js';
import mongoose from 'mongoose';
import { Factory } from '../modules/organization/factory.model.js';
import { Material } from '../modules/inventory/material.model.js';
import { InventoryBalance } from '../modules/inventory/inventoryBalance.model.js';
import { StockReservation } from '../modules/inventory/stockReservation.model.js';
import { Warehouse } from '../modules/warehouse/warehouse.model.js';
import { Zone } from '../modules/warehouse/zone.model.js';
import { StorageBin } from '../modules/warehouse/storageBin.model.js';
import { GoodsReceipt } from '../modules/purchase/goodsReceipt.model.js';
import { Sample } from '../modules/sampling/sample.model.js';
import { ProductionOrder } from '../modules/production/productionOrder.model.js';
import { QualityInspection } from '../modules/quality/qualityInspection.model.js';
import { aggregateRmTotals } from '../modules/inventory/inventoryStock.service.js';

const checks = [];

function pass(name, detail) {
  checks.push({ ok: true, name, detail });
  console.log(`✓ ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name, detail) {
  checks.push({ ok: false, name, detail });
  console.log(`✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  await connectDatabase();
  const factory = await Factory.findOne({ code: 'F01' });
  if (!factory) {
    fail('Factory F01', 'not found — run seed first');
    process.exit(1);
  }

  const materialCount = await Material.countDocuments({ factoryId: factory._id, isDeleted: false });
  materialCount > 0
    ? pass('Materials seeded', `${materialCount} active`)
    : fail('Materials seeded', 'none');

  const balanceRows = await InventoryBalance.find({
    factoryId: factory._id,
    inventoryType: 'RAW_MATERIAL',
    isDeleted: false,
  });
  const unalloc = balanceRows.filter((b) => !b.storageBinId);
  const inBins = balanceRows.filter((b) => b.storageBinId && b.onHand > 0);
  balanceRows.length > 0
    ? pass('RM balance rows', `${balanceRows.length} rows (${unalloc.length} unallocated pools, ${inBins.length} bin rows with stock)`)
    : fail('RM balance rows', 'none');

  const fabric = await Material.findOne({ factoryId: factory._id, materialCode: 'FAB-COT-001' });
  if (fabric) {
    const totals = await aggregateRmTotals(factory._id, fabric._id);
    totals.onHand > 0
      ? pass('Fabric stock (aggregated)', `onHand=${totals.onHand} avail=${totals.available} reserved=${totals.reserved}`)
      : fail('Fabric stock', 'zero on hand');
  } else {
    fail('Fabric FAB-COT-001', 'missing');
  }

  const whCount = await Warehouse.countDocuments({ factoryId: factory._id, isDeleted: false });
  const rmWh = await Warehouse.findOne({ factoryId: factory._id, type: 'RAW_MATERIAL', isDefault: true });
  const fgWh = await Warehouse.findOne({ factoryId: factory._id, type: 'FINISHED_GOODS' });
  whCount >= 2
    ? pass('Warehouses', `${whCount} (RM=${rmWh?.warehouseCode || '?'}, FG=${fgWh?.warehouseCode || '?'})`)
    : fail('Warehouses', `only ${whCount}`);

  const zoneCount = await Zone.countDocuments({ factoryId: factory._id, isDeleted: false });
  const binCount = await StorageBin.countDocuments({ factoryId: factory._id, isDeleted: false });
  const binsWithZone = await StorageBin.countDocuments({ factoryId: factory._id, zoneId: { $ne: null }, isDeleted: false });
  zoneCount > 0 && binCount > 0
    ? pass('Zones & bins', `${zoneCount} zones, ${binCount} bins (${binsWithZone} linked to zoneId)`)
    : fail('Zones & bins', `zones=${zoneCount} bins=${binCount}`);

  const grnCompleted = await GoodsReceipt.countDocuments({ factoryId: factory._id, status: 'COMPLETED', isDeleted: false });
  const grnPendingQc = await GoodsReceipt.countDocuments({ factoryId: factory._id, status: 'PENDING_QC', isDeleted: false });
  grnCompleted > 0
    ? pass('Purchase GRN → QC', `${grnCompleted} completed, ${grnPendingQc} pending QC`)
    : fail('Purchase GRN → QC', 'no completed GRN');

  const incomingQc = await QualityInspection.countDocuments({
    factoryId: factory._id,
    inspectionType: 'INCOMING',
    status: 'COMPLETED',
    isDeleted: false,
  });
  incomingQc > 0
    ? pass('Incoming QC inspections', `${incomingQc} completed`)
    : fail('Incoming QC', 'none completed');

  const samples = await Sample.find({ factoryId: factory._id, isDeleted: false }).select('sampleCode status').lean();
  const byStatus = samples.reduce((acc, s) => { acc[s.status] = (acc[s.status] || 0) + 1; return acc; }, {});
  samples.length > 0
    ? pass('Samples', `${samples.length} total — ${JSON.stringify(byStatus)}`)
    : fail('Samples', 'none');

  const storeHandoff = samples.find((s) =>
    ['MATERIAL_REQUEST_APPROVED', 'MATERIAL_RESERVED'].includes(s.status));
  if (storeHandoff) {
    pass('Store-keeper handoff sample', `${storeHandoff.sampleCode} @ ${storeHandoff.status}`);
  } else {
    pass('Store-keeper handoff', 'no pending sample (all issued or not yet submitted)');
  }

  const activeRes = await StockReservation.countDocuments({ factoryId: factory._id, status: 'ACTIVE', isDeleted: false });
  pass('Active reservations', String(activeRes));

  const prodReserved = await ProductionOrder.countDocuments({
    factoryId: factory._id,
    status: { $in: ['MATERIAL_RESERVED', 'APPROVED', 'IN_PROGRESS'] },
    isDeleted: false,
  });
  prodReserved > 0
    ? pass('Production orders with materials', `${prodReserved} at reserved+`)
    : pass('Production orders', 'none yet — demo SKU may need re-seed after sample APPROVED');

  const failures = checks.filter((c) => !c.ok);
  console.log(`\n=== Flow check: ${checks.length - failures.length}/${checks.length} passed ===`);
  if (failures.length) {
    failures.forEach((f) => console.log(`  FAIL: ${f.name} — ${f.detail}`));
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log('All flow checks passed.');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
