import { Sample } from '../../modules/sampling/sample.model.js';
import { Sku } from '../../modules/sku/sku.model.js';
import { Bom } from '../../modules/bom/bom.model.js';
import { ProductionLine } from '../../modules/production/productionLine.model.js';
import { Machine } from '../../modules/production/machine.model.js';
import { ProductionOrder } from '../../modules/production/productionOrder.model.js';
import { ProductionBatch } from '../../modules/production/productionBatch.model.js';
import { ProductionSchedule } from '../../modules/production/productionSchedule.model.js';
import { isHeavy, isConditionsSeed, isFixtureSeed, advanceBatchToCompletion, logAudit, safeSeed, seedLimit } from './seedHelpers.js';

/** Re-run missing workflow steps when sample already exists (idempotent re-seed). */
async function advanceSampleToApproved(ctx, sample) {
  const sampleService = await import('../../modules/sampling/sample.service.js');
  const { factory, admin } = ctx;
  const pmId = ctx.roleUsers.pattern?._id || admin._id;
  const storeId = ctx.roleUsers.store?._id || admin._id;
  const qcId = ctx.roleUsers.qc?._id || admin._id;
  const dmId = ctx.roleUsers.designManager?._id || admin._id;
  const id = sample._id;
  const fid = factory._id;

  for (let i = 0; i < 15; i += 1) {
    const fresh = await Sample.findById(id);
    if (!fresh || fresh.status === 'APPROVED') return fresh;

    switch (fresh.status) {
      case 'CREATED':
      case 'REVISION_REQUESTED':
        await sampleService.submitMaterialRequest(id, fid, pmId);
        break;
      case 'MATERIAL_REQUEST_PENDING':
        await sampleService.approveMaterialRequest(id, fid, admin._id);
        break;
      case 'MATERIAL_REQUEST_APPROVED':
        await sampleService.reserveMaterials(id, fid, storeId);
        break;
      case 'MATERIAL_RESERVED':
        await sampleService.issueMaterials(id, fid, storeId);
        break;
      case 'CUTTING':
        await sampleService.completeCutting(id, fid, pmId);
        break;
      case 'IN_PROGRESS':
        await sampleService.completeSample(id, fid, pmId);
        break;
      case 'QC_PENDING':
        await sampleService.passSampleQc(id, fid, qcId, 'Seed QC pass');
        break;
      case 'FIT_TRIAL':
        await sampleService.completeFitTrial(
          id, fid, pmId, 'Fit session passed on base size',
          { overallResult: 'PASS', patternRevisionRequired: false },
        );
        break;
      case 'PENDING_APPROVAL':
      case 'QC_PASSED':
        await sampleService.approveSample(id, fid, dmId);
        break;
      default:
        return fresh;
    }
  }
  return Sample.findById(id);
}

async function seedPatternAndSample(ctx, design, approved = true) {
  const { factory, org, admin } = ctx;
  const patternMaster = ctx.roleUsers.pattern || admin;
  const pmId = patternMaster._id;

  let sample = await Sample.findOne({ factoryId: factory._id, designId: design._id });
  if (sample) {
    if (approved && sample.status !== 'APPROVED') {
      sample = await advanceSampleToApproved(ctx, sample);
      console.log(`Advanced sample ${sample?.sampleCode} → ${sample?.status}`);
    }
    return sample;
  }

  await safeSeed(`pattern-${design.designCode}`, async () => {
    const patternService = await import('../../modules/pattern/pattern.service.js');
    await patternService.assignPatternMaster({
      designId: design._id,
      factoryId: factory._id,
      patternMasterId: patternMaster._id,
    }, admin._id);
    await patternService.updatePatternDevelopment(design._id, factory._id, {
      marker: { length: 2.4, piecesPerMarker: 12, efficiencyPercent: 82 },
      calculatedConsumption: { wastagePercent: 5, derivedFromMarker: true, notes: 'Seed marker' },
      grading: { baseSize: 'M', gradedSizes: ['S', 'M', 'L', 'XL'], notes: 'Seed grading' },
      sizeChartVerified: true,
      consumptionVerified: true,
      sampleBomVerified: true,
    }, patternMaster._id);
    await patternService.completePatternDevelopment(design._id, factory._id, patternMaster._id);
  });

  const sampleService = await import('../../modules/sampling/sample.service.js');
  sample = await sampleService.createSample({
    designId: design._id,
    factoryId: factory._id,
    organizationId: org._id,
    laborHours: 4,
    laborRate: 150,
    sampleType: 'FIT',
    comments: 'Fit sample for walkthrough',
  }, pmId);

  if (approved) {
    const storeId = ctx.roleUsers.store?._id || admin._id;
    await sampleService.submitMaterialRequest(sample._id, factory._id, pmId);
    await sampleService.approveMaterialRequest(sample._id, factory._id, admin._id);
    await sampleService.reserveMaterials(sample._id, factory._id, storeId);
    await sampleService.issueMaterials(sample._id, factory._id, storeId);
    await sampleService.completeCutting(sample._id, factory._id, pmId);
    await sampleService.completeSample(sample._id, factory._id, pmId);
    await sampleService.passSampleQc(
      sample._id,
      factory._id,
      ctx.roleUsers.qc?._id || admin._id,
      'Fit sample passed QC',
    );
    await sampleService.completeFitTrial(
      sample._id,
      factory._id,
      pmId,
      'Fit session passed on base size',
      { overallResult: 'PASS', patternRevisionRequired: false },
    );
    await sampleService.approveSample(sample._id, factory._id, ctx.roleUsers.designManager?._id || admin._id);
    const { Sample } = await import('../../modules/sampling/sample.model.js');
    await Sample.findByIdAndUpdate(sample._id, {
      comments: 'Fit sample approved',
      updatedBy: ctx.roleUsers.designManager?._id || admin._id,
    });
  }

  console.log(`Seeded sample ${sample.sampleCode} for ${design.title}`);
  return sample;
}

