import { QualityInspection } from './qualityInspection.model.js';
import { Defect } from './defect.model.js';
import { CapaRecord } from './capaRecord.model.js';
import { GoodsReceipt } from '../purchase/goodsReceipt.model.js';
import { ProductionBatch } from '../production/productionBatch.model.js';
import { ProductionOrder } from '../production/productionOrder.model.js';
import { Material } from '../inventory/material.model.js';
import { Factory } from '../organization/factory.model.js';
import * as inventoryService from '../inventory/inventory.service.js';
import * as warehouseService from '../warehouse/warehouse.service.js';
import * as productionService from '../production/production.service.js';
import * as wasteService from '../waste/waste.service.js';
import { nextDocumentNumber } from '../../shared/utils/numbering.js';
import { NotFoundError, ConflictError } from '../../shared/errors/AppError.js';
import { applySoftDeleteFilter } from '../../shared/utils/schema.js';

export async function getQualityStats(factoryId) {
  const base = applySoftDeleteFilter({ factoryId });
  const [
    totalInspections,
    pending,
    inProgress,
    completed,
    passed,
    failed,
    partial,
    rework,
    openCapa,
    defectsLogged,
    pendingGrns,
    batchesAwaitingFinal,
    batchesInProcess,
  ] = await Promise.all([
    QualityInspection.countDocuments(base),
    QualityInspection.countDocuments({ ...base, status: 'PENDING' }),
    QualityInspection.countDocuments({ ...base, status: 'IN_PROGRESS' }),
    QualityInspection.countDocuments({ ...base, status: 'COMPLETED' }),
    QualityInspection.countDocuments({ ...base, status: 'COMPLETED', result: 'PASS' }),
    QualityInspection.countDocuments({ ...base, status: 'COMPLETED', result: 'FAIL' }),
    QualityInspection.countDocuments({ ...base, status: 'COMPLETED', result: 'PARTIAL' }),
    QualityInspection.countDocuments({ ...base, status: 'COMPLETED', result: 'REWORK' }),
    CapaRecord.countDocuments({ ...base, status: { $in: ['OPEN', 'IN_PROGRESS'] } }),
    Defect.countDocuments({ factoryId, isDeleted: false }),
    GoodsReceipt.countDocuments({ factoryId, status: 'PENDING_QC', isDeleted: false }),
    ProductionBatch.countDocuments({ factoryId, status: 'COMPLETED', currentStage: 'COMPLETED', qcInspectionId: { $exists: false }, isDeleted: false }),
    ProductionBatch.countDocuments({ factoryId, status: { $in: ['IN_PROGRESS', 'REWORK'] }, isDeleted: false }),
  ]);

  const firstPassYield = completed > 0 ? Math.round((passed / completed) * 100) : 0;

  return {
    totalInspections,
    pending,
    inProgress,
    completed,
    passed,
    failed,
    partial,
    rework,
    openCapa,
    defectsLogged,
    pendingGrns,
    batchesAwaitingFinal,
    batchesInProcess,
    firstPassYield,
  };
}

export async function getPendingWork(factoryId) {
  const [pendingGrns, inProgressBatches, completedBatches] = await Promise.all([
    GoodsReceipt.find({ factoryId, status: 'PENDING_QC', isDeleted: false })
      .populate('lines.materialId', 'materialCode name unit')
      .populate('poId', 'poNumber status')
      .populate('qcInspectionId', 'inspectionNumber status')
      .sort({ createdAt: 1 })
      .limit(50),
    ProductionBatch.find({ factoryId, status: { $in: ['IN_PROGRESS', 'REWORK'] }, isDeleted: false })
      .populate('productionOrderId', 'orderNumber')
      .sort({ updatedAt: -1 })
      .limit(50),
    ProductionBatch.find({
      factoryId,
      status: 'COMPLETED',
      currentStage: 'COMPLETED',
      $or: [{ qcInspectionId: { $exists: false } }, { qcInspectionId: null }],
      isDeleted: false,
    })
      .populate('productionOrderId', 'orderNumber')
      .sort({ updatedAt: -1 })
      .limit(50),
  ]);
  return { pendingGrns, inProgressBatches, completedBatches };
}

