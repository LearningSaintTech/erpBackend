import { PurchaseRequisition } from '../../modules/purchase/purchaseRequisition.model.js';
import { GoodsReceipt } from '../../modules/purchase/goodsReceipt.model.js';
import { Bom } from '../../modules/bom/bom.model.js';
import { Sku } from '../../modules/sku/sku.model.js';
import { ProductionOrder } from '../../modules/production/productionOrder.model.js';
import { Sample } from '../../modules/sampling/sample.model.js';
import { Design } from '../../modules/design/design.model.js';
import { WasteRecord } from '../../modules/waste/wasteRecord.model.js';
import { safeSeed, matrixSizeChartData } from './seedHelpers.js';

/** Minimal pattern tech pack so sample material requirements can be generated. */
function patternTechPackForSample(ctx) {
  const { fabric, buttons } = ctx;
  const update = {
    marker: { length: 2.2, piecesPerMarker: 10, efficiencyPercent: 80 },
    calculatedConsumption: { wastagePercent: 5, derivedFromMarker: true },
    grading: { baseSize: 'M', gradedSizes: ['S', 'M', 'L', 'XL'], notes: 'Seed grading' },
    sizeChartData: matrixSizeChartData(),
  };
  if (fabric && buttons) {
    update.fabricConsumption = [{
      materialId: fabric._id,
      consumption: 2.42,
      unit: 'METERS',
      wastagePercent: 5,
      fabricCost: fabric.unitCost,
    }];
    update.bomLines = [
      { materialId: fabric._id, materialName: fabric.name, quantity: 2.42, unit: 'METERS', category: 'FABRIC' },
      { materialId: buttons._id, materialName: buttons.name, quantity: 8, unit: 'PIECES', category: 'BUTTON' },
    ];
  }
  return update;
}

/** GRN in DRAFT (submit QC modal) and PENDING_QC (incoming QC modal). */
export async function seedPurchaseModalStates(ctx) {
  const { factory, org, admin, fabric, buttons, suppliers } = ctx;
  if (!suppliers?.length || !fabric) return;

  const purchaseService = await import('../../modules/purchase/purchase.service.js');

  if (!await GoodsReceipt.findOne({ factoryId: factory._id, grnNumber: 'GRN-F01-DRAFT-001' })) {
    await safeSeed('grn-draft', async () => {
      const po = await purchaseService.createPurchaseOrder({
        factoryId: factory._id,
        organizationId: org._id,
        supplierId: suppliers[0]._id,
        lines: [{
          materialId: fabric._id,
          orderedQty: 40,
          unit: fabric.unit,
          unitPrice: fabric.unitCost,
        }],
      }, admin._id);
      await purchaseService.approvePurchaseOrder(po._id, factory._id, admin._id);
      await purchaseService.sendPurchaseOrder(po._id, factory._id, admin._id);
      const grn = await purchaseService.createGoodsReceipt({
        factoryId: factory._id,
        organizationId: org._id,
        poId: po._id,
        lines: [{ materialId: fabric._id, receivedQty: 40, unit: fabric.unit }],
      }, admin._id);
      grn.grnNumber = 'GRN-F01-DRAFT-001';
      await grn.save();
      console.log(`Seeded GRN ${grn.grnNumber} (DRAFT — submit QC modal)`);
    });
  }

  const mat = buttons || fabric;
  if (suppliers[1] && !await GoodsReceipt.findOne({ factoryId: factory._id, grnNumber: 'GRN-F01-PENDING-QC' })) {
    await safeSeed('grn-pending-qc', async () => {
      const po = await purchaseService.createPurchaseOrder({
        factoryId: factory._id,
        organizationId: org._id,
        supplierId: suppliers[1]._id,
        lines: [{
          materialId: mat._id,
          orderedQty: 25,
          unit: mat.unit,
          unitPrice: mat.unitCost,
        }],
      }, admin._id);
      await purchaseService.approvePurchaseOrder(po._id, factory._id, admin._id);
      await purchaseService.sendPurchaseOrder(po._id, factory._id, admin._id);
      const grn = await purchaseService.createGoodsReceipt({
        factoryId: factory._id,
        organizationId: org._id,
        poId: po._id,
        lines: [{ materialId: mat._id, receivedQty: 25, unit: mat.unit }],
      }, admin._id);
      grn.grnNumber = 'GRN-F01-PENDING-QC';
      await grn.save();
      await purchaseService.submitGrnForQc(grn._id, factory._id, admin._id);
      console.log(`Seeded GRN ${grn.grnNumber} (PENDING_QC — incoming QC modal)`);
    });
  }
}

