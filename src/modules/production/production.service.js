import { ProductionOrder } from './productionOrder.model.js';
import { ProductionBatch } from './productionBatch.model.js';
import { ProductionSchedule } from './productionSchedule.model.js';
import { Sku } from '../sku/sku.model.js';
import { Bom } from '../bom/bom.model.js';
import { Material } from '../inventory/material.model.js';
import { Factory } from '../organization/factory.model.js';
import * as mrpService from '../mrp/mrp.service.js';
import * as inventoryService from '../inventory/inventory.service.js';
import { submitForApproval } from '../approval/approval.service.js';
import { syncApprovalApproved, syncApprovalRejected } from '../../shared/services/approvalSync.js';
import { getBatchStages, isQcGatedStage } from '../../shared/utils/productionStages.js';
import { nextDocumentNumber } from '../../shared/utils/numbering.js';
import { NotFoundError, ConflictError } from '../../shared/errors/AppError.js';
import { applySoftDeleteFilter } from '../../shared/utils/schema.js';
import { notify } from '../notification/notification.service.js';
import { Machine } from './machine.model.js';
import { ProductionLine } from './productionLine.model.js';

export async function getProductionStats(factoryId) {
  const base = applySoftDeleteFilter({ factoryId });
  const now = new Date();
  const [
    ordersTotal,
    ordersCreated,
    ordersMrpDone,
    ordersReserved,
    ordersApprovalPending,
    ordersApproved,
    ordersInProgress,
    ordersCompleted,
    batchesTotal,
    batchesCreated,
    batchesInProgress,
    batchesRework,
    batchesCompleted,
    overdueOrders,
    plannedSchedules,
    machineCount,
    lineCount,
  ] = await Promise.all([
    ProductionOrder.countDocuments(base),
    ProductionOrder.countDocuments({ ...base, status: 'CREATED' }),
    ProductionOrder.countDocuments({ ...base, status: 'MRP_DONE' }),
    ProductionOrder.countDocuments({ ...base, status: 'MATERIAL_RESERVED' }),
    ProductionOrder.countDocuments({ ...base, status: 'APPROVAL_PENDING' }),
    ProductionOrder.countDocuments({ ...base, status: 'APPROVED' }),
    ProductionOrder.countDocuments({ ...base, status: 'IN_PROGRESS' }),
    ProductionOrder.countDocuments({ ...base, status: 'COMPLETED' }),
    ProductionBatch.countDocuments(base),
    ProductionBatch.countDocuments({ ...base, status: 'CREATED' }),
    ProductionBatch.countDocuments({ ...base, status: 'IN_PROGRESS' }),
    ProductionBatch.countDocuments({ ...base, status: 'REWORK' }),
    ProductionBatch.countDocuments({ ...base, status: 'COMPLETED' }),
    ProductionOrder.countDocuments({
      ...base,
      deliveryDate: { $lt: now },
      status: { $nin: ['COMPLETED', 'CANCELLED'] },
    }),
    ProductionSchedule.countDocuments({ ...base, status: 'PLANNED' }),
    Machine.countDocuments({ factoryId, status: 'ACTIVE', isDeleted: false }),
    ProductionLine.countDocuments({ factoryId, status: 'ACTIVE', isDeleted: false }),
  ]);

  const machines = await Machine.find({ factoryId, status: 'ACTIVE', isDeleted: false }).select('capacityPerHour');
  const totalCapacityPerHour = machines.reduce((s, m) => s + (m.capacityPerHour || 0), 0);

  const activeOrders = await ProductionOrder.find({
    ...base,
    status: { $in: ['APPROVED', 'IN_PROGRESS'] },
  }).select('plannedQuantity producedQuantity');
  const plannedQty = activeOrders.reduce((s, o) => s + (o.plannedQuantity || 0), 0);
  const producedQty = activeOrders.reduce((s, o) => s + (o.producedQuantity || 0), 0);

  return {
    ordersTotal,
    ordersCreated,
    ordersMrpDone,
    ordersReserved,
    ordersApprovalPending,
    ordersApproved,
    ordersInProgress,
    ordersCompleted,
    batchesTotal,
    batchesCreated,
    batchesInProgress,
    batchesRework,
    batchesCompleted,
    overdueOrders,
    plannedSchedules,
    machineCount,
    lineCount,
    totalCapacityPerHour,
    plannedQty,
    producedQty,
    fulfillmentPct: plannedQty > 0 ? Math.round((producedQty / plannedQty) * 100) : 0,
  };
}

