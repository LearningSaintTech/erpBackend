import { DEMO_CREDENTIALS_SUMMARY } from '../config/systemRoles.js';
import { Design } from '../modules/design/design.model.js';
import { Sample } from '../modules/sampling/sample.model.js';
import { Sku } from '../modules/sku/sku.model.js';
import { Bom } from '../modules/bom/bom.model.js';
import { ProductionOrder } from '../modules/production/productionOrder.model.js';
import { ProductionBatch } from '../modules/production/productionBatch.model.js';
import { PatternDevelopment } from '../modules/pattern/pattern.model.js';
import { PurchaseRequisition } from '../modules/purchase/purchaseRequisition.model.js';
import { PurchaseOrder } from '../modules/purchase/purchaseOrder.model.js';
import { GoodsReceipt } from '../modules/purchase/goodsReceipt.model.js';
import { Material } from '../modules/inventory/material.model.js';
import { Warehouse } from '../modules/warehouse/warehouse.model.js';
import { QualityInspection } from '../modules/quality/qualityInspection.model.js';
import { ChatRoom } from '../modules/chat/chatRoom.model.js';
import { AuditLog } from '../modules/audit/audit.model.js';
import { Factory } from '../modules/organization/factory.model.js';

const UI_BASE = process.env.FRONTEND_URL || 'http://localhost:5173';

function step(n, title, user, path, detail) {
  console.log(`\n${n}. ${title}`);
  console.log(`   User:   ${user}`);
  console.log(`   UI:     ${UI_BASE}${path}`);
  if (detail) console.log(`   Entity: ${detail}`);
}

