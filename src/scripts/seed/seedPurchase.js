import { Supplier } from '../../modules/purchase/supplier.model.js';
import { PurchaseRequisition } from '../../modules/purchase/purchaseRequisition.model.js';
import { PurchaseOrder } from '../../modules/purchase/purchaseOrder.model.js';
import { GoodsReceipt } from '../../modules/purchase/goodsReceipt.model.js';
import { Rfq } from '../../modules/purchase/rfq.model.js';
import { loadSeedJson, isHeavy, isConditionsSeed, isFixtureSeed, seedLimit, logAudit, safeSeed } from './seedHelpers.js';

async function seedSuppliers(ctx) {
  const { org, factory, admin } = ctx;
  const purchaseService = await import('../../modules/purchase/purchase.service.js');
  const rows = loadSeedJson('suppliers.seed.json');
  const limit = seedLimit({ heavy: rows.length, conditions: 2, light: 1 });

  ctx.suppliers = [];
  for (const row of rows.slice(0, limit)) {
    let supplier = await Supplier.findOne({ factoryId: factory._id, supplierCode: row.supplierCode });
    if (!supplier) {
      supplier = await purchaseService.createSupplier({
        organizationId: org._id,
        factoryId: factory._id,
        ...row,
      }, admin._id);
      console.log(`Seeded supplier ${row.supplierCode}`);
    }
    ctx.suppliers.push(supplier);
  }
  return ctx.suppliers;
}

async function seedPurchaseRequisitions(ctx) {
  const { factory, org, admin, fabric, buttons } = ctx;
  const purchaseService = await import('../../modules/purchase/purchase.service.js');
  const specs = [
    { key: 'PR-F01-DEMO-001', material: fabric, qty: 200, status: 'APPROVED' },
    { key: 'PR-F01-DRAFT-002', material: buttons, qty: 500, status: 'DRAFT' },
    { key: 'PR-F01-SUB-003', material: fabric, qty: 150, status: 'SUBMITTED' },
    { key: 'PR-F01-APP-004', material: buttons, qty: 300, status: 'APPROVED' },
    { key: 'PR-F01-APP-005', material: fabric, qty: 100, status: 'APPROVED' },
  ];
  const limit = seedLimit({ heavy: specs.length, conditions: specs.length, light: 1 });

  ctx.purchaseRequisitions = [];
  for (const spec of specs.slice(0, limit)) {
    if (!spec.material) continue;
    let pr = await PurchaseRequisition.findOne({ factoryId: factory._id, prNumber: spec.key });
    if (!pr) {
      pr = await purchaseService.createPurchaseRequisition({
        factoryId: factory._id,
        organizationId: org._id,
        lines: [{ materialId: spec.material._id, requiredQty: spec.qty, unit: spec.material.unit, estimatedUnitCost: spec.material.unitCost }],
        sourceType: 'MANUAL',
      }, admin._id);
      pr.prNumber = spec.key;
      if (spec.status === 'APPROVED') {
        pr.status = 'APPROVED';
        pr.approvedBy = admin._id;
        pr.approvedAt = new Date();
      } else if (spec.status === 'SUBMITTED') {
        pr.status = 'SUBMITTED';
        pr.submittedAt = new Date();
      }
      await pr.save();
      console.log(`Seeded PR ${spec.key} (${spec.status})`);
    }
    ctx.purchaseRequisitions.push(pr);
  }
  return ctx.purchaseRequisitions;
}

async function seedPoGrnChain(ctx, pr, supplier) {
  const { factory, org, admin, fabric } = ctx;
  const purchaseService = await import('../../modules/purchase/purchase.service.js');
  const qualityService = await import('../../modules/quality/quality.service.js');

  const existingPo = await PurchaseOrder.findOne({ factoryId: factory._id, prId: pr._id });
  if (existingPo) return { po: existingPo, grn: await GoodsReceipt.findOne({ poId: existingPo._id }) };

  const po = await purchaseService.createPurchaseOrder({
    factoryId: factory._id,
    organizationId: org._id,
    supplierId: supplier._id,
    prId: pr._id,
  }, admin._id);
  await purchaseService.approvePurchaseOrder(po._id, factory._id, admin._id);
  await purchaseService.sendPurchaseOrder(po._id, factory._id, admin._id);

  const mat = fabric || ctx.materials.values().next().value;
  const grn = await purchaseService.createGoodsReceipt({
    factoryId: factory._id,
    organizationId: org._id,
    poId: po._id,
    lines: [{ materialId: mat._id, receivedQty: Math.min(50, pr.lines[0]?.requiredQty || 50), unit: mat.unit }],
  }, admin._id);
  await purchaseService.submitGrnForQc(grn._id, factory._id, admin._id);

  const inQc = await qualityService.createIncomingInspection(grn._id, ctx.roleUsers.qc?._id || admin._id);
  await qualityService.completeInspection(inQc._id, {
    passedQuantity: grn.lines[0]?.receivedQty || 50,
    failedQuantity: 0,
    result: 'PASS',
  }, admin._id, factory._id);

  console.log(`Seeded PO ${po.poNumber} → GRN ${grn.grnNumber} (QC passed)`);
  await logAudit(ctx, {
    module: 'purchase',
    action: 'grn.qc.complete',
    documentType: 'GoodsReceipt',
    documentId: grn._id,
    updatedData: { grnNumber: grn.grnNumber, result: 'PASS' },
  });

  ctx.purchaseOrders = ctx.purchaseOrders || [];
  ctx.purchaseOrders.push(po);
  return { po, grn };
}