async function validateScheduleConflicts({ factoryId, machineId, shiftId, workerIds, plannedStart, plannedEnd, excludeId }) {
  if (!plannedStart || !plannedEnd) return;
  const filter = {
    factoryId,
    status: { $in: ['PLANNED', 'IN_PROGRESS'] },
    isDeleted: false,
    plannedStart: { $lt: new Date(plannedEnd) },
    plannedEnd: { $gt: new Date(plannedStart) },
  };
  if (excludeId) filter._id = { $ne: excludeId };

  if (machineId) {
    const conflict = await ProductionSchedule.findOne({ ...filter, machineId });
    if (conflict) throw new ConflictError('Machine already scheduled for this time window');
  }
  if (shiftId) {
    const conflict = await ProductionSchedule.findOne({ ...filter, shiftId });
    if (conflict) throw new ConflictError('Shift already scheduled for this time window');
  }
  if (workerIds?.length) {
    const conflict = await ProductionSchedule.findOne({ ...filter, workerIds: { $in: workerIds } });
    if (conflict) throw new ConflictError('One or more workers already scheduled for this time window');
  }
}

async function syncSchedulesForBatch(batch, stage, userId) {
  await ProductionSchedule.updateMany(
    { batchId: batch._id, factoryId: batch.factoryId, isDeleted: false },
    { stage, status: stage === 'COMPLETED' ? 'COMPLETED' : 'IN_PROGRESS', updatedBy: userId },
  );
}

export async function createProductionOrder({
  factoryId, organizationId, skuId, plannedQuantity, deliveryDate,
  priority, designId, plannedStart, plannedEnd,
}, userId) {
  const sku = await Sku.findOne(applySoftDeleteFilter({ _id: skuId, factoryId }));
  if (!sku) throw new NotFoundError('SKU not found');

  const bom = await Bom.findOne({ skuId, status: 'ACTIVE', isDeleted: false });
  if (!bom) throw new ConflictError('Active BOM required for production order');

  const factory = await Factory.findById(factoryId);
  const orderNumber = await nextDocumentNumber(factoryId, 'PROD', `PROD-${factory.code}-`);

  return ProductionOrder.create({
    organizationId,
    factoryId,
    orderNumber,
    designId: designId || sku.designId,
    skuId,
    bomId: bom._id,
    plannedQuantity,
    deliveryDate,
    priority: priority || 'NORMAL',
    plannedStart,
    plannedEnd,
    status: 'CREATED',
    createdBy: userId,
    updatedBy: userId,
  });
}

export async function updateProductionOrder(id, data, userId, factoryId) {
  const order = await getProductionOrder(id, factoryId);
  if (['COMPLETED', 'CANCELLED'].includes(order.status)) {
    throw new ConflictError('Cannot update completed or cancelled order');
  }
  const allowed = ['plannedQuantity', 'deliveryDate', 'priority', 'plannedStart', 'plannedEnd'];
  for (const key of allowed) {
    if (data[key] !== undefined) order[key] = data[key];
  }
  order.updatedBy = userId;
  await order.save();
  return order;
}

export async function cancelProductionOrder(id, userId, factoryId) {
  const order = await getProductionOrder(id, factoryId);
  if (['COMPLETED', 'CANCELLED'].includes(order.status)) {
    throw new ConflictError('Order already completed or cancelled');
  }
  if (['MATERIAL_RESERVED', 'APPROVAL_PENDING'].includes(order.status)) {
    await inventoryService.releaseReservations({
      factoryId: order.factoryId,
      organizationId: order.organizationId,
      referenceType: 'PRODUCTION_ORDER',
      referenceId: order._id,
      userId,
    });
  }
  order.status = 'CANCELLED';
  order.updatedBy = userId;
  await order.save();
  return order;
}