async function seedSkuMatrix(ctx, design, sample) {
  const { factory, admin } = ctx;
  const skuService = await import('../../modules/sku/sku.service.js');
  const { Design } = await import('../../modules/design/design.model.js');
  const freshDesign = await Design.findById(design._id);

  if (isHeavy() && freshDesign.colorVariants?.some((v) => v.sizes?.length)) {
    try {
      const result = await skuService.createSkusFromDesign({
        designId: freshDesign._id,
        sampleId: sample._id,
        factoryId: factory._id,
        basePrice: freshDesign.targetPrice || 899,
      }, admin._id);
      console.log(`SKU matrix: ${result.created?.length || 0} created, ${result.skipped?.length || 0} skipped`);
    } catch (err) {
      console.warn(`SKU matrix via design: ${err.message}`);
    }
  }

  const colors = [
    { name: 'Navy', hex: '#1a237e' },
    { name: 'White', hex: '#ffffff' },
  ];
  if (isHeavy()) {
    for (const { name: colorName, hex } of colors) {
      for (const size of ['XS', 'S', 'M', 'L', 'XL']) {
        const exists = await Sku.findOne({ factoryId: factory._id, sampleId: sample._id, size, 'color.name': colorName });
        if (exists) continue;
        await safeSeed(`sku-${size}-${colorName}`, () => skuService.createSkuFromSample({
          sampleId: sample._id,
          factoryId: factory._id,
          size,
          color: { name: colorName, hexCode: hex },
          basePrice: freshDesign.targetPrice || 899,
        }, admin._id));
      }
    }
  } else {
    let sku = await Sku.findOne({ factoryId: factory._id, sampleId: sample._id, size: 'M' });
    if (!sku) {
      sku = await skuService.createSkuFromSample({
        sampleId: sample._id,
        factoryId: factory._id,
        size: 'M',
        basePrice: freshDesign.targetPrice || 899,
      }, admin._id);
    }
  }

  const skus = await Sku.find({ factoryId: factory._id, sampleId: sample._id, isDeleted: false });
  console.log(`Seeded ${skus.length} SKUs for ${freshDesign.title}`);
  return skus;
}

async function seedBomForSku(ctx, sku) {
  const { factory, org, admin, fabric, buttons } = ctx;
  if (!fabric || !buttons) return null;

  let bom = await Bom.findOne({ factoryId: factory._id, skuId: sku._id });
  if (bom?.status === 'ACTIVE') return bom;

  const bomService = await import('../../modules/bom/bom.service.js');
  if (bom && bom.status !== 'ACTIVE') {
    if (bom.status === 'DRAFT') {
      await bomService.approveBom(bom._id, factory._id, admin._id);
    }
    if (bom.status === 'APPROVED' || bom.status === 'DRAFT') {
      await bomService.finalizeBom(bom._id, factory._id, admin._id);
    }
    return Bom.findById(bom._id);
  }
  bom = await bomService.createBom({
    skuId: sku._id,
    factoryId: factory._id,
    organizationId: org._id,
    lines: [
      { materialId: fabric._id, quantityPerPiece: 2.5, unit: 'METERS', wastagePercent: 5, unitCost: fabric.unitCost },
      { materialId: buttons._id, quantityPerPiece: 6, unit: 'PIECES', unitCost: buttons.unitCost },
    ],
  }, admin._id);
  await bomService.approveBom(bom._id, factory._id, admin._id);
  await bomService.finalizeBom(bom._id, factory._id, admin._id);
  console.log(`Seeded BOM: ${bom.bomCode}`);
  ctx.boms.push(bom);
  return bom;
}