/** BOM DRAFT (approve modal) and APPROVED (finalize modal). */
export async function seedBomModalStates(ctx) {
  const { factory, org, admin, fabric, buttons } = ctx;
  if (!fabric || !buttons || !ctx.demoSample) return;

  const bomService = await import('../../modules/bom/bom.service.js');
  const skuService = await import('../../modules/sku/sku.service.js');

  let draftSku = await Sku.findOne({
    factoryId: factory._id,
    sampleId: ctx.demoSample._id,
    size: 'L',
    isDeleted: false,
  });
  if (!draftSku) {
    draftSku = await safeSeed('sku-draft-bom', () => skuService.createSkuFromSample({
      sampleId: ctx.demoSample._id,
      factoryId: factory._id,
      size: 'L',
      color: { name: 'Draft BOM', hexCode: '#607d8b' },
      basePrice: 799,
    }, admin._id));
  }

  if (!draftSku) return;

  let draftBom = await Bom.findOne({ factoryId: factory._id, skuId: draftSku._id, status: 'DRAFT' });
  if (!draftBom) {
    const existing = await Bom.findOne({ factoryId: factory._id, skuId: draftSku._id });
    if (!existing) {
      draftBom = await bomService.createBom({
        skuId: draftSku._id,
        factoryId: factory._id,
        organizationId: org._id,
        lines: [
          { materialId: fabric._id, quantityPerPiece: 2.4, unit: 'METERS', wastagePercent: 5, unitCost: fabric.unitCost },
          { materialId: buttons._id, quantityPerPiece: 5, unit: 'PIECES', unitCost: buttons.unitCost },
        ],
      }, admin._id);
      console.log(`Seeded BOM ${draftBom.bomCode} (DRAFT — approve modal)`);
    }
  }

  let approvedSku = await Sku.findOne({
    factoryId: factory._id,
    sampleId: ctx.demoSample._id,
    size: 'XL',
    isDeleted: false,
  });
  if (!approvedSku) {
    approvedSku = await safeSeed('sku-approved-bom', () => skuService.createSkuFromSample({
      sampleId: ctx.demoSample._id,
      factoryId: factory._id,
      size: 'XL',
      color: { name: 'Approved BOM', hexCode: '#455a64' },
      basePrice: 849,
    }, admin._id));
  }

  if (!approvedSku) return;

  let approvedBom = await Bom.findOne({ factoryId: factory._id, skuId: approvedSku._id, status: 'APPROVED' });
  if (!approvedBom) {
    const existing = await Bom.findOne({ factoryId: factory._id, skuId: approvedSku._id });
    if (!existing) {
      approvedBom = await bomService.createBom({
        skuId: approvedSku._id,
        factoryId: factory._id,
        organizationId: org._id,
        lines: [
          { materialId: fabric._id, quantityPerPiece: 2.6, unit: 'METERS', wastagePercent: 5, unitCost: fabric.unitCost },
        ],
      }, admin._id);
      await bomService.approveBom(approvedBom._id, factory._id, admin._id);
      console.log(`Seeded BOM ${approvedBom.bomCode} (APPROVED — finalize modal)`);
    }
  }
}

/** Production order stuck at APPROVAL_PENDING (reject modal). */
export async function seedProductionModalStates(ctx) {
  const { factory, org, admin } = ctx;
  if (!ctx.demoSku) return;

  const productionService = await import('../../modules/production/production.service.js');
  const exists = await ProductionOrder.findOne({
    factoryId: factory._id,
    skuId: ctx.demoSku._id,
    status: 'APPROVAL_PENDING',
  });
  if (exists) return;

  await safeSeed('prod-approval-pending', async () => {
    const order = await productionService.createProductionOrder({
      factoryId: factory._id,
      organizationId: org._id,
      skuId: ctx.demoSku._id,
      plannedQuantity: 75,
      deliveryDate: new Date(Date.now() + 21 * 86400000),
    }, admin._id);
    await productionService.runProductionMrp(order._id, admin._id, factory._id);
    await productionService.reserveProductionMaterials(order._id, admin._id, factory._id);
    await productionService.submitProductionOrderForApproval(order._id, admin._id, factory._id);
    console.log(`Seeded production order ${order.orderNumber} (APPROVAL_PENDING — reject modal)`);
  });
}