export async function listProductionOrders(factoryId, { page, limit, skip, status, priority, search }) {
  const filter = applySoftDeleteFilter({ factoryId });
  if (status) filter.status = status;
  if (priority) filter.priority = priority;
  if (search) {
    const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ orderNumber: re }];
  }
  const query = ProductionOrder.find(filter)
    .populate('skuId', 'skuCode name')
    .skip(skip)
    .limit(limit)
    .sort({ priority: -1, deliveryDate: 1, createdAt: -1 });
  if (search) {
    query.populate({ path: 'skuId', match: { $or: [{ skuCode: new RegExp(search, 'i') }, { name: new RegExp(search, 'i') }] } });
  }
  const [items, total] = await Promise.all([
    query,
    ProductionOrder.countDocuments(filter),
  ]);
  return { items, total };
}

export async function getProductionOrder(id, factoryId) {
  const filter = applySoftDeleteFilter({ _id: id });
  if (factoryId) filter.factoryId = factoryId;
  const order = await ProductionOrder.findOne(filter)
    .populate('skuId', 'skuCode name')
    .populate('bomId', 'bomCode')
    .populate('designId', 'designCode title');
  if (!order) throw new NotFoundError('Production order not found');
  return order;
}

export async function runProductionMrp(id, userId, factoryId) {
  const order = await getProductionOrder(id, factoryId);
  if (!['CREATED', 'MRP_DONE'].includes(order.status)) {
    throw new ConflictError('Cannot run MRP in current status');
  }

  const mrp = await mrpService.calculateMrp({
    bomId: order.bomId,
    skuId: order.skuId,
    factoryId: order.factoryId,
    organizationId: order.organizationId,
    orderQuantity: order.plannedQuantity,
    userId,
    referenceType: 'PRODUCTION_ORDER',
    referenceId: order._id,
  });

  order.mrpId = mrp._id;
  order.status = 'MRP_DONE';
  order.updatedBy = userId;
  await order.save();

  if (mrp.hasShortage && !order.suggestedPrId) {
    const { createPrFromMrp } = await import('../purchase/purchase.service.js');
    try {
      const pr = await createPrFromMrp(mrp._id, mrp.factoryId, userId);
      order.suggestedPrId = pr._id;
      await order.save();
    } catch {
      // PR may already exist for this MRP
    }
  }

  return { order, mrp };
}

export async function reserveProductionMaterials(id, userId, factoryId) {
  const order = await getProductionOrder(id, factoryId);
  if (order.status !== 'MRP_DONE') throw new ConflictError('Run MRP first');

  const mrp = await mrpService.getMrpForReference(order._id, 'PRODUCTION_ORDER');
  if (!mrp) throw new NotFoundError('MRP not found');

  for (const line of mrp.lines) {
    const mat = await Material.findById(line.materialId);
    await inventoryService.reserveMaterial({
      factoryId: order.factoryId,
      organizationId: order.organizationId,
      materialId: line.materialId,
      quantity: line.requiredQty,
      unit: line.unit || mat?.unit,
      referenceType: 'PRODUCTION_ORDER',
      referenceId: order._id,
      userId,
    });
  }

  order.status = 'MATERIAL_RESERVED';
  order.updatedBy = userId;
  await order.save();
  return order;
}

export async function submitProductionOrderForApproval(id, userId, factoryId) {
  const order = await getProductionOrder(id, factoryId);
  if (order.status !== 'MATERIAL_RESERVED') {
    throw new ConflictError('Materials must be reserved before approval submission');
  }
  order.status = 'APPROVAL_PENDING';
  order.updatedBy = userId;
  await order.save();

  await submitForApproval({
    organizationId: order.organizationId,
    factoryId: order.factoryId,
    documentType: 'PRODUCTION_ORDER',
    documentId: order._id,
    submittedBy: userId,
  });
  return order;
}