async function seedRfqChain(ctx, pr) {
  const { factory, org, admin } = ctx;
  if (ctx.suppliers.length < 2) return null;

  const rfqService = await import('../../modules/purchase/rfq.service.js');
  const existing = await Rfq.findOne({ factoryId: factory._id, prId: pr._id });
  if (existing) return existing;

  const rfq = await rfqService.createRfqFromPr({
    factoryId: factory._id,
    organizationId: org._id,
    prId: pr._id,
    supplierIds: ctx.suppliers.slice(0, 2).map((s) => s._id),
  }, admin._id);
  await rfqService.sendRfq(rfq._id, factory._id, admin._id);

  const mat = pr.lines[0]?.materialId;
  const quotes = [];
  for (const supplier of ctx.suppliers.slice(0, 2)) {
    const quote = await rfqService.addQuotation({
      rfqId: rfq._id,
      factoryId: factory._id,
      supplierId: supplier._id,
      lines: [{
        materialId: mat,
        quantity: pr.lines[0]?.requiredQty || 100,
        unit: pr.lines[0]?.unit || 'PIECES',
        unitPrice: (pr.lines[0]?.estimatedUnitCost || 2) * (supplier.supplierCode === 'SUP-002' ? 0.9 : 1),
      }],
    }, admin._id);
    quotes.push(quote);
  }

  const selected = quotes[0];
  await rfqService.selectQuotation(selected._id, factory._id, admin._id);
  console.log(`Seeded RFQ ${rfq.rfqNumber} with ${quotes.length} quotations`);
  return rfq;
}

async function seedStandalonePoGrn(ctx, supplier, material) {
  const { factory, org, admin } = ctx;
  const purchaseService = await import('../../modules/purchase/purchase.service.js');
  const qualityService = await import('../../modules/quality/quality.service.js');
  const { GoodsReceipt } = await import('../../modules/purchase/goodsReceipt.model.js');

  const grnCount = await GoodsReceipt.countDocuments({ factoryId: factory._id, isDeleted: false });
  if (grnCount >= 2) return;

  const po = await purchaseService.createPurchaseOrder({
    factoryId: factory._id,
    organizationId: org._id,
    supplierId: supplier._id,
    lines: [{
      materialId: material._id,
      orderedQty: 30,
      unit: material.unit,
      unitPrice: material.unitCost,
    }],
  }, admin._id);

  await purchaseService.approvePurchaseOrder(po._id, factory._id, admin._id);
  await purchaseService.sendPurchaseOrder(po._id, factory._id, admin._id);

  const grn = await purchaseService.createGoodsReceipt({
    factoryId: factory._id,
    organizationId: org._id,
    poId: po._id,
    lines: [{ materialId: material._id, receivedQty: 30, unit: material.unit }],
  }, admin._id);
  await purchaseService.submitGrnForQc(grn._id, factory._id, admin._id);
  const inQc = await qualityService.createIncomingInspection(grn._id, ctx.roleUsers.qc?._id || admin._id);
  await qualityService.completeInspection(inQc._id, {
    passedQuantity: 30,
    failedQuantity: 0,
    result: 'PASS',
  }, admin._id, factory._id);
  console.log(`Seeded standalone PO ${po.poNumber} → GRN ${grn.grnNumber}`);
}

export async function seedPurchase(ctx) {
  await seedSuppliers(ctx);
  await seedPurchaseRequisitions(ctx);

  const approvedPrs = ctx.purchaseRequisitions.filter((p) => p.status === 'APPROVED');

  if (approvedPrs.length && ctx.suppliers.length) {
    const primaryPr = approvedPrs.find((p) => p.prNumber?.includes('DEMO')) || approvedPrs[0];
    await safeSeed('po-grn-primary', () => seedPoGrnChain(ctx, primaryPr, ctx.suppliers[0]));
  }

  if (isFixtureSeed() && ctx.suppliers.length > 1) {
    const prForGrn2 = ctx.purchaseRequisitions.find((p) => p.prNumber === 'PR-F01-APP-005' && p.status === 'APPROVED');
    if (prForGrn2) {
      await safeSeed('po-grn-secondary', () => seedPoGrnChain(ctx, prForGrn2, ctx.suppliers[1]));
    }
    const prForRfq = ctx.purchaseRequisitions.find((p) => p.prNumber === 'PR-F01-APP-004' && p.status === 'APPROVED');
    if (prForRfq) {
      await safeSeed('rfq-chain', () => seedRfqChain(ctx, prForRfq));
    }
    if (ctx.buttons && ctx.suppliers[1]) {
      await safeSeed('po-grn-standalone', () => seedStandalonePoGrn(ctx, ctx.suppliers[1], ctx.buttons));
    }
  }

  return ctx;
}