/** Sample awaiting store reserve (reserve modal). */
export async function seedSampleHandoffStates(ctx) {
  const { factory, admin } = ctx;
  let design = await Design.findOne({
    factoryId: factory._id,
    title: 'Denim Jacket',
    isDeleted: false,
  });
  if (!design) {
    design = await Design.findOne({
      factoryId: factory._id,
      status: 'RELEASED',
      isDeleted: false,
      _id: { $ne: ctx.demoDesign?._id },
    });
  }
  if (!design) return;

  if (design.status !== 'RELEASED') {
    const { releaseDesign, approveDesign, submitDesign } = await import('../../modules/design/design.service.js');
    const manager = ctx.roleUsers.designManager?._id || admin._id;
    const designer = ctx.roleUsers.designer?._id || admin._id;
    if (['DRAFT', 'REVISION_REQUESTED'].includes(design.status)) {
      await submitDesign(design._id, designer);
      design = await Design.findById(design._id);
    }
    if (!['APPROVED', 'RELEASED'].includes(design.status)) {
      await approveDesign(design._id, manager);
      design = await Design.findById(design._id);
    }
    if (design.status !== 'RELEASED') {
      await releaseDesign(design._id, manager);
    }
  }

  const existing = await Sample.findOne({
    factoryId: factory._id,
    designId: design._id,
    status: 'MATERIAL_REQUEST_APPROVED',
  });
  if (existing) return;

  const anySample = await Sample.findOne({ factoryId: factory._id, designId: design._id });
  if (anySample) {
    const sampleService = await import('../../modules/sampling/sample.service.js');
    const fresh = await Sample.findById(anySample._id);
    if (fresh.status === 'MATERIAL_REQUEST_PENDING') {
      await sampleService.approveMaterialRequest(fresh._id, factory._id, admin._id);
      console.log(`Advanced sample ${fresh.sampleCode} → MATERIAL_REQUEST_APPROVED`);
    }
    return;
  }

  await safeSeed('sample-awaiting-reserve', async () => {
    const patternService = await import('../../modules/pattern/pattern.service.js');
    const sampleService = await import('../../modules/sampling/sample.service.js');
    const { PatternDevelopment } = await import('../../modules/pattern/pattern.model.js');
    const pmId = ctx.roleUsers.pattern?._id || admin._id;

    let pd = await PatternDevelopment.findOne({ factoryId: factory._id, designId: design._id, isDeleted: false });
    const needsTechPack = !pd?.fabricConsumption?.length;

    if (pd?.status === 'COMPLETED' && needsTechPack) {
      await patternService.reopenPatternDevelopment(design._id, factory._id, pmId, {
        reason: 'Seed — add tech pack for sample reserve modal',
      });
      pd = await PatternDevelopment.findOne({ factoryId: factory._id, designId: design._id, isDeleted: false });
    }

    if (!pd) {
      await patternService.assignPatternMaster({
        designId: design._id,
        factoryId: factory._id,
        patternMasterId: pmId,
      }, admin._id);
    }

    if (!pd || pd.status !== 'COMPLETED' || needsTechPack) {
      await patternService.updatePatternDevelopment(design._id, factory._id, {
        ...patternTechPackForSample(ctx),
      }, pmId);
      await patternService.updatePatternDevelopment(design._id, factory._id, {
        sizeChartVerified: true,
        consumptionVerified: true,
        sampleBomVerified: true,
      }, pmId);
      if ((await PatternDevelopment.findOne({ factoryId: factory._id, designId: design._id, isDeleted: false }))?.status !== 'COMPLETED') {
        await patternService.completePatternDevelopment(design._id, factory._id, pmId);
      }
    }

    const sample = await sampleService.createSample({
      designId: design._id,
      factoryId: factory._id,
      organizationId: ctx.org._id,
      sampleType: 'PROTOTYPE',
      comments: 'Awaiting store reserve',
    }, pmId);
    await sampleService.submitMaterialRequest(sample._id, factory._id, pmId);
    await sampleService.approveMaterialRequest(sample._id, factory._id, admin._id);
    console.log(`Seeded sample ${sample.sampleCode} (MATERIAL_REQUEST_APPROVED — reserve modal)`);
  });
}