async function seedProductionLines(ctx) {
  const { org, factory, admin } = ctx;
  const machineService = await import('../../modules/production/machine.service.js');
  const lineSpecs = isHeavy()
    ? [
      { lineCode: 'LINE-01', name: 'Main Sewing Line', machines: [
        ['MC-CUT-01', 'Cutting Table 1', 'CUTTING'],
        ['MC-SEW-01', 'Sewing Machine 1', 'SEWING'],
        ['MC-SEW-02', 'Sewing Machine 2', 'SEWING'],
        ['MC-FIN-01', 'Finishing Station', 'IRONING'],
      ]},
      { lineCode: 'LINE-02', name: 'Secondary Line', machines: [
        ['MC-CUT-02', 'Cutting Table 2', 'CUTTING'],
        ['MC-SEW-03', 'Sewing Machine 3', 'SEWING'],
        ['MC-SEW-04', 'Sewing Machine 4', 'SEWING'],
        ['MC-PACK-01', 'Packing Station', 'OTHER'],
      ]},
    ]
    : [{ lineCode: 'LINE-01', name: 'Main Sewing Line', machines: [
      ['MC-CUT-01', 'Cutting Table 1', 'CUTTING'],
      ['MC-SEW-01', 'Sewing Machine 1', 'SEWING'],
      ['MC-SEW-02', 'Sewing Machine 2', 'SEWING'],
    ]}];

  ctx.lines = [];
  ctx.machines = [];

  for (const spec of lineSpecs) {
    let line = await ProductionLine.findOne({ factoryId: factory._id, lineCode: spec.lineCode });
    if (!line) {
      line = await machineService.createProductionLine({
        organizationId: org._id,
        factoryId: factory._id,
        lineCode: spec.lineCode,
        name: spec.name,
      }, admin._id);
    }
    ctx.lines.push(line);

    for (const [machineCode, name, machineType] of spec.machines) {
      let machine = await Machine.findOne({ factoryId: factory._id, machineCode });
      if (!machine) {
        machine = await machineService.createMachine({
          organizationId: org._id,
          factoryId: factory._id,
          machineCode,
          name,
          machineType,
          productionLineId: line._id,
          capacityPerHour: 40,
        }, admin._id);
      }
      ctx.machines.push(machine);
    }
  }
  console.log(`Seeded ${ctx.lines.length} production lines, ${ctx.machines.length} machines`);
}

async function seedProductionOrder(ctx, sku, { plannedQuantity, startBatch, completeBatch }) {
  const { factory, org, admin } = ctx;
  const productionService = await import('../../modules/production/production.service.js');

  let order = await ProductionOrder.findOne({
    factoryId: factory._id,
    skuId: sku._id,
    plannedQuantity,
  });
  if (order) {
    const batch = await ProductionBatch.findOne({ productionOrderId: order._id });
    return { order, batch };
  }

  order = await productionService.createProductionOrder({
    factoryId: factory._id,
    organizationId: org._id,
    skuId: sku._id,
    plannedQuantity,
    deliveryDate: new Date(Date.now() + 14 * 86400000),
  }, admin._id);

  await productionService.runProductionMrp(order._id, admin._id, factory._id);
  await productionService.reserveProductionMaterials(order._id, admin._id, factory._id);
  await productionService.submitProductionOrderForApproval(order._id, admin._id, factory._id);
  await productionService.approveProductionOrder(order._id, ctx.roleUsers.productionManager?._id || admin._id, { factoryId: factory._id });

  let batch = null;
  if (startBatch) {
    const batchQty = Math.min(plannedQuantity, Math.ceil(plannedQuantity / 2));
    batch = await productionService.createBatch({ productionOrderId: order._id, plannedQuantity: batchQty }, admin._id);
    await productionService.startBatch(batch._id, admin._id, factory._id);

    if (completeBatch) {
      batch = await advanceBatchToCompletion(batch._id, admin._id, factory._id);
      const qualityService = await import('../../modules/quality/quality.service.js');
      const finalQc = await qualityService.createFinalInspection(batch._id, admin._id);
      await qualityService.completeInspection(finalQc._id, {
        passedQuantity: batch.plannedQuantity,
        failedQuantity: 0,
        result: 'PASS',
      }, admin._id, factory._id);
    }
  }

  console.log(`Seeded production order ${order.orderNumber} (batch: ${batch?.batchNumber || 'none'})`);
  await logAudit(ctx, {
    module: 'production',
    action: 'order.approve',
    documentType: 'ProductionOrder',
    documentId: order._id,
    updatedData: { orderNumber: order.orderNumber, plannedQuantity },
  });

  ctx.productionOrders.push(order);
  if (batch) ctx.batches.push(batch);
  return { order, batch };
}

