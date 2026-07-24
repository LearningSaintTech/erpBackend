import { connectDatabase } from '../config/database.js';
import mongoose from 'mongoose';
import { isHeavy } from './seed/seedHelpers.js';

const HEAVY_TARGETS = {
  Material: 18,
  Design: 22,
  Sample: 3,
  Sku: 5,
  Bom: 1,
  Supplier: 5,
  PurchaseRequisition: 5,
  PurchaseOrder: 2,
  GoodsReceipt: 2,
  Rfq: 1,
  Quotation: 2,
  ProductionOrder: 2,
  ProductionBatch: 2,
  ProductionSchedule: 6,
  Warehouse: 3,
  StorageBin: 12,
  Zone: 3,
  DefectCategory: 10,
  QualityInspection: 3,
  Defect: 6,
  CapaRecord: 4,
  WasteRecord: 2,
  ChatRoom: 3,
  ChatMessage: 10,
  Delegation: 2,
  ApprovalWorkflow: 7,
  Session: 10,
  AuditLog: 40,
  Shift: 3,
  CycleCount: 2,
};

const LIGHT_TARGETS = {
  Material: 2,
  Design: 3,
  Sample: 1,
  Sku: 1,
  Bom: 1,
  Supplier: 1,
  PurchaseRequisition: 1,
  Warehouse: 2,
  DefectCategory: 1,
  Session: 1,
  AuditLog: 5,
};

const MODEL_PATHS = {
  Material: '../modules/inventory/material.model.js',
  Design: '../modules/design/design.model.js',
  Sample: '../modules/sampling/sample.model.js',
  Sku: '../modules/sku/sku.model.js',
  Bom: '../modules/bom/bom.model.js',
  Supplier: '../modules/purchase/supplier.model.js',
  PurchaseRequisition: '../modules/purchase/purchaseRequisition.model.js',
  PurchaseOrder: '../modules/purchase/purchaseOrder.model.js',
  GoodsReceipt: '../modules/purchase/goodsReceipt.model.js',
  Rfq: '../modules/purchase/rfq.model.js',
  Quotation: '../modules/purchase/quotation.model.js',
  ProductionOrder: '../modules/production/productionOrder.model.js',
  ProductionBatch: '../modules/production/productionBatch.model.js',
  ProductionSchedule: '../modules/production/productionSchedule.model.js',
  Warehouse: '../modules/warehouse/warehouse.model.js',
  StorageBin: '../modules/warehouse/storageBin.model.js',
  Zone: '../modules/warehouse/zone.model.js',
  DefectCategory: '../modules/quality/defectCategory.model.js',
  QualityInspection: '../modules/quality/qualityInspection.model.js',
  Defect: '../modules/quality/defect.model.js',
  CapaRecord: '../modules/quality/capaRecord.model.js',
  WasteRecord: '../modules/waste/wasteRecord.model.js',
  ChatRoom: '../modules/chat/chatRoom.model.js',
  ChatMessage: '../modules/chat/chatMessage.model.js',
  Delegation: '../modules/user/delegation.model.js',
  ApprovalWorkflow: '../modules/approval/approvalWorkflow.model.js',
  Session: '../modules/auth/session.model.js',
  AuditLog: '../modules/audit/audit.model.js',
  Shift: '../modules/production/shift.model.js',
  CycleCount: '../modules/warehouse/cycleCount.model.js',
};

async function countModel(Model, factoryScoped) {
  const filter = factoryScoped ? { factoryId: { $exists: true }, isDeleted: { $ne: true } } : {};
  if (factoryScoped) {
    const { Factory } = await import('../modules/organization/factory.model.js');
    const factory = await Factory.findOne({ code: 'F01' });
    if (factory) filter.factoryId = factory._id;
  }
  return Model.countDocuments(filter);
}

async function verifySeed() {
  await connectDatabase();
  const targets = isHeavy() ? HEAVY_TARGETS : LIGHT_TARGETS;
  const failures = [];
  const results = [];

  for (const [name, minCount] of Object.entries(targets)) {
    const path = MODEL_PATHS[name];
    if (!path) continue;
    const mod = await import(path);
    const Model = mod[name];
    const factoryScoped = !['Session', 'AuditLog'].includes(name) || name === 'AuditLog';
    const count = name === 'Session'
      ? await Model.countDocuments({})
      : await countModel(Model, name !== 'Session');

    const ok = count >= minCount;
    results.push({ name, count, minCount, ok });
    if (!ok) failures.push(`${name}: ${count} < ${minCount}`);
  }

  console.log('\n=== Seed verification ===\n');
  for (const r of results) {
    console.log(`${r.ok ? '✓' : '✗'} ${r.name.padEnd(22)} ${String(r.count).padStart(4)} / ${r.minCount}`);
  }

  if (failures.length) {
    console.log(`\n${failures.length} check(s) failed:`);
    failures.forEach((f) => console.log(`  - ${f}`));
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log('\nAll seed verification checks passed.');
  await mongoose.disconnect();
}

verifySeed().catch((err) => {
  console.error(err);
  process.exit(1);
});