export async function approveProductionOrder(id, userId, { syncApproval = true, factoryId } = {}) {
  const order = await getProductionOrder(id, factoryId);
  if (order.status !== 'APPROVAL_PENDING') {
    throw new ConflictError('Production order must be submitted for approval first');
  }
  if (syncApproval) {
    await syncApprovalApproved('PRODUCTION_ORDER', order._id, userId);
  }
  order.status = 'APPROVED';
  order.approvedBy = userId;
  order.approvedAt = new Date();
  order.updatedBy = userId;
  await order.save();
  return order;
}

export async function rejectProductionOrder(id, userId, comments, { syncApproval = true, factoryId } = {}) {
  const order = await getProductionOrder(id, factoryId);
  if (order.status !== 'APPROVAL_PENDING') {
    throw new ConflictError('Production order not pending approval');
  }
  if (syncApproval) {
    await syncApprovalRejected('PRODUCTION_ORDER', order._id, userId, comments);
  }
  order.status = 'MATERIAL_RESERVED';
  order.rejectionComments = comments;
  order.updatedBy = userId;
  await order.save();
  return order;
}

export async function requestProductionRevision(id, userId, comments) {
  const order = await getProductionOrder(id);
  if (order.status !== 'APPROVAL_PENDING') {
    throw new ConflictError('Production order not pending approval');
  }
  await inventoryService.releaseReservations({
    factoryId: order.factoryId,
    organizationId: order.organizationId,
    referenceType: 'PRODUCTION_ORDER',
    referenceId: order._id,
    userId,
  });
  order.status = 'MRP_DONE';
  order.revisionComments = comments;
  order.updatedBy = userId;
  await order.save();
  return order;
}

export async function tryUnblockProductionOrdersAfterReceipt({ factoryId, materialIds, userId }) {
  if (!materialIds?.length) return { unblocked: [], notified: [] };

  const materialIdSet = new Set(materialIds.map((id) => id.toString()));
  const orders = await ProductionOrder.find({
    factoryId,
    status: 'MRP_DONE',
    isDeleted: false,
  });

  const unblocked = [];
  const notified = [];

  for (const order of orders) {
    const mrp = await mrpService.getMrpForReference(order._id, 'PRODUCTION_ORDER');
    if (!mrp) continue;

    const affected = mrp.lines.some(
      (l) => materialIdSet.has(l.materialId.toString()) && l.shortageQty > 0,
    );
    if (!affected) continue;

    const newMrp = await mrpService.calculateMrp({
      bomId: order.bomId,
      skuId: order.skuId,
      factoryId: order.factoryId,
      organizationId: order.organizationId,
      orderQuantity: order.plannedQuantity,
      userId,
      referenceType: 'PRODUCTION_ORDER',
      referenceId: order._id,
    });

    order.mrpId = newMrp._id;
    order.updatedBy = userId;
    await order.save();

    if (!newMrp.hasShortage) {
      try {
        await reserveProductionMaterials(order._id, userId, order.factoryId);
        unblocked.push(order.orderNumber);
        if (order.createdBy) {
          await notify({
            organizationId: order.organizationId,
            factoryId: order.factoryId,
            userId: order.createdBy,
            eventType: 'production.materials_ready',
            title: 'Materials available',
            message: `Stock received — ${order.orderNumber} materials reserved automatically`,
            referenceType: 'PRODUCTION_ORDER',
            referenceId: order._id,
          });
        }
      } catch (err) {
        notified.push(order.orderNumber);
        if (order.createdBy) {
          await notify({
            organizationId: order.organizationId,
            factoryId: order.factoryId,
            userId: order.createdBy,
            eventType: 'production.reserve_failed',
            title: 'Reserve still blocked',
            message: `Stock received for ${order.orderNumber} but reserve failed: ${err.message}`,
            referenceType: 'PRODUCTION_ORDER',
            referenceId: order._id,
          });
        }
      }
    } else if (order.createdBy) {
      notified.push(order.orderNumber);
      await notify({
        organizationId: order.organizationId,
        factoryId: order.factoryId,
        userId: order.createdBy,
        eventType: 'production.partial_stock',
        title: 'Partial stock received',
        message: `Materials received for ${order.orderNumber}; shortages remain — re-run MRP when ready`,
        referenceType: 'PRODUCTION_ORDER',
        referenceId: order._id,
      });
    }
  }

  return { unblocked, notified };
}