async function seedSchedules(ctx) {
  if (!isHeavy()) return;
  const productionService = await import('../../modules/production/production.service.js');
  const { admin, factory } = ctx;
  const existing = await ProductionSchedule.countDocuments({ factoryId: factory._id });
  if (existing >= 12) return;

  const batches = await ProductionBatch.find({ factoryId: factory._id, isDeleted: false }).limit(8);
  const line = ctx.lines?.[0];
  let created = existing;

  for (const batch of batches) {
    const order = await ProductionOrder.findById(batch.productionOrderId);
    if (!order) continue;
    const stages = ['CUTTING', 'SEWING', 'FINISHING'];
    for (let i = 0; i < stages.length && created < 12; i += 1) {
      const exists = await ProductionSchedule.findOne({
        factoryId: factory._id,
        batchId: batch._id,
        stage: stages[i],
      });
      if (exists) continue;
      const machine = ctx.machines?.[created % (ctx.machines?.length || 1)];
      await safeSeed(`schedule-${batch._id}-${stages[i]}`, () => productionService.createSchedule({
        productionOrderId: order._id,
        batchId: batch._id,
        stage: stages[i],
        productionLineId: line?._id,
        machineId: machine?._id,
        plannedStart: new Date(Date.now() + (created + 1) * 3600000),
        plannedEnd: new Date(Date.now() + (created + 2) * 3600000),
        status: batch.status === 'COMPLETED' ? 'COMPLETED' : 'PLANNED',
      }, admin._id));
      created += 1;
    }
  }
  console.log(`Seeded ${created} production schedules`);
}

async function seedExtraSamples(ctx) {
  if (!isFixtureSeed()) return;
  const { Design } = await import('../../modules/design/design.model.js');
  const { SizeChart } = await import('../../modules/design/sizeChart.model.js');
  const target = await Design.findOne({
    factoryId: ctx.factory._id,
    title: 'Hooded Sweatshirt',
    status: 'RELEASED',
    isDeleted: false,
  });
  if (target && target._id.toString() !== ctx.demoDesign?._id?.toString()) {
    await safeSeed(`sample-${target.designCode}`, async () => {
      const fresh = await Design.findById(target._id);
      if (!fresh.sizeChartId && ctx.sizeCharts?.[0]) {
        fresh.sizeChartId = ctx.sizeCharts[0]._id;
        fresh.sizeChartData = (await import('./seedHelpers.js')).matrixSizeChartData();
      }
      if (ctx.fabric && ctx.buttons) {
        fresh.fabricConsumption = [{
          materialId: ctx.fabric._id,
          consumption: 2.2,
          unit: 'METERS',
          wastagePercent: 5,
          fabricCost: ctx.fabric.unitCost,
        }];
        fresh.bomLines = [
          { materialId: ctx.fabric._id, materialName: ctx.fabric.name, quantity: 2.3, unit: 'METERS', category: 'FABRIC' },
          { materialId: ctx.buttons._id, materialName: ctx.buttons.name, quantity: 6, unit: 'PIECES', category: 'BUTTON' },
        ];
        fresh.accessories = [{
          accessoryType: 'BUTTON',
          materialId: ctx.buttons._id,
          consumption: 6,
          unit: 'PIECES',
          unitCost: ctx.buttons.unitCost,
          approved: true,
        }];
      }
      await fresh.save();
      return seedPatternAndSample(ctx, fresh, true);
    });
  }

  const pendingDesign = await Design.findOne({
    factoryId: ctx.factory._id,
    title: 'Resort Linen Pants',
    status: 'RELEASED',
    isDeleted: false,
  });
  if (pendingDesign) {
    const existing = await Sample.findOne({ factoryId: ctx.factory._id, designId: pendingDesign._id });
    if (!existing) {
      await safeSeed(`sample-pending-${pendingDesign.designCode}`, async () => {
        const fresh = await Design.findById(pendingDesign._id);
        if (ctx.fabric && ctx.buttons) {
          fresh.fabricConsumption = [{
            materialId: ctx.fabric._id, consumption: 2.5, unit: 'METERS', wastagePercent: 5, fabricCost: ctx.fabric.unitCost,
          }];
          fresh.bomLines = [
            { materialId: ctx.fabric._id, materialName: ctx.fabric.name, quantity: 2.5, unit: 'METERS', category: 'FABRIC' },
            { materialId: ctx.buttons._id, materialName: ctx.buttons.name, quantity: 4, unit: 'PIECES', category: 'BUTTON' },
          ];
          await fresh.save();
        }
        const sample = await seedPatternAndSample(ctx, fresh, false);
        const sampleService = await import('../../modules/sampling/sample.service.js');
        const pmId = ctx.roleUsers.pattern?._id || ctx.admin._id;
        await sampleService.submitMaterialRequest(sample._id, ctx.factory._id, pmId);
        console.log(`Seeded in-progress sample: ${sample.sampleCode}`);
      });
    }
  }
}