/** Waste record in RECORDED status (recovery modal). */
export async function seedWasteModalStates(ctx) {
  const { factory, org, admin, fabric } = ctx;
  const exists = await WasteRecord.findOne({ factoryId: factory._id, status: 'RECORDED' });
  if (exists) return;

  const wasteService = await import('../../modules/waste/waste.service.js');
  await safeSeed('waste-recorded', () => wasteService.createWasteRecord({
    factoryId: factory._id,
    organizationId: org._id,
    wasteType: 'FABRIC_SCRAP',
    materialId: fabric?._id,
    quantity: 12,
    unit: 'METERS',
    estimatedCost: 1440,
    reason: 'Seed — trim waste for recovery modal',
    status: 'RECORDED',
  }, admin._id));
  console.log('Seeded waste record (RECORDED — recovery modal)');
}

export async function seedModalConditions(ctx) {
  await seedPurchaseModalStates(ctx);
  await seedBomModalStates(ctx);
  await seedProductionModalStates(ctx);
  await seedSampleHandoffStates(ctx);
  await seedWasteModalStates(ctx);
}

export async function printConditionsSummary(ctx) {
  const { factory, org } = ctx;
  const UI = process.env.FRONTEND_URL || 'http://localhost:5173';

  const counts = {
    materials: await import('../../modules/inventory/material.model.js').then((m) => m.Material.countDocuments({ factoryId: factory._id, isDeleted: false })),
    designs: await Design.countDocuments({ factoryId: factory._id, isDeleted: false }),
    samples: await Sample.countDocuments({ factoryId: factory._id, isDeleted: false }),
    prDraft: await PurchaseRequisition.countDocuments({ factoryId: factory._id, status: 'DRAFT' }),
    prSubmitted: await PurchaseRequisition.countDocuments({ factoryId: factory._id, status: 'SUBMITTED' }),
    grnDraft: await GoodsReceipt.countDocuments({ factoryId: factory._id, status: 'DRAFT' }),
    grnPendingQc: await GoodsReceipt.countDocuments({ factoryId: factory._id, status: 'PENDING_QC' }),
    bomDraft: await Bom.countDocuments({ factoryId: factory._id, status: 'DRAFT' }),
    bomApproved: await Bom.countDocuments({ factoryId: factory._id, status: 'APPROVED' }),
    prodPending: await ProductionOrder.countDocuments({ factoryId: factory._id, status: 'APPROVAL_PENDING' }),
    wasteRecorded: await WasteRecord.countDocuments({ factoryId: factory._id, status: 'RECORDED' }),
  };

  console.log('\n=== Conditions seed summary (modal / workflow states) ===');
  console.log(`Frontend: ${UI}`);
  console.log('\n--- Fixture counts ---');
  console.log(`  Materials: ${counts.materials}  |  Designs: ${counts.designs}  |  Samples: ${counts.samples}`);
  console.log(`  PR DRAFT: ${counts.prDraft}  |  PR SUBMITTED: ${counts.prSubmitted}`);
  console.log(`  GRN DRAFT: ${counts.grnDraft}  |  GRN PENDING_QC: ${counts.grnPendingQc}`);
  console.log(`  BOM DRAFT: ${counts.bomDraft}  |  BOM APPROVED: ${counts.bomApproved}`);
  console.log(`  Production APPROVAL_PENDING: ${counts.prodPending}`);
  console.log(`  Waste RECORDED: ${counts.wasteRecorded}`);

  console.log('\n--- Modal walkthrough ---');
  console.log('  Purchase → PR Submit/Reject     PR-F01-DRAFT-002 / PR-F01-SUB-003');
  console.log('  Purchase → GRN Submit QC          GRN-F01-DRAFT-001');
  console.log('  Quality → Incoming QC             GRN-F01-PENDING-QC');
  console.log('  Inventory → Reserve/Release       dock + bin stock on FAB-COT-001');
  console.log('  Warehouse → Put away / Pick       /warehouse/operations/*');
  console.log('  Design → Reject/Revision          SUBMITTED designs (IN_REVIEW)');
  console.log('  Samples → Reserve materials       Denim Jacket sample (MATERIAL_REQUEST_APPROVED)');
  console.log('  BOM → Approve / Finalize          DRAFT + APPROVED BOMs');
  console.log('  Production → Reject order         APPROVAL_PENDING order');
  console.log('  Production → Rollback batch       in-progress batch on main order');
  console.log('  Waste → Record recovery           RECORDED waste row');
  console.log('  Users → Revoke delegation         active delegations');
  console.log('  Quality → Edit/Close CAPA         open CAPA records');
  console.log('  Settings → Delete inventory code  /settings/inventory-codes\n');
}