export async function getIncomingQcContext(grnId, factoryId) {
  const grn = await GoodsReceipt.findOne(applySoftDeleteFilter({ _id: grnId, factoryId }))
    .populate('lines.materialId', 'materialCode name unit')
    .populate('poId', 'poNumber status')
    .populate('qcInspectionId', 'inspectionNumber status');
  if (!grn) throw new NotFoundError('Goods receipt not found');
  if (!['PENDING_QC', 'COMPLETED'].includes(grn.status)) {
    throw new ConflictError('GRN must be submitted for incoming QC (PENDING_QC)');
  }

  const lines = (grn.lines || []).map((line) => {
    const mat = line.materialId;
    return {
      materialId: typeof mat === 'object' ? mat._id : line.materialId,
      materialCode: typeof mat === 'object' ? mat.materialCode : undefined,
      materialName: typeof mat === 'object' ? mat.name : undefined,
      receivedQty: line.receivedQty || 0,
      acceptedQty: line.acceptedQty,
      unit: line.unit || (typeof mat === 'object' ? mat.unit : undefined),
    };
  });
  const totalReceived = lines.reduce((sum, l) => sum + (l.receivedQty || 0), 0);

  let inspection = grn.qcInspectionId;
  if (inspection && typeof inspection === 'object' && inspection._id) {
    inspection = inspection;
  } else if (grn.qcInspectionId) {
    inspection = await QualityInspection.findById(grn.qcInspectionId);
  } else {
    inspection = await QualityInspection.findOne({
      factoryId: grn.factoryId,
      referenceType: 'GOODS_RECEIPT',
      referenceId: grn._id,
      isDeleted: false,
    });
  }

  return {
    grnId: grn._id,
    grnNumber: grn.grnNumber,
    grnStatus: grn.status,
    poId: grn.poId?._id || grn.poId,
    poNumber: typeof grn.poId === 'object' ? grn.poId.poNumber : undefined,
    totalReceived,
    lines,
    inspection: inspection ? {
      _id: inspection._id,
      inspectionNumber: inspection.inspectionNumber,
      status: inspection.status,
    } : null,
  };
}

export async function createIncomingInspection(grnId, userId) {
  const grn = await GoodsReceipt.findOne(applySoftDeleteFilter({ _id: grnId }));
  if (!grn) throw new NotFoundError('Goods receipt not found');
  if (grn.status !== 'PENDING_QC') throw new ConflictError('GRN must be PENDING_QC');

  if (grn.qcInspectionId) {
    const existing = await QualityInspection.findById(grn.qcInspectionId);
    if (existing && !existing.isDeleted) return existing;
  }

  const orphan = await QualityInspection.findOne({
    factoryId: grn.factoryId,
    referenceType: 'GOODS_RECEIPT',
    referenceId: grn._id,
    isDeleted: false,
  });
  if (orphan) {
    grn.qcInspectionId = orphan._id;
    grn.updatedBy = userId;
    await grn.save();
    return orphan;
  }

  const factory = await Factory.findById(grn.factoryId);
  const inspectionNumber = await nextDocumentNumber(grn.factoryId, 'QC', `QC-${factory.code}-`);

  return createInspectionRecord({
    organizationId: grn.organizationId,
    factoryId: grn.factoryId,
    inspectionNumber,
    inspectionType: 'INCOMING',
    referenceType: 'GOODS_RECEIPT',
    referenceId: grn._id,
    userId,
    onCreated: async (inspection) => {
      grn.qcInspectionId = inspection._id;
      grn.updatedBy = userId;
      await grn.save();
    },
  });
}

export async function createInspectionRecord({
  organizationId, factoryId, inspectionNumber, inspectionType, referenceType, referenceId,
  userId, onCreated, stageAtInspection, storageBinId, autoDispatchReady,
}) {
  const inspection = await QualityInspection.create({
    organizationId,
    factoryId,
    inspectionNumber,
    inspectionType,
    referenceType,
    referenceId,
    stageAtInspection,
    storageBinId,
    autoDispatchReady,
    status: 'PENDING',
    createdBy: userId,
    updatedBy: userId,
  });
  if (onCreated) await onCreated(inspection);
  return inspection;
}

export async function createFinalInspection(batchId, userId, { storageBinId, autoDispatchReady } = {}) {
  const batch = await ProductionBatch.findOne(applySoftDeleteFilter({ _id: batchId }));
  if (!batch) throw new NotFoundError('Batch not found');
  if (batch.status !== 'COMPLETED' || batch.currentStage !== 'COMPLETED') {
    throw new ConflictError('Batch must be completed before final QC');
  }

  const factory = await Factory.findById(batch.factoryId);
  const inspectionNumber = await nextDocumentNumber(batch.factoryId, 'QC', `QC-${factory.code}-`);

  return createInspectionRecord({
    organizationId: batch.organizationId,
    factoryId: batch.factoryId,
    inspectionNumber,
    inspectionType: 'FINAL',
    referenceType: 'PRODUCTION_BATCH',
    referenceId: batch._id,
    storageBinId,
    autoDispatchReady,
    userId,
    onCreated: async (inspection) => {
      batch.qcInspectionId = inspection._id;
      batch.updatedBy = userId;
      await batch.save();
    },
  });
}