export async function createBatch({ productionOrderId, plannedQuantity, workerIds, shiftId, machineId }, userId, factoryId) {
  const order = await getProductionOrder(productionOrderId, factoryId);
  if (!['APPROVED', 'IN_PROGRESS'].includes(order.status)) {
    throw new ConflictError('Production order must be APPROVED');
  }

  const factory = await Factory.findById(order.factoryId);
  const batchNumber = await nextDocumentNumber(order.factoryId, 'BATCH', `BAT-${factory.code}-`);
  const stages = await getBatchStages(order.factoryId);

  const batch = await ProductionBatch.create({
    organizationId: order.organizationId,
    factoryId: order.factoryId,
    batchNumber,
    productionOrderId: order._id,
    plannedQuantity: plannedQuantity || order.plannedQuantity,
    status: 'CREATED',
    currentStage: stages[0],
    workerIds: workerIds || [],
    shiftId,
    machineId,
    createdBy: userId,
    updatedBy: userId,
  });

  order.status = 'IN_PROGRESS';
  order.updatedBy = userId;
  await order.save();

  await ProductionSchedule.updateMany(
    {
      productionOrderId: order._id,
      factoryId: order.factoryId,
      $or: [{ batchId: { $exists: false } }, { batchId: null }],
      isDeleted: false,
    },
    { batchId: batch._id, status: 'IN_PROGRESS', stage: stages[0], updatedBy: userId },
  );

  return batch;
}

export async function listBatches(factoryId, { page, limit, skip, status, stage, search, productionOrderId }) {
  const filter = applySoftDeleteFilter({ factoryId });
  if (status) filter.status = status;
  if (stage) filter.currentStage = stage;
  if (productionOrderId) filter.productionOrderId = productionOrderId;
  if (search) {
    const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.batchNumber = re;
  }
  const [items, total] = await Promise.all([
    ProductionBatch.find(filter)
      .populate('productionOrderId', 'orderNumber priority skuId')
      .populate('machineId', 'machineCode name')
      .populate('shiftId', 'name')
      .skip(skip)
      .limit(limit)
      .sort({ createdAt: -1 }),
    ProductionBatch.countDocuments(filter),
  ]);
  return { items, total };
}

export async function getBatch(id, factoryId) {
  const filter = applySoftDeleteFilter({ _id: id });
  if (factoryId) filter.factoryId = factoryId;
  const batch = await ProductionBatch.findOne(filter)
    .populate('productionOrderId')
    .populate('workerIds', 'firstName lastName')
    .populate('shiftId', 'name startTime endTime')
    .populate('machineId', 'name machineType machineCode');
  if (!batch) throw new NotFoundError('Batch not found');
  return batch;
}

export async function assignBatchResources(id, { workerIds, shiftId, machineId }, userId, factoryId) {
  const batch = await getBatch(id, factoryId);
  if (workerIds) batch.workerIds = workerIds;
  if (shiftId !== undefined) batch.shiftId = shiftId;
  if (machineId !== undefined) batch.machineId = machineId;
  batch.updatedBy = userId;
  await batch.save();
  return batch;
}

export async function startBatch(id, userId, factoryId) {
  const batch = await getBatch(id, factoryId);
  if (batch.status !== 'CREATED') throw new ConflictError('Batch already started');

  const order = await getProductionOrder(batch.productionOrderId);
  const mrp = await mrpService.getMrpForReference(order._id, 'PRODUCTION_ORDER');
  if (!mrp) throw new NotFoundError('MRP not found');

  const qtyRatio = batch.plannedQuantity / order.plannedQuantity;
  for (const line of mrp.lines) {
    const mat = await Material.findById(line.materialId);
    const issueQty = line.requiredQty * qtyRatio;
    await inventoryService.issueMaterial({
      factoryId: order.factoryId,
      organizationId: order.organizationId,
      materialId: line.materialId,
      quantity: issueQty,
      unit: line.unit || mat?.unit,
      referenceType: 'PRODUCTION_BATCH',
      referenceId: batch._id,
      reservationReferenceType: 'PRODUCTION_ORDER',
      reservationReferenceId: order._id,
      userId,
    });
  }

  batch.status = 'IN_PROGRESS';
  batch.stageHistory.push({ stage: batch.currentStage, startedAt: new Date() });
  batch.updatedBy = userId;
  await batch.save();
  return batch;
}