export async function printSeedWalkthrough(factoryId) {
  const factory = await Factory.findById(factoryId).select('code name');
  const design = await Design.findOne({ factoryId, title: 'Demo Summer Shirt' }).select('designCode title status');
  const pattern = design
    ? await PatternDevelopment.findOne({ factoryId, designId: design._id }).select('status')
    : null;
  const sample = design
    ? await Sample.findOne({ factoryId, designId: design._id }).select('sampleCode status sampleType')
    : null;
  const skuCount = await Sku.countDocuments({ factoryId, isDeleted: false });
  const sku = sample
    ? await Sku.findOne({ factoryId, sampleId: sample._id, size: 'M' }).select('skuCode size')
    : null;
  const bom = sku
    ? await Bom.findOne({ factoryId, skuId: sku._id }).select('bomCode status')
    : null;
  const prodOrder = await ProductionOrder.findOne({ factoryId }).select('orderNumber status').sort({ createdAt: -1 });
  const inProgressBatch = await ProductionBatch.findOne({ factoryId, status: 'IN_PROGRESS' }).select('batchNumber status');
  const completedBatch = await ProductionBatch.findOne({ factoryId, status: 'COMPLETED' }).select('batchNumber status');
  const demoPr = await PurchaseRequisition.findOne({ factoryId, prNumber: /PR-F01-DEMO/ }).select('prNumber status');
  const po = await PurchaseOrder.findOne({ factoryId }).select('poNumber status');
  const grn = await GoodsReceipt.findOne({ factoryId }).select('grnNumber status');

  const counts = {
    materials: await Material.countDocuments({ factoryId, isDeleted: false }),
    designs: await Design.countDocuments({ factoryId, isDeleted: false }),
    samples: await Sample.countDocuments({ factoryId, isDeleted: false }),
    skus: skuCount,
    warehouses: await Warehouse.countDocuments({ factoryId, isDeleted: false }),
    inspections: await QualityInspection.countDocuments({ factoryId, isDeleted: false }),
    chatRooms: await ChatRoom.countDocuments({ factoryId, isDeleted: false }),
    auditLogs: await AuditLog.countDocuments({ factoryId }),
  };

  console.log('\n=== Demo seed walkthrough ===');
  console.log(`Factory: ${factory?.code || '?'} — ${factory?.name || 'Demo Factory'}`);
  console.log(`Frontend: ${UI_BASE}  |  API: ${process.env.API_URL || 'http://localhost:3000/api/v1'}`);

  console.log('\n--- Seeded inventory summary ---');
  console.log(`  Materials: ${counts.materials}  |  Designs: ${counts.designs}  |  Samples: ${counts.samples}`);
  console.log(`  SKUs: ${counts.skus}  |  Warehouses: ${counts.warehouses}  |  QC inspections: ${counts.inspections}`);
  console.log(`  Chat rooms: ${counts.chatRooms}  |  Audit log entries: ${counts.auditLogs}`);

  console.log('\n--- Credentials (password Demo@123 unless noted) ---');
  for (const row of DEMO_CREDENTIALS_SUMMARY) {
    console.log(`  ${row.role.padEnd(22)} ${row.email.padEnd(32)} ${row.password}`);
  }

  step(1, 'Login as factory admin', 'admin@demo.local / FactoryAdmin@123', '/login');
  step(2, 'Review released design tech pack', 'admin@demo.local', '/designs',
    design ? `${design.designCode} — ${design.title} (${design.status})` : 'Demo Summer Shirt');
  step(3, 'Pattern development (completed in seed)', 'pattern@demo.local', '/pattern',
    pattern ? `status ${pattern.status}` : 'assigned to pattern master');
  step(4, 'Approved fit sample', 'sampling@demo.local', '/samples',
    sample ? `${sample.sampleCode} — ${sample.sampleType || 'PROTOTYPE'} (${sample.status})` : 'approved sample');
  step(5, 'SKU matrix from approved sample', 'admin@demo.local', '/products/skus',
    sku ? `${sku.skuCode} size ${sku.size} (+ ${skuCount - 1} more SKUs)` : `${skuCount} SKUs seeded`);
  step(6, 'Active BOM + MRP', 'admin@demo.local', '/products/boms',
    bom ? `${bom.bomCode} (${bom.status})` : 'active BOM');
  step(7, 'Production orders & batches', 'planner@demo.local', '/production/orders',
    prodOrder ? `${prodOrder.orderNumber} (${prodOrder.status})` : 'production orders');
  if (inProgressBatch) {
    console.log(`   Note:   In-progress batch ${inProgressBatch.batchNumber}`);
  }
  if (completedBatch) {
    console.log(`   Note:   Completed batch ${completedBatch.batchNumber} with final QC`);
  }
  step(8, 'Designer drafts & submissions', 'designer@demo.local', '/designs',
    `${counts.designs} designs across DRAFT / SUBMITTED / APPROVED / RELEASED`);
  step(9, 'Approve designer submission', 'design-manager@demo.local', '/approvals',
    'Pending design approvals');
  step(10, 'Purchase — PR, PO, RFQ', 'purchase@demo.local', '/purchase',
    demoPr ? `${demoPr.prNumber} (${demoPr.status})` : 'purchase requisitions');
  if (po) console.log(`   Note:   PO ${po.poNumber} (${po.status})`);
  step(11, 'Incoming QC on GRN (pre-seeded)', 'qc@demo.local', '/quality',
    grn ? `GRN ${grn.grnNumber} — ${counts.inspections} inspections total` : `${counts.inspections} inspections`);
  step(12, 'Warehouse put-away & hierarchy', 'warehouse@demo.local', '/warehouse',
    `${counts.warehouses} warehouses with zones, racks, shelves, bins`);
  step(13, 'Team chat & audit trail', 'admin@demo.local', '/chat',
    `${counts.chatRooms} rooms  |  /audit — ${counts.auditLogs} log entries`);

  console.log('\n--- Seed profiles ---');
  console.log('  npm run seed          # heavy profile (default)');
  console.log('  npm run seed:light    # minimal fixtures');
  console.log('  npm run seed:verify   # assert minimum counts');

  console.log('\n--- API E2E (in-memory, no Mongo required) ---');
  console.log('  cd backend && npm run smoke-test');
  console.log('\n--- UI E2E (requires seed + running servers) ---');
  console.log('  cd backend && npm run seed');
  console.log('  cd backend && npm run dev');
  console.log('  cd frontend && npm run dev');
  console.log('  cd frontend && npm run test:e2e');
  console.log('');
}