export async function listInspections(factoryId, { page, limit, skip, status, inspectionType, search }) {
  const filter = applySoftDeleteFilter({ factoryId });
  if (status) filter.status = status;
  if (inspectionType) filter.inspectionType = inspectionType;
  if (search) {
    const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ inspectionNumber: re }];
  }
  const [items, total] = await Promise.all([
    QualityInspection.find(filter)
      .populate('inspectedBy', 'firstName lastName')
      .skip(skip)
      .limit(limit)
      .sort({ createdAt: -1 }),
    QualityInspection.countDocuments(filter),
  ]);
  return { items, total };
}

export async function getInspection(id, factoryId) {
  const filter = applySoftDeleteFilter({ _id: id });
  if (factoryId) filter.factoryId = factoryId;
  const inspection = await QualityInspection.findOne(filter)
    .populate('inspectedBy', 'firstName lastName')
    .populate('storageBinId', 'binCode zoneCode');
  if (!inspection) throw new NotFoundError('Inspection not found');
  return inspection;
}

export async function startInspection(id, userId, factoryId) {
  const inspection = await getInspection(id, factoryId);
  if (inspection.status !== 'PENDING') throw new ConflictError('Inspection already started');
  inspection.status = 'IN_PROGRESS';
  inspection.updatedBy = userId;
  await inspection.save();
  return inspection;
}

export async function completeInspection(id, body, userId, factoryId) {
  const inspection = await getInspection(id, factoryId);
  if (inspection.status === 'COMPLETED') throw new ConflictError('Inspection already completed');

  const { passedQuantity, failedQuantity, result, disposition, storageBinId, autoDispatchReady } = body;
  const failed = failedQuantity || 0;
  const passed = passedQuantity || 0;
  const disp = disposition || (failed > 0 && passed === 0 ? 'REJECT' : failed > 0 ? 'PARTIAL' : 'PASS');

  if (inspection.referenceType === 'GOODS_RECEIPT') {
    const grn = await GoodsReceipt.findById(inspection.referenceId);
    if (grn && grn.status === 'COMPLETED') {
      throw new ConflictError('GRN incoming QC already completed');
    }
    if (grn) {
      const totalReceived = grn.lines.reduce((sum, line) => sum + (line.receivedQty || 0), 0);
      if (passed + failed > totalReceived && totalReceived > 0) {
        throw new ConflictError(
          `Passed (${passed}) + failed (${failed}) cannot exceed GRN received qty (${totalReceived})`,
        );
      }
    }
  }

  inspection.passedQuantity = passed;
  inspection.failedQuantity = failed;
  inspection.disposition = disp === 'PARTIAL' ? 'PASS' : disp;
  inspection.result = result || (disp === 'REWORK' ? 'REWORK' : disp === 'REJECT' ? 'FAIL' : failed > 0 ? 'PARTIAL' : 'PASS');
  if (storageBinId) inspection.storageBinId = storageBinId;
  if (autoDispatchReady !== undefined) inspection.autoDispatchReady = autoDispatchReady;
  inspection.status = 'COMPLETED';
  inspection.inspectedBy = userId;
  inspection.completedAt = new Date();
  inspection.updatedBy = userId;

  if (inspection.referenceType === 'GOODS_RECEIPT') {
    await completeIncomingQc(inspection, userId);
    await inspection.save();
    return inspection;
  }

  await inspection.save();

  if (inspection.referenceType === 'PRODUCTION_BATCH') {
    if (inspection.inspectionType === 'IN_PROCESS') {
      await completeInProcessQc(inspection, userId);
    } else {
      await completeFinalQc(inspection, userId);
    }
  }

  return inspection;
}