export async function markStageQcPassed(batchId, stage, userId) {
  const batch = await getBatch(batchId);
  if (!batch.stageQcPassed) batch.stageQcPassed = new Map();
  batch.stageQcPassed.set(stage, true);
  batch.updatedBy = userId;
  await batch.save();
  return batch;
}

export async function completeBatchStage(id, userId, {
  skipQcGate = false,
  machineHours = 0,
  labourHours = 0,
  scrapMaterialId,
  scrapQuantity = 0,
  scrapUnit,
  wasteType = 'FABRIC_SCRAP',
} = {}, factoryId) {
  const batch = await getBatch(id, factoryId);
  if (!['IN_PROGRESS', 'REWORK'].includes(batch.status)) {
    throw new ConflictError('Batch not in progress');
  }

  const stages = await getBatchStages(batch.factoryId);
  const stageIdx = stages.indexOf(batch.currentStage);
  if (stageIdx < 0) throw new ConflictError('Invalid stage');
  const stageBeingCompleted = batch.currentStage;

  if (!skipQcGate && isQcGatedStage(batch.currentStage)) {
    const passed = batch.stageQcPassed?.get?.(batch.currentStage)
      || batch.stageQcPassed?.[batch.currentStage];
    if (!passed) {
      throw new ConflictError(`In-process QC required before completing ${batch.currentStage}`);
    }
  }

  const history = batch.stageHistory.find((h) => h.stage === batch.currentStage && !h.completedAt);
  if (history) {
    history.completedAt = new Date();
    history.completedBy = userId;
  }

  const nextStage = stages[stageIdx + 1];
  if (!nextStage || nextStage === 'COMPLETED') {
    batch.currentStage = 'COMPLETED';
    batch.status = 'COMPLETED';
    batch.producedQuantity = batch.plannedQuantity;
  } else {
    batch.currentStage = nextStage;
    batch.stageHistory.push({ stage: nextStage, startedAt: new Date() });
    const order = await getProductionOrder(batch.productionOrderId);
    await inventoryService.recordWip({
      factoryId: order.factoryId,
      organizationId: order.organizationId,
      skuId: order.skuId,
      quantity: batch.plannedQuantity,
      stage: nextStage,
      userId,
    });
  }

  batch.updatedBy = userId;
  if (machineHours) batch.machineHours = (batch.machineHours || 0) + machineHours;
  if (labourHours) batch.labourHours = (batch.labourHours || 0) + labourHours;
  await batch.save();

  if (scrapMaterialId && scrapQuantity > 0) {
    const { createProductionScrap } = await import('../waste/waste.service.js');
    await createProductionScrap({
      factoryId: batch.factoryId,
      organizationId: batch.organizationId,
      batchId: batch._id,
      stage: stageBeingCompleted,
      materialId: scrapMaterialId,
      quantity: scrapQuantity,
      unit: scrapUnit,
      wasteType,
      userId,
    });
  }

  await syncSchedulesForBatch(batch, batch.currentStage, userId);

  if (batch.status === 'COMPLETED') {
    const order = await getProductionOrder(batch.productionOrderId);
    order.producedQuantity = (order.producedQuantity || 0) + batch.producedQuantity;
    if (order.producedQuantity >= order.plannedQuantity) order.status = 'COMPLETED';
    order.updatedBy = userId;
    await order.save();
    if (order.createdBy) {
      await notify({
        organizationId: order.organizationId,
        factoryId: order.factoryId,
        userId: order.createdBy,
        eventType: 'batch.completed',
        title: 'Batch completed',
        message: `${batch.batchNumber} ready for final QC`,
        referenceType: 'PRODUCTION_BATCH',
        referenceId: batch._id,
      });
    }
  }

  return batch;
}