export async function seedProduction(ctx) {
  ctx.skus = ctx.skus || [];
  ctx.boms = ctx.boms || [];
  ctx.productionOrders = ctx.productionOrders || [];
  ctx.batches = ctx.batches || [];

  if (!ctx.demoDesign) {
    console.warn('No demo design — skipping production seed');
    return ctx;
  }

  const demoSample = await seedPatternAndSample(ctx, ctx.demoDesign, true);
  ctx.demoSample = demoSample;

  const skus = await seedSkuMatrix(ctx, ctx.demoDesign, demoSample);
  ctx.skus.push(...skus);
  ctx.demoSku = skus.find((s) => s.size === 'M') || skus[0];

  if (ctx.demoSku) {
    await seedBomForSku(ctx, ctx.demoSku);
  }

  await seedProductionLines(ctx);
  await seedExtraSamples(ctx);

  if (isFixtureSeed() && ctx.demoSku) {
    await seedProductionOrder(ctx, ctx.demoSku, {
      plannedQuantity: 100,
      startBatch: true,
      completeBatch: false,
    });

    if (isHeavy()) {
      await seedProductionOrder(ctx, ctx.demoSku, {
        plannedQuantity: 50,
        startBatch: true,
        completeBatch: true,
      });
      await seedProductionOrder(ctx, ctx.demoSku, {
        plannedQuantity: 25,
        startBatch: false,
        completeBatch: false,
      });
    }
  }

  await seedSchedules(ctx);

  if (isFixtureSeed()) {
    const wasteService = await import('../../modules/waste/waste.service.js');
    const { WasteRecord } = await import('../../modules/waste/wasteRecord.model.js');
    const completedBatches = await ProductionBatch.find({ factoryId: ctx.factory._id, status: 'COMPLETED', isDeleted: false });
    const wasteTypes = ['FABRIC_SCRAP', 'PRODUCTION_SCRAP', 'THREAD_WASTE'];
    const wasteTarget = isHeavy() ? 3 : 1;
    for (let i = 0; i < completedBatches.length && i < wasteTarget; i += 1) {
      const batch = completedBatches[i];
      await safeSeed(`waste-${batch._id}`, () => wasteService.createWasteRecord({
        factoryId: ctx.factory._id,
        organizationId: ctx.org._id,
        wasteType: wasteTypes[i % wasteTypes.length],
        batchId: batch._id,
        materialId: ctx.fabric?._id,
        quantity: 1.5 + i,
        unit: 'METERS',
        unitCost: ctx.fabric?.unitCost || 120,
        reasonCode: 'CUTTING',
      }, ctx.admin._id));
    }
    let wasteCount = await WasteRecord.countDocuments({ factoryId: ctx.factory._id });
    if (wasteCount < 2 && ctx.buttons) {
      await safeSeed('waste-accessory', () => wasteService.createWasteRecord({
        factoryId: ctx.factory._id,
        organizationId: ctx.org._id,
        wasteType: 'ACCESSORY_WASTE',
        materialId: ctx.buttons._id,
        quantity: 25,
        unit: 'PIECES',
        unitCost: ctx.buttons.unitCost,
        reasonCode: 'PRODUCTION',
      }, ctx.admin._id));
      wasteCount = await WasteRecord.countDocuments({ factoryId: ctx.factory._id });
    }
    console.log(`Waste records: ${wasteCount}`);
  }

  return ctx;
}