async function completeIncomingQc(inspection, userId) {
  const grn = await GoodsReceipt.findById(inspection.referenceId);
  if (!grn) return;
  if (grn.status === 'COMPLETED') return;

  const receivedMaterialIds = [];
  const totalReceived = grn.lines.reduce((sum, line) => sum + (line.receivedQty || 0), 0);
  const passed = inspection.passedQuantity || 0;
  const failed = inspection.failedQuantity || 0;

  let acceptScale = 1;
  if (inspection.result === 'FAIL' || inspection.disposition === 'REJECT') {
    acceptScale = 0;
  } else if (inspection.result === 'PARTIAL' && passed > 0 && totalReceived > 0) {
    acceptScale = Math.min(1, passed / totalReceived);
  }

  let allocatedAccepted = 0;
  const lines = grn.lines.filter((l) => (l.receivedQty || 0) > 0);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    let accepted = 0;
    if (acceptScale > 0) {
      if (inspection.result === 'PARTIAL' && passed > 0 && totalReceived > 0) {
        if (i === lines.length - 1) {
          accepted = Math.max(0, Math.round((passed - allocatedAccepted) * 1000) / 1000);
        } else {
          accepted = Math.round(line.receivedQty * acceptScale * 1000) / 1000;
          allocatedAccepted += accepted;
        }
      } else {
        accepted = line.receivedQty;
      }
    }
    line.acceptedQty = accepted;
    line.rejectedQty = Math.max(0, line.receivedQty - accepted);
    if (accepted > 0) {
      const mat = await Material.findById(line.materialId);
      await inventoryService.receiptMaterial({
        factoryId: grn.factoryId,
        organizationId: grn.organizationId,
        materialId: line.materialId,
        quantity: accepted,
        unit: line.unit || mat?.unit,
        userId,
        storageBinId: inspection.storageBinId || undefined,
        referenceType: inspection.storageBinId ? 'BIN_RECEIPT' : 'GOODS_RECEIPT',
        referenceId: grn._id,
      });
      receivedMaterialIds.push(line.materialId);
    }
  }

  grn.status = 'COMPLETED';
  grn.qcInspectionId = inspection._id;
  grn.updatedBy = userId;
  await grn.save();

  if (receivedMaterialIds.length) {
    await productionService.tryUnblockProductionOrdersAfterReceipt({
      factoryId: grn.factoryId,
      materialIds: receivedMaterialIds,
      userId,
    });
  }
}

async function recordQcRejectWaste(inspection, batch, order, userId) {
  const qty = inspection.failedQuantity || 0;
  if (qty <= 0) return;

  await inventoryService.receiptRejectedGoods({
    factoryId: batch.factoryId,
    organizationId: batch.organizationId,
    skuId: order?.skuId,
    quantity: qty,
    userId,
  });

  await wasteService.createQcWasteRecord({
    factoryId: batch.factoryId,
    organizationId: batch.organizationId,
    wasteType: 'REJECTED_PIECES',
    batchId: batch._id,
    stage: inspection.stageAtInspection || batch.currentStage,
    skuId: order?.skuId,
    quantity: qty,
    userId,
  });
}

async function completeInProcessQc(inspection, userId) {
  const batch = await ProductionBatch.findById(inspection.referenceId);
  if (!batch) return;

  const stage = inspection.stageAtInspection || batch.currentStage;
  const order = await ProductionOrder.findById(batch.productionOrderId);

  if (inspection.disposition === 'REWORK' || inspection.result === 'REWORK') {
    await productionService.rollbackBatchStage(batch._id, userId);
    return;
  }

  if (inspection.disposition === 'REJECT' || inspection.result === 'FAIL') {
    await recordQcRejectWaste(inspection, batch, order, userId);
    return;
  }

  await productionService.markStageQcPassed(batch._id, stage, userId);
}

async function completeFinalQc(inspection, userId) {
  const batch = await ProductionBatch.findById(inspection.referenceId);
  if (!batch) return;

  const order = await ProductionOrder.findById(batch.productionOrderId);
  if (!order) return;

  const passed = inspection.passedQuantity || batch.producedQuantity;
  const failed = inspection.failedQuantity || 0;

  if (inspection.disposition === 'REWORK' || inspection.result === 'REWORK') {
    await productionService.rollbackBatchStage(batch._id, userId);
    return;
  }

  if (passed > 0 && inspection.result !== 'FAIL' && inspection.disposition !== 'REJECT') {
    const warehouse = await warehouseService.getDefaultWarehouse(batch.factoryId, 'FINISHED_GOODS');
    const balance = await inventoryService.receiptFinishedGoods({
      factoryId: batch.factoryId,
      organizationId: batch.organizationId,
      skuId: order.skuId,
      quantity: passed,
      locationId: warehouse?._id,
      storageBinId: inspection.storageBinId,
      userId,
    });

    if (inspection.storageBinId && !balance.storageBinId) {
      await warehouseService.putAwayFinishedGoods({
        factoryId: batch.factoryId,
        organizationId: batch.organizationId,
        skuId: order.skuId,
        binId: inspection.storageBinId,
        quantity: passed,
        userId,
      });
    }

    if (inspection.autoDispatchReady && inspection.storageBinId) {
      await warehouseService.markReadyForDispatch({
        factoryId: batch.factoryId,
        skuId: order.skuId,
        storageBinId: inspection.storageBinId,
        userId,
      });
    }
  }

  if (failed > 0) {
    await recordQcRejectWaste(inspection, batch, order, userId);
  }
}

export async function getInspectionQueue(factoryId) {
  return QualityInspection.find({
    factoryId,
    status: { $in: ['PENDING', 'IN_PROGRESS'] },
    isDeleted: false,
  })
    .populate('storageBinId', 'binCode zoneCode')
    .sort({ createdAt: 1 });
}