export async function listBatchesByStage(factoryId, stage) {
  return ProductionBatch.find({ factoryId, currentStage: stage, isDeleted: false })
    .populate('productionOrderId', 'orderNumber priority deliveryDate');
}

export async function getBatchBoard(factoryId) {
  const stages = await getBatchStages(factoryId);
  const board = {};
  for (const stage of stages) {
    board[stage] = await listBatchesByStage(factoryId, stage);
  }
  return board;
}

export async function rollbackBatchStage(id, userId, factoryId) {
  const batch = await getBatch(id, factoryId);
  if (!['IN_PROGRESS', 'REWORK'].includes(batch.status)) {
    throw new ConflictError('Only in-progress batches can rollback');
  }
  const stages = await getBatchStages(batch.factoryId);
  const stageIdx = stages.indexOf(batch.currentStage);
  if (stageIdx <= 0) throw new ConflictError('Cannot rollback from first stage');

  const prevStage = stages[stageIdx - 1];
  const history = batch.stageHistory.find((h) => h.stage === batch.currentStage && !h.completedAt);
  if (history) history.completedAt = new Date();

  batch.currentStage = prevStage;
  batch.status = 'REWORK';
  batch.stageHistory.push({ stage: prevStage, startedAt: new Date() });
  batch.updatedBy = userId;
  await batch.save();
  return batch;
}

export async function createSchedule(data, userId) {
  const order = await getProductionOrder(data.productionOrderId);
  await validateScheduleConflicts({ factoryId: order.factoryId, ...data });
  return ProductionSchedule.create({
    organizationId: order.organizationId,
    factoryId: order.factoryId,
    ...data,
    createdBy: userId,
    updatedBy: userId,
  });
}

export async function listSchedules(factoryId, { page, limit, skip, from, to, productionOrderId, status }) {
  const filter = applySoftDeleteFilter({ factoryId });
  if (productionOrderId) filter.productionOrderId = productionOrderId;
  if (status) filter.status = status;
  if (from || to) {
    filter.plannedStart = {};
    if (from) filter.plannedStart.$gte = new Date(from);
    if (to) filter.plannedStart.$lte = new Date(to);
  }
  const [items, total] = await Promise.all([
    ProductionSchedule.find(filter)
      .populate('productionOrderId', 'orderNumber priority')
      .populate('batchId', 'batchNumber')
      .populate('machineId', 'machineCode name')
      .populate('shiftId', 'name')
      .populate('workerIds', 'firstName lastName')
      .skip(skip)
      .limit(limit)
      .sort({ plannedStart: 1 }),
    ProductionSchedule.countDocuments(filter),
  ]);
  return { items, total };
}

export async function updateSchedule(id, data, userId, factoryId) {
  const filter = applySoftDeleteFilter({ _id: id });
  if (factoryId) filter.factoryId = factoryId;
  const schedule = await ProductionSchedule.findOne(filter);
  if (!schedule) throw new NotFoundError('Schedule not found');
  const allowed = ['stage', 'productionLineId', 'machineId', 'shiftId', 'workerIds', 'plannedStart', 'plannedEnd', 'status', 'notes', 'batchId'];
  for (const key of allowed) {
    if (data[key] !== undefined) schedule[key] = data[key];
  }
  await validateScheduleConflicts({
    factoryId: schedule.factoryId,
    machineId: schedule.machineId,
    shiftId: schedule.shiftId,
    workerIds: schedule.workerIds,
    plannedStart: schedule.plannedStart,
    plannedEnd: schedule.plannedEnd,
    excludeId: schedule._id,
  });
  schedule.updatedBy = userId;
  await schedule.save();
  return schedule;
}

export async function getCapacitySummary(factoryId) {
  const stats = await getProductionStats(factoryId);
  return {
    inProgressBatches: stats.batchesInProgress,
    pendingOrders: stats.ordersApproved + stats.ordersInProgress,
    overdueOrders: stats.overdueOrders,
    machineCount: stats.machineCount,
    lineCount: stats.lineCount,
    totalCapacityPerHour: stats.totalCapacityPerHour,
    fulfillmentPct: stats.fulfillmentPct,
  };
}
