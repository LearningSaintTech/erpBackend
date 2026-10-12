import { ProductionOrder } from './productionOrder.model.js';
import { dedupeInflight } from '../../shared/utils/inflight.js';
import { ProductionBatch } from './productionBatch.model.js';
import { ProductionSchedule } from './productionSchedule.model.js';
import { Sku } from '../sku/sku.model.js';
import { Bom } from '../bom/bom.model.js';
import { Material } from '../inventory/material.model.js';
import { Factory } from '../organization/factory.model.js';
import * as mrpService from '../mrp/mrp.service.js';
import * as inventoryService from '../inventory/inventory.service.js';
import { submitForApproval } from '../approval/approval.service.js';
import { syncApprovalApproved, syncApprovalRejected, cancelPendingApproval } from '../../shared/services/approvalSync.js';
import { getBatchStages, isQcGatedStage } from '../../shared/utils/productionStages.js';
import { nextDocumentNumber } from '../../shared/utils/numbering.js';
import { NotFoundError, ConflictError } from '../../shared/errors/AppError.js';
import {
  applySoftDeleteFilter, asObjectId, escapeRegex, queryString,
} from '../../shared/utils/schema.js';
import { notify } from '../notification/notification.service.js';
import { Machine } from './machine.model.js';
import { ProductionLine } from './productionLine.model.js';
import { Shift } from './shift.model.js';
import { UserRoleAssignment } from '../user/userRoleAssignment.model.js';
import { StockReservation } from '../inventory/stockReservation.model.js';
import { aggregateRmTotals } from '../inventory/inventoryStock.service.js';
import { QualityInspection } from '../quality/qualityInspection.model.js';
import { syncWipForBatch } from './wip.service.js';

/** Stale startBatch claims (crashed mid-issue) can be re-claimed after this long. */
const START_CLAIM_STALE_MS = 10 * 60 * 1000;

/**
 * Notify everyone in the factory holding any of `permissions` (role or active delegation).
 * Never throws — notifications must not fail a committed shop-floor transition.
 */
export async function notifyFactoryRole(factoryId, organizationId, permissions, payload, { excludeUserId } = {}) {
  try {
    const { findUserIdsWithFactoryPermission } = await import('../user/user.service.js');
    const ids = await findUserIdsWithFactoryPermission(factoryId, permissions, { excludeUserId });
    await Promise.all(ids.map((userId) => notify({ organizationId, factoryId, userId, ...payload }).catch(() => {})));
  } catch (err) {
    console.warn(`[production] ${payload?.eventType} notification failed:`, err?.message);
  }
}

const stageName = (s) => String(s || '').charAt(0) + String(s || '').slice(1).toLowerCase().replace(/_/g, ' ');

/** The batch now sits at a QC-gated stage — tell the QC inspectors there is in-process work. */
async function notifyInProcessQcDue(batch, userId) {
  if (!batch || !isStageQcGated(batch.currentStage) || batch.stageQcPassed?.get?.(batch.currentStage)) return;
  await notifyFactoryRole(batch.factoryId, batch.organizationId, ['quality.update'], {
    eventType: 'quality.in_process_due',
    title: 'In-process QC needed',
    message: `${batch.batchNumber} is at ${stageName(batch.currentStage)} and needs an in-process inspection`,
    referenceType: 'QUALITY_INSPECTION', // links QC users to the Quality page (they cannot open Production)
    referenceId: batch._id,
  }, { excludeUserId: userId });
}

/** Throws NotFoundError unless the referenced doc exists, is live, and belongs to the factory. */
async function assertInFactory(Model, id, factoryId, label) {
  if (id === undefined || id === null || id === '') return;
  const exists = await Model.exists({ _id: id, factoryId, isDeleted: false });
  if (!exists) throw new NotFoundError(`${label} not found`);
}

/** Workers must hold a role assignment in this factory. */
export async function assertWorkersInFactory(workerIds, factoryId) {
  if (!Array.isArray(workerIds) || !workerIds.length) return;
  const unique = [...new Set(workerIds.map((w) => String(w)))];
  const found = await UserRoleAssignment.distinct('userId', { userId: { $in: unique }, factoryId });
  if (found.length < unique.length) throw new NotFoundError('One or more workers not found in this factory');
}

/**
 * People who can be put on a batch: active users holding a role in this factory, with their role name.
 * Planners / supervisors need this list without the user-admin permission that GET /users requires.
 */
export async function listAssignableWorkers(factoryId) {
  const assignments = await UserRoleAssignment.find({
    factoryId,
    $or: [{ expiresAt: null }, { expiresAt: { $exists: false } }, { expiresAt: { $gt: new Date() } }],
  })
    .populate('userId', 'firstName lastName email status isDeleted')
    .populate('roleId', 'name code')
    .lean();
  const byUser = new Map();
  for (const a of assignments) {
    const u = a.userId;
    if (!u || u.isDeleted || u.status !== 'ACTIVE') continue;
    const key = String(u._id);
    const entry = byUser.get(key) || {
      _id: u._id, firstName: u.firstName, lastName: u.lastName, email: u.email, roles: [],
    };
    if (a.roleId?.name && !entry.roles.includes(a.roleId.name)) entry.roles.push(a.roleId.name);
    byUser.set(key, entry);
  }
  return [...byUser.values()].sort((x, y) => `${x.firstName} ${x.lastName}`.localeCompare(`${y.firstName} ${y.lastName}`));
}

/** Machines under MAINTENANCE / INACTIVE cannot take new batch or schedule assignments. */
async function assertMachineAssignable(machineId, factoryId) {
  if (machineId === undefined || machineId === null || machineId === '') return;
  const machine = await Machine.findOne({ _id: machineId, factoryId, isDeleted: false }).select('status machineCode');
  if (!machine) throw new NotFoundError('Machine not found');
  if (machine.status !== 'ACTIVE') {
    throw new ConflictError(
      `Machine ${machine.machineCode || machineId} is ${String(machine.status).toLowerCase()} — only ACTIVE machines can be assigned`,
    );
  }
}

/**
 * Shifts are assigned from the Shift collection only (managed on the Machines & Shifts page).
 * FactorySettings.shifts is a separate legacy list and is not accepted here.
 */
async function assertBatchResourcesInFactory({ workerIds, shiftId, machineId, productionLineId }, factoryId) {
  await assertMachineAssignable(machineId, factoryId);
  await assertInFactory(Shift, shiftId, factoryId, 'Shift');
  await assertInFactory(ProductionLine, productionLineId, factoryId, 'Production line');
  await assertWorkersInFactory(workerIds, factoryId);
}

const BATCH_CLOSED_STATUSES = ['COMPLETED', 'CANCELLED'];
const BATCH_RUNNING_STATUSES = ['IN_PROGRESS', 'REWORK'];
const ROUND = (n) => Math.round(n * 1000) / 1000;

function normalizeStage(stage) {
  return String(stage || '').trim().toUpperCase();
}

/** QC gating keeps the hard-coded stage set, compared on normalized uppercase names. */
export function isStageQcGated(stage) {
  return isQcGatedStage(normalizeStage(stage));
}

/** The batch's own frozen stage list; falls back to current settings for batches created before snapshots. */
export async function stagesForBatch(batch) {
  if (Array.isArray(batch?.stages) && batch.stages.length) return [...batch.stages];
  return getBatchStages(batch.factoryId);
}

/** Good pieces still in a batch after in-process rejects. */
export function batchGoodQuantity(batch) {
  return Math.max(0, ROUND((batch.plannedQuantity || 0) - (batch.rejectedQuantity || 0)));
}

/** Material cost per planned piece — used to value QC reject waste. */
export function batchCostPerPiece(batch, order) {
  if ((batch?.actualMaterialCost || 0) > 0 && batch.plannedQuantity > 0) {
    return Math.round((batch.actualMaterialCost / batch.plannedQuantity) * 100) / 100;
  }
  if (order?.plannedQuantity > 0 && (order.standardMaterialCost || 0) > 0) {
    return Math.round((order.standardMaterialCost / order.plannedQuantity) * 100) / 100;
  }
  return order?.standardCostPerPiece || 0;
}

/** Concurrent callers for the same factory share one computation (dashboard fan-out, perf audit). */
export const getProductionStats = dedupeInflight((factoryId) => computeProductionStats(factoryId));

async function computeProductionStats(factoryId) {
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
    ordersCancelled,
    batchesTotal,
    batchesCreated,
    batchesRunning,
    batchesRework,
    batchesCompleted,
    batchesCancelled,
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
    ProductionOrder.countDocuments({ ...base, status: 'CANCELLED' }),
    ProductionBatch.countDocuments(base),
    ProductionBatch.countDocuments({ ...base, status: 'CREATED' }),
    ProductionBatch.countDocuments({ ...base, status: { $in: BATCH_RUNNING_STATUSES } }),
    ProductionBatch.countDocuments({ ...base, status: 'REWORK' }),
    ProductionBatch.countDocuments({ ...base, status: 'COMPLETED' }),
    ProductionBatch.countDocuments({ ...base, status: 'CANCELLED' }),
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

  // Fulfillment = final-QC passed / planned over every non-cancelled order.
  // Summed in MongoDB — hydrating every order document made this O(orders) in JS (perf audit).
  const [qty] = await ProductionOrder.aggregate([
    { $match: { factoryId: asObjectId(factoryId), isDeleted: false, status: { $ne: 'CANCELLED' } } },
    {
      $group: {
        _id: null,
        planned: { $sum: { $ifNull: ['$plannedQuantity', 0] } },
        produced: { $sum: { $ifNull: ['$producedQuantity', 0] } },
        passed: { $sum: { $ifNull: ['$passedQuantity', 0] } },
        rejected: { $sum: { $ifNull: ['$rejectedQuantity', 0] } },
      },
    },
  ]);
  const plannedQty = qty?.planned || 0;
  const producedQty = qty?.produced || 0;
  const passedQty = qty?.passed || 0;
  const rejectedQty = qty?.rejected || 0;

  return {
    ordersTotal,
    ordersCreated,
    ordersMrpDone,
    ordersReserved,
    ordersApprovalPending,
    ordersApproved,
    ordersInProgress,
    ordersCompleted,
    ordersCancelled,
    batchesTotal,
    batchesCreated,
    /** IN_PROGRESS + REWORK (both are on the floor). */
    batchesInProgress: batchesRunning,
    batchesRework,
    batchesCompleted,
    batchesCancelled,
    overdueOrders,
    plannedSchedules,
    machineCount,
    lineCount,
    totalCapacityPerHour,
    plannedQty,
    producedQty,
    passedQty,
    rejectedQty,
    fulfillmentPct: plannedQty > 0 ? Math.min(100, Math.round((passedQty / plannedQty) * 100)) : 0,
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
    {
      batchId: batch._id,
      factoryId: batch.factoryId,
      isDeleted: false,
      status: { $ne: 'CANCELLED' },
    },
    { stage, status: stage === 'COMPLETED' ? 'COMPLETED' : 'IN_PROGRESS', updatedBy: userId },
  );
}

/** Cancel open (PLANNED / IN_PROGRESS) schedules matching `scope` (an order or a batch). */
async function cancelOpenSchedules(scope, userId) {
  await ProductionSchedule.updateMany(
    { ...scope, isDeleted: false, status: { $in: ['PLANNED', 'IN_PROGRESS'] } },
    { $set: { status: 'CANCELLED', updatedBy: userId, updatedAt: new Date() } },
  );
}

function releaseOrderReservations(order, userId) {
  return inventoryService.releaseReservations({
    factoryId: order.factoryId,
    organizationId: order.organizationId,
    referenceType: 'PRODUCTION_ORDER',
    referenceId: order._id,
    userId,
  });
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

  const standardCostPerPiece = bom.totalCostPerPiece || 0;
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
    standardCostPerPiece,
    standardMaterialCost: Math.round(standardCostPerPiece * plannedQuantity * 100) / 100,
    actualMaterialCost: 0,
    createdBy: userId,
    updatedBy: userId,
  });
}

export async function updateProductionOrder(id, data, userId, factoryId) {
  const order = await getProductionOrder(id, factoryId);
  if (['COMPLETED', 'CANCELLED'].includes(order.status)) {
    throw new ConflictError('Cannot update completed or cancelled order');
  }
  const qtyChanged = data.plannedQuantity !== undefined
    && Number(data.plannedQuantity) !== Number(order.plannedQuantity);
  if (qtyChanged) {
    // MRP output / reservations / batches are sized from plannedQuantity — only editable before reserve.
    if (!['CREATED', 'MRP_DONE'].includes(order.status)) {
      throw new ConflictError('Planned quantity cannot change once materials are reserved');
    }
    if (order.status === 'MRP_DONE') order.status = 'CREATED'; // force MRP re-run for the new qty
    order.standardMaterialCost = Math.round((order.standardCostPerPiece || 0) * data.plannedQuantity * 100) / 100;
    // Any hold left by a partially failed reserve was sized for the old qty — drop it.
    await releaseOrderReservations(order, userId);
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
  const activeBatch = await ProductionBatch.exists({
    productionOrderId: order._id,
    factoryId: order.factoryId,
    isDeleted: false,
    $or: [
      { status: { $in: ['IN_PROGRESS', 'REWORK'] } },
      { status: 'CREATED', startingAt: { $ne: null } },
    ],
  });
  if (activeBatch) {
    throw new ConflictError('Cannot cancel an order with batches in progress');
  }

  const cancelled = await ProductionOrder.findOneAndUpdate(
    { _id: order._id, factoryId: order.factoryId, status: { $nin: ['COMPLETED', 'CANCELLED'] } },
    { $set: { status: 'CANCELLED', updatedBy: userId, updatedAt: new Date() } },
    { new: true },
  );
  if (!cancelled) throw new ConflictError('Order already completed or cancelled');

  await ProductionBatch.updateMany(
    { productionOrderId: order._id, factoryId: order.factoryId, status: 'CREATED', isDeleted: false },
    { $set: { status: 'CANCELLED', closedReason: 'ORDER_CANCELLED', updatedBy: userId, updatedAt: new Date() } },
  );
  await cancelOpenSchedules({ productionOrderId: order._id, factoryId: order.factoryId }, userId);

  // An order cancelled while APPROVAL_PENDING must not linger in the approvals inbox.
  await cancelPendingApproval('PRODUCTION_ORDER', order._id, userId, 'Production order cancelled');

  // Release whatever is still reserved (no-op when nothing is active).
  await releaseOrderReservations(order, userId);
  return getProductionOrder(order._id, order.factoryId);
}

export async function listProductionOrders(factoryId, { page, limit, skip, status, priority, search, overdue }) {
  const filter = applySoftDeleteFilter({ factoryId });
  const statusQ = queryString(status);
  const priorityQ = queryString(priority);
  const searchQ = queryString(search)?.trim();
  if (statusQ) filter.status = statusQ;
  if (priorityQ) filter.priority = priorityQ;
  // Same rule as getProductionStats().overdueOrders, so the dashboard tile and list agree.
  if (queryString(overdue) === 'true') {
    filter.deliveryDate = { $lt: new Date() };
    if (!statusQ) filter.status = { $nin: ['COMPLETED', 'CANCELLED'] };
  }
  if (searchQ) {
    const re = new RegExp(escapeRegex(searchQ), 'i');
    const skuIds = await Sku.find(applySoftDeleteFilter({ factoryId, $or: [{ skuCode: re }, { name: re }] }))
      .distinct('_id');
    filter.$or = [{ orderNumber: re }];
    if (skuIds.length) filter.$or.push({ skuId: { $in: skuIds } });
  }
  const query = ProductionOrder.find(filter)
    .populate('skuId', 'skuCode name')
    .skip(skip)
    .limit(limit)
    .sort({ priority: -1, deliveryDate: 1, createdAt: -1 });
  const [docs, total] = await Promise.all([
    query,
    ProductionOrder.countDocuments(filter),
  ]);

  // remainingToBatch: what a new batch may still take (same rule as createBatch's cap).
  const batchRows = docs.length ? await ProductionBatch.aggregate([
    {
      $match: {
        factoryId: asObjectId(factoryId),
        productionOrderId: { $in: docs.map((o) => o._id) },
        isDeleted: false,
        status: { $ne: 'CANCELLED' },
      },
    },
    {
      $group: {
        _id: '$productionOrderId',
        planned: { $sum: '$plannedQuantity' },
        rejected: {
          $sum: { $add: [{ $ifNull: ['$rejectedQuantity', 0] }, { $ifNull: ['$finalRejectedQuantity', 0] }] },
        },
        running: { $sum: { $cond: [{ $in: ['$status', BATCH_RUNNING_STATUSES] }, 1, 0] } },
      },
    },
  ]) : [];
  const byOrder = new Map(batchRows.map((r) => [String(r._id), r]));
  const items = docs.map((o) => {
    const row = byOrder.get(String(o._id));
    return {
      ...o.toObject(),
      remainingToBatch: Math.max(0, ROUND((o.plannedQuantity || 0) - (row?.planned || 0) + (row?.rejected || 0))),
      runningBatches: row?.running || 0,
    };
  });
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

  if (mrp.hasShortage) {
    // createPrFromMrp is idempotent: returns the existing / covering PR (re-raised after REJECTED/CANCELLED).
    const { createPrFromMrp } = await import('../purchase/purchase.service.js');
    try {
      const pr = await createPrFromMrp(mrp._id, mrp.factoryId, userId);
      if (pr?._id && String(pr._id) !== String(order.suggestedPrId || '')) {
        order.suggestedPrId = pr._id;
        await order.save();
      }
    } catch (err) {
      console.warn(`[production] shortage PR for ${order.orderNumber} failed:`, err?.message);
    }
  }

  return { order, mrp };
}

export async function reserveProductionMaterials(id, userId, factoryId) {
  const order = await getProductionOrder(id, factoryId);
  if (order.status !== 'MRP_DONE') throw new ConflictError('Run MRP first');

  const mrp = await mrpService.getMrpForReference(order._id, 'PRODUCTION_ORDER');
  if (!mrp) throw new NotFoundError('MRP not found');

  // All-or-nothing: drop any hold left by an earlier partial attempt, and undo ours on failure.
  await releaseOrderReservations(order, userId);
  try {
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
  } catch (err) {
    await releaseOrderReservations(order, userId).catch((releaseErr) => {
      console.warn('[production] releasing partial reservations failed:', releaseErr?.message);
    });
    throw err;
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

export async function requestProductionRevision(id, userId, comments, { factoryId } = {}) {
  const order = await getProductionOrder(id, factoryId);
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

/**
 * Quantity still open for batching on an order.
 * remaining = planned − Σ planned(non-cancelled batches) + Σ rejects(in-process + final) of those batches,
 * so pieces lost to QC can be made up with a top-up batch.
 */
export async function getBatchableQuantity(order) {
  const rows = await ProductionBatch.aggregate([
    {
      $match: {
        productionOrderId: order._id,
        factoryId: order.factoryId,
        isDeleted: false,
        status: { $ne: 'CANCELLED' },
      },
    },
    {
      $group: {
        _id: null,
        planned: { $sum: '$plannedQuantity' },
        rejected: {
          $sum: { $add: [{ $ifNull: ['$rejectedQuantity', 0] }, { $ifNull: ['$finalRejectedQuantity', 0] }] },
        },
      },
    },
  ]);
  const planned = rows[0]?.planned || 0;
  const rejected = rows[0]?.rejected || 0;
  return ROUND((order.plannedQuantity || 0) - planned + rejected);
}

export async function createBatch({ productionOrderId, plannedQuantity, workerIds, shiftId, machineId }, userId, factoryId) {
  const order = await getProductionOrder(productionOrderId, factoryId);
  if (!['APPROVED', 'IN_PROGRESS'].includes(order.status)) {
    throw new ConflictError('Production order must be APPROVED');
  }
  await assertBatchResourcesInFactory({ workerIds, shiftId, machineId }, order.factoryId);

  const remaining = await getBatchableQuantity(order);
  if (remaining <= 0) throw new ConflictError('Order quantity is already fully batched');
  const qty = plannedQuantity ?? remaining;
  if (qty > remaining) {
    throw new ConflictError(`Batch quantity (${qty}) exceeds remaining order quantity (${remaining})`);
  }

  const factory = await Factory.findById(order.factoryId);
  const batchNumber = await nextDocumentNumber(order.factoryId, 'BATCH', `BAT-${factory.code}-`);
  const stages = await getBatchStages(order.factoryId);

  const batch = await ProductionBatch.create({
    organizationId: order.organizationId,
    factoryId: order.factoryId,
    batchNumber,
    productionOrderId: order._id,
    plannedQuantity: qty,
    status: 'CREATED',
    currentStage: stages[0],
    stages,
    workerIds: workerIds || [],
    shiftId,
    machineId,
    createdBy: userId,
    updatedBy: userId,
  });

  // Concurrent creates can both pass the pre-check — re-check and back ours out if over-batched.
  if (await getBatchableQuantity(order) < 0) {
    await ProductionBatch.updateOne({ _id: batch._id }, { $set: { isDeleted: true, updatedBy: userId } });
    throw new ConflictError('Order quantity is already fully batched (concurrent batch created)');
  }

  await ProductionOrder.updateOne(
    { _id: order._id, status: { $in: ['APPROVED', 'IN_PROGRESS'] } },
    { $set: { status: 'IN_PROGRESS', updatedBy: userId, updatedAt: new Date() } },
  );

  // Order-level schedules are attached only when this is the order's sole batch — with several
  // batches there is no way to tell which one a schedule was meant for, so they stay unlinked.
  const batchCount = await ProductionBatch.countDocuments({
    productionOrderId: order._id,
    factoryId: order.factoryId,
    isDeleted: false,
    status: { $ne: 'CANCELLED' },
  });
  if (batchCount === 1) {
    await ProductionSchedule.updateMany(
      {
        productionOrderId: order._id,
        factoryId: order.factoryId,
        $or: [{ batchId: { $exists: false } }, { batchId: null }],
        status: { $in: ['PLANNED', 'IN_PROGRESS'] },
        isDeleted: false,
      },
      { batchId: batch._id, stage: stages[0], updatedBy: userId },
    );
  }

  return batch;
}

export async function listBatches(factoryId, { page, limit, skip, status, stage, search, productionOrderId }) {
  const filter = applySoftDeleteFilter({ factoryId });
  const statusQ = queryString(status);
  const stageQ = queryString(stage);
  const orderQ = queryString(productionOrderId);
  const searchQ = queryString(search)?.trim();
  if (statusQ) filter.status = statusQ;
  if (stageQ) filter.currentStage = stageQ;
  if (orderQ) filter.productionOrderId = orderQ;
  if (searchQ) filter.batchNumber = new RegExp(escapeRegex(searchQ), 'i');
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

/**
 * Batch detail for the UI: material refs and the batch's QC results are embedded so planners and
 * operators (no inventory / quality read rights) still see what was issued and what QC decided.
 */
export async function getBatchDetail(id, factoryId) {
  const batch = await getBatch(id, factoryId);
  await batch.populate('issuedMaterials.materialId', 'materialCode name unit');
  const inspections = await QualityInspection.find({
    factoryId: batch.factoryId,
    referenceType: 'PRODUCTION_BATCH',
    referenceId: batch._id,
    isDeleted: false,
  })
    .select('inspectionNumber inspectionType stageAtInspection status result disposition passedQuantity failedQuantity completedAt')
    .sort({ createdAt: 1 })
    .lean();
  return { ...batch.toObject(), inspections };
}

export async function assignBatchResources(id, { workerIds, shiftId, machineId }, userId, factoryId) {
  const batch = await getBatch(id, factoryId);
  if (BATCH_CLOSED_STATUSES.includes(batch.status)) {
    throw new ConflictError(`Cannot reassign resources on a ${batch.status.toLowerCase()} batch`);
  }
  await assertBatchResourcesInFactory({
    workerIds,
    shiftId: shiftId || undefined,
    machineId: machineId || undefined,
  }, batch.factoryId);
  if (workerIds) batch.workerIds = workerIds;
  if (shiftId !== undefined) batch.shiftId = shiftId;
  if (machineId !== undefined) batch.machineId = machineId;
  batch.updatedBy = userId;
  await batch.save();
  return batch;
}

export async function startBatch(id, userId, factoryId) {
  const existing = await getBatch(id, factoryId);
  if (existing.status !== 'CREATED') throw new ConflictError('Batch already started');

  const order = await getProductionOrder(existing.productionOrderId, existing.factoryId);
  if (!['APPROVED', 'IN_PROGRESS'].includes(order.status)) {
    throw new ConflictError(`Cannot start a batch on a ${order.status.toLowerCase()} production order`);
  }
  const mrp = await mrpService.getMrpForReference(order._id, 'PRODUCTION_ORDER');
  if (!mrp) throw new NotFoundError('MRP not found');

  // Atomic claim: only one request may issue materials for this batch.
  const claimAt = new Date();
  const claimed = await ProductionBatch.findOneAndUpdate(
    {
      _id: existing._id,
      factoryId: existing.factoryId,
      status: 'CREATED',
      isDeleted: false,
      $or: [
        { startingAt: null },
        { startingAt: { $lt: new Date(claimAt.getTime() - START_CLAIM_STALE_MS) } },
      ],
    },
    { $set: { startingAt: claimAt, updatedBy: userId } },
    { new: true },
  );
  if (!claimed) throw new ConflictError('Batch already started or start in progress');

  const releaseClaim = () => ProductionBatch.updateOne(
    { _id: claimed._id, startingAt: claimAt },
    { $unset: { startingAt: 1 } },
  );

  try {
    const qtyRatio = claimed.plannedQuantity / order.plannedQuantity;
    // Lines already issued by an earlier, partially failed attempt are skipped (no double issue).
    const alreadyIssued = new Set((claimed.issuedMaterials || []).map((m) => String(m.materialId)));
    const plan = [];
    for (const line of mrp.lines) {
      if (alreadyIssued.has(String(line.materialId))) continue;
      const mat = await Material.findOne({ _id: line.materialId, factoryId: order.factoryId });
      const issueQty = line.requiredQty * qtyRatio;
      if (!(issueQty > 0)) continue;
      plan.push({ line, mat, issueQty });
    }

    // Pre-check every line before issuing anything: free stock + this order's own reservation.
    const shortages = [];
    for (const { line, mat, issueQty } of plan) {
      const [totals, ownReserved] = await Promise.all([
        aggregateRmTotals(order.factoryId, line.materialId),
        StockReservation.aggregate([
          {
            $match: {
              factoryId: order.factoryId,
              materialId: line.materialId,
              referenceType: 'PRODUCTION_ORDER',
              referenceId: order._id,
              status: 'ACTIVE',
              isDeleted: false,
            },
          },
          { $group: { _id: null, qty: { $sum: '$quantity' } } },
        ]).then((rows) => rows[0]?.qty || 0),
      ]);
      const usable = Math.min(totals.onHand, totals.available + ownReserved);
      if (usable + 1e-9 < issueQty) {
        shortages.push(`${mat?.materialCode || line.materialId}: need ${issueQty}, available ${usable}`);
      }
    }
    if (shortages.length) {
      throw new ConflictError(`Insufficient stock to start batch — ${shortages.join('; ')}`);
    }

    for (const { line, mat, issueQty } of plan) {
      const unitCost = mat?.unitCost || 0;
      const entry = {
        materialId: line.materialId,
        quantity: issueQty,
        unit: line.unit || mat?.unit,
        unitCost,
        extendedCost: Math.round(issueQty * unitCost * 100) / 100,
      };
      await inventoryService.issueMaterial({
        factoryId: order.factoryId,
        organizationId: order.organizationId,
        materialId: line.materialId,
        quantity: issueQty,
        unit: entry.unit,
        referenceType: 'PRODUCTION_BATCH',
        referenceId: claimed._id,
        reservationReferenceType: 'PRODUCTION_ORDER',
        reservationReferenceId: order._id,
        userId,
      });
      // Record each issue immediately so a retry after a later failure skips it.
      await ProductionBatch.updateOne({ _id: claimed._id }, { $push: { issuedMaterials: entry } });
    }

    const fresh = await ProductionBatch.findById(claimed._id).select('issuedMaterials');
    const actual = Math.round(
      (fresh.issuedMaterials || []).reduce((s, m) => s + (m.extendedCost || 0), 0) * 100,
    ) / 100;

    const started = await ProductionBatch.findOneAndUpdate(
      { _id: claimed._id, status: 'CREATED', startingAt: claimAt },
      {
        $set: { status: 'IN_PROGRESS', actualMaterialCost: actual, updatedBy: userId, updatedAt: new Date() },
        $unset: { startingAt: 1 },
        $push: { stageHistory: { stage: claimed.currentStage, startedAt: new Date() } },
      },
      { new: true },
    );
    if (!started) throw new ConflictError('Batch start claim lost — retry');

    await ProductionOrder.updateOne(
      { _id: order._id },
      { $inc: { actualMaterialCost: actual }, $set: { updatedBy: userId } },
    );
    await syncWipForBatch(started, userId);
    await syncSchedulesForBatch(started, started.currentStage, userId).catch((e) => {
      console.warn('[production] schedule sync on start failed:', e?.message);
    });
    await notifyInProcessQcDue(started, userId);
    return getBatch(claimed._id, claimed.factoryId);
  } catch (err) {
    await releaseClaim();
    throw err;
  }
}

export async function markStageQcPassed(batchId, stage, userId, factoryId) {
  const filter = { _id: batchId, isDeleted: false };
  if (factoryId) filter.factoryId = factoryId;
  const updated = await ProductionBatch.findOneAndUpdate(
    filter,
    { $set: { [`stageQcPassed.${stage}`]: true, updatedBy: userId, updatedAt: new Date() } },
    { new: true },
  );
  if (!updated) throw new NotFoundError('Batch not found');
  // Tell the people on the batch they can carry on (operators have no Quality page to watch).
  const recipients = new Set((updated.workerIds || []).map(String));
  await Promise.all([...recipients].filter((id) => id !== String(userId)).map((recipient) => notify({
    organizationId: updated.organizationId,
    factoryId: updated.factoryId,
    userId: recipient,
    eventType: 'quality.in_process_passed',
    title: 'Stage QC passed',
    message: `${updated.batchNumber}: ${stageName(stage)} passed in-process QC — complete the stage to move on`,
    referenceType: 'PRODUCTION_BATCH',
    referenceId: updated._id,
  }).catch(() => {})));
  return updated;
}

/**
 * Order completion is driven by final QC: the order becomes COMPLETED only when every
 * non-cancelled batch has a COMPLETED FINAL inspection and passedQuantity >= plannedQuantity.
 * Remaining ACTIVE material reservations of the order are released on completion.
 */
export async function refreshOrderCompletion(orderId, factoryId, userId) {
  const order = await ProductionOrder.findOne({ _id: orderId, factoryId, isDeleted: false });
  if (!order || order.status !== 'IN_PROGRESS') return order;
  if ((order.passedQuantity || 0) < (order.plannedQuantity || 0)) return order;

  const batches = await ProductionBatch.find({
    productionOrderId: order._id,
    factoryId: order.factoryId,
    isDeleted: false,
    status: { $ne: 'CANCELLED' },
  }).select('status qcInspectionId');
  if (!batches.length) return order;
  if (batches.some((b) => b.status !== 'COMPLETED' || !b.qcInspectionId)) return order;
  const finalDone = await QualityInspection.countDocuments({
    _id: { $in: batches.map((b) => b.qcInspectionId) },
    factoryId: order.factoryId,
    inspectionType: 'FINAL',
    status: 'COMPLETED',
    isDeleted: false,
  });
  if (finalDone < batches.length) return order;

  const completed = await ProductionOrder.findOneAndUpdate(
    { _id: order._id, factoryId: order.factoryId, status: 'IN_PROGRESS' },
    { $set: { status: 'COMPLETED', updatedBy: userId, updatedAt: new Date() } },
    { new: true },
  );
  if (!completed) return order;

  try {
    await releaseOrderReservations(completed, userId);
  } catch (err) {
    console.warn('[production] releasing reservations on completion failed:', err?.message);
  }
  if (completed.createdBy) {
    await notify({
      organizationId: completed.organizationId,
      factoryId: completed.factoryId,
      userId: completed.createdBy,
      eventType: 'production.completed',
      title: 'Production order completed',
      message: `${completed.orderNumber} completed — ${completed.passedQuantity} pcs passed final QC`,
      referenceType: 'PRODUCTION_ORDER',
      referenceId: completed._id,
    }).catch(() => {});
  }
  return completed;
}

/** Close a batch whose every piece was rejected: CANCELLED (closedReason ALL_PIECES_REJECTED), no final QC. */
async function closeBatchAllRejected(batchId, factoryId, userId) {
  const closed = await ProductionBatch.findOneAndUpdate(
    {
      _id: batchId,
      factoryId,
      status: { $in: BATCH_RUNNING_STATUSES },
      $expr: { $lte: [{ $subtract: ['$plannedQuantity', { $ifNull: ['$rejectedQuantity', 0] }] }, 0] },
    },
    {
      $set: {
        status: 'CANCELLED',
        closedReason: 'ALL_PIECES_REJECTED',
        producedQuantity: 0,
        updatedBy: userId,
        updatedAt: new Date(),
      },
    },
    { new: true },
  );
  if (!closed) return null;
  await cancelOpenSchedules({ batchId: closed._id, factoryId: closed.factoryId }, userId);
  await syncWipForBatch(closed, userId);
  await refreshOrderCompletion(closed.productionOrderId, closed.factoryId, userId);
  return closed;
}

/**
 * In-process QC rejected `quantity` pieces: reduce the batch's good quantity atomically.
 * The batch must still be on the floor and have at least that many good pieces left.
 * When nothing good is left the batch is closed (see closeBatchAllRejected).
 */
export async function recordInProcessReject(batchId, quantity, userId, factoryId) {
  const qty = ROUND(Number(quantity) || 0);
  if (qty <= 0) return null;
  const updated = await ProductionBatch.findOneAndUpdate(
    {
      _id: batchId,
      factoryId,
      isDeleted: false,
      status: { $in: BATCH_RUNNING_STATUSES },
      $expr: { $gte: [{ $subtract: ['$plannedQuantity', { $ifNull: ['$rejectedQuantity', 0] }] }, qty] },
    },
    { $inc: { rejectedQuantity: qty }, $set: { updatedBy: userId, updatedAt: new Date() } },
    { new: true },
  );
  if (!updated) throw new ConflictError('Rejected quantity exceeds the good pieces left in this batch');

  await ProductionOrder.updateOne(
    { _id: updated.productionOrderId, factoryId: updated.factoryId },
    { $inc: { rejectedQuantity: qty }, $set: { updatedBy: userId } },
  );
  await syncWipForBatch(updated, userId);
  if (batchGoodQuantity(updated) <= 0) {
    return (await closeBatchAllRejected(updated._id, updated.factoryId, userId)) || updated;
  }
  return updated;
}

/** Final QC posted: accumulate batch + order passed/rejected (order completion is re-evaluated by the caller). */
export async function recordFinalQcResult(batchId, { passed = 0, failed = 0 }, userId, factoryId) {
  const batch = await ProductionBatch.findOneAndUpdate(
    { _id: batchId, factoryId, isDeleted: false },
    {
      $inc: { passedQuantity: passed, finalRejectedQuantity: failed },
      $set: { updatedBy: userId, updatedAt: new Date() },
    },
    { new: true },
  );
  if (!batch) throw new NotFoundError('Batch not found');
  await ProductionOrder.updateOne(
    { _id: batch.productionOrderId, factoryId: batch.factoryId },
    { $inc: { passedQuantity: passed, rejectedQuantity: failed }, $set: { updatedBy: userId } },
  );
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
  if (!BATCH_RUNNING_STATUSES.includes(batch.status)) {
    throw new ConflictError('Batch not in progress');
  }
  const orderId = batch.productionOrderId?._id || batch.productionOrderId;
  const parentOrder = await getProductionOrder(orderId, batch.factoryId);
  if (parentOrder.status === 'CANCELLED') {
    throw new ConflictError('Production order is cancelled');
  }
  const withScrap = Boolean(scrapMaterialId) && scrapQuantity > 0;
  if (withScrap) {
    await assertInFactory(Material, scrapMaterialId, batch.factoryId, 'Scrap material');
  }

  const stages = await stagesForBatch(batch);
  const stageBeingCompleted = batch.currentStage;
  const stageIdx = stages.indexOf(stageBeingCompleted);
  if (stageIdx < 0) throw new ConflictError('Invalid stage');

  if (!skipQcGate && isStageQcGated(stageBeingCompleted)) {
    const passed = batch.stageQcPassed?.get?.(stageBeingCompleted)
      || batch.stageQcPassed?.[stageBeingCompleted];
    if (!passed) {
      throw new ConflictError(`In-process QC required before completing ${stageBeingCompleted}`);
    }
  }

  const nextStage = stages[stageIdx + 1];
  const finishing = !nextStage || nextStage === 'COMPLETED';
  const rejected = batch.rejectedQuantity || 0;
  const good = batchGoodQuantity(batch);
  const now = new Date();

  const set = {
    updatedBy: userId,
    updatedAt: now,
    'stageHistory.$[open].completedAt': now,
    'stageHistory.$[open].completedBy': userId,
  };
  if (finishing && good > 0) {
    set.currentStage = 'COMPLETED';
    set.status = 'COMPLETED';
    set.producedQuantity = good;
  } else if (finishing) {
    set.status = 'CANCELLED';
    set.closedReason = 'ALL_PIECES_REJECTED';
    set.producedQuantity = 0;
  } else {
    // A reworked stage is done once it is completed again — the batch resumes normal flow.
    set.currentStage = nextStage;
    set.status = 'IN_PROGRESS';
  }
  const inc = {};
  if (machineHours) inc.machineHours = machineHours;
  if (labourHours) inc.labourHours = labourHours;

  // Atomic claim of THIS transition before any side effect: a concurrent second "Done" (or an
  // in-process reject landing in between) no longer matches and cannot double-count the order.
  const claimed = await ProductionBatch.findOneAndUpdate(
    {
      _id: batch._id,
      factoryId: batch.factoryId,
      isDeleted: false,
      status: { $in: BATCH_RUNNING_STATUSES },
      currentStage: stageBeingCompleted,
      $or: rejected > 0
        ? [{ rejectedQuantity: rejected }]
        : [{ rejectedQuantity: 0 }, { rejectedQuantity: { $exists: false } }, { rejectedQuantity: null }],
    },
    { $set: set, ...(Object.keys(inc).length ? { $inc: inc } : {}) },
    {
      new: true,
      arrayFilters: [{ 'open.stage': stageBeingCompleted, 'open.completedAt': null }],
    },
  );
  if (!claimed) {
    throw new ConflictError('Stage was already completed or the batch changed — refresh and retry');
  }

  if (!finishing) {
    await ProductionBatch.updateOne(
      { _id: claimed._id },
      { $push: { stageHistory: { stage: nextStage, startedAt: now } } },
    );
  }

  // Order output first — it is the side effect that must never be lost.
  if (claimed.status === 'COMPLETED') {
    await ProductionOrder.updateOne(
      { _id: orderId, factoryId: batch.factoryId },
      { $inc: { producedQuantity: good }, $set: { updatedBy: userId, updatedAt: new Date() } },
    );
  }

  if (withScrap) {
    try {
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
    } catch (err) {
      // The stage transition is already committed; scrap can be logged manually from the Waste page.
      console.warn(`[production] scrap record for ${batch.batchNumber} failed:`, err?.message);
    }
  }

  if (claimed.status === 'CANCELLED') {
    await cancelOpenSchedules({ batchId: claimed._id, factoryId: claimed.factoryId }, userId);
  } else {
    await syncSchedulesForBatch(claimed, claimed.currentStage, userId);
  }
  await syncWipForBatch(claimed, userId);

  if (claimed.status === 'COMPLETED' && parentOrder.createdBy) {
    await notify({
      organizationId: parentOrder.organizationId,
      factoryId: parentOrder.factoryId,
      userId: parentOrder.createdBy,
      eventType: 'batch.completed',
      title: 'Batch completed',
      message: `${batch.batchNumber} ready for final QC (${good} pcs)`,
      referenceType: 'PRODUCTION_BATCH',
      referenceId: batch._id,
    });
  } else if (claimed.status === 'CANCELLED') {
    await refreshOrderCompletion(orderId, batch.factoryId, userId);
  }
  if (claimed.status === 'COMPLETED') {
    await notifyFactoryRole(batch.factoryId, batch.organizationId, ['quality.update'], {
      eventType: 'quality.final_due',
      title: 'Final QC due',
      message: `${batch.batchNumber} is off the line — ${good} pcs waiting for final QC`,
      referenceType: 'QUALITY_INSPECTION', // links QC users to the Quality page (they cannot open Production)
      referenceId: batch._id,
    }, { excludeUserId: userId });
  } else if (claimed.status !== 'CANCELLED') {
    await notifyInProcessQcDue(claimed, userId);
  }

  return getBatch(claimed._id, claimed.factoryId);
}

/** COMPLETED batches older than this drop off the board's COMPLETED column. */
const BOARD_COMPLETED_DAYS = 30;
const BOARD_COMPLETED_LIMIT = 50;

export async function listBatchesByStage(factoryId, stage) {
  const filter = { factoryId, currentStage: stage, isDeleted: false, status: { $ne: 'CANCELLED' } };
  let query;
  if (stage === 'COMPLETED') {
    filter.updatedAt = { $gte: new Date(Date.now() - BOARD_COMPLETED_DAYS * 86400000) };
    query = ProductionBatch.find(filter).sort({ updatedAt: -1 }).limit(BOARD_COMPLETED_LIMIT);
  } else {
    query = ProductionBatch.find(filter).sort({ createdAt: 1 });
  }
  // lean(): read-only board payload — skips Mongoose hydration of every card (perf audit).
  return query.populate('productionOrderId', 'orderNumber priority deliveryDate').lean();
}

export async function getBatchBoard(factoryId) {
  const stages = await getBatchStages(factoryId);
  // Batches keep their own frozen stage list — surface stages that were since removed from settings.
  const openStages = await ProductionBatch.distinct('currentStage', {
    factoryId,
    isDeleted: false,
    status: { $nin: ['COMPLETED', 'CANCELLED'] },
  });
  const extra = openStages.filter((s) => s && !stages.includes(s));
  const columns = [...stages.filter((s) => s !== 'COMPLETED'), ...extra];
  if (stages.includes('COMPLETED')) columns.push('COMPLETED');
  // Columns are independent — load them in parallel (was one round trip per stage).
  const lists = await Promise.all(columns.map((stage) => listBatchesByStage(factoryId, stage)));
  const board = {};
  columns.forEach((stage, i) => { board[stage] = lists[i]; });
  return board;
}

/** Throws unless rollbackBatchStage would succeed for this batch (used to validate QC REWORK up front). */
export async function assertBatchCanRollback(batch) {
  if (!BATCH_RUNNING_STATUSES.includes(batch.status)) {
    throw new ConflictError('Only in-progress batches can rollback');
  }
  const stages = await stagesForBatch(batch);
  const stageIdx = stages.indexOf(batch.currentStage);
  if (stageIdx <= 0) throw new ConflictError('Cannot rollback from first stage');
  return { stages, stageIdx };
}

/** Throws unless a completed batch can be reopened for rework after final QC. */
export async function assertBatchCanReopenForRework(batch) {
  if (batch.status !== 'COMPLETED' || batch.currentStage !== 'COMPLETED') {
    throw new ConflictError('Only completed batches can be reopened for rework');
  }
  const orderId = batch.productionOrderId?._id || batch.productionOrderId;
  const order = await ProductionOrder.findOne({ _id: orderId, factoryId: batch.factoryId });
  if (!order) throw new NotFoundError('Production order not found');
  if (order.status === 'CANCELLED') throw new ConflictError('Production order is cancelled');
  const stages = await stagesForBatch(batch);
  const reworkStage = [...stages].reverse().find((s) => s !== 'COMPLETED' && isStageQcGated(s));
  if (!reworkStage) throw new ConflictError('No QC-gated stage to rework');
  return { order, reworkStage };
}

/**
 * Final QC disposition REWORK: send a completed batch back to the last QC-gated stage and
 * take its output back off the order (it is re-added when the batch completes again).
 */
export async function reopenBatchForFinalRework(id, userId, factoryId) {
  const batch = await getBatch(id, factoryId);
  const { order, reworkStage } = await assertBatchCanReopenForRework(batch);
  const produced = batch.producedQuantity || 0;

  const reopened = await ProductionBatch.findOneAndUpdate(
    { _id: batch._id, factoryId: batch.factoryId, status: 'COMPLETED' },
    {
      $set: {
        status: 'REWORK',
        currentStage: reworkStage,
        producedQuantity: 0,
        [`stageQcPassed.${reworkStage}`]: false,
        updatedBy: userId,
        updatedAt: new Date(),
      },
      // Cleared so the batch shows up again for a fresh final QC once rework completes.
      $unset: { qcInspectionId: 1 },
      $push: { stageHistory: { stage: reworkStage, startedAt: new Date() } },
    },
    { new: true },
  );
  if (!reopened) throw new ConflictError('Batch is no longer completed');

  if (produced > 0) {
    await ProductionOrder.updateOne(
      { _id: order._id },
      { $inc: { producedQuantity: -produced }, $set: { updatedBy: userId } },
    );
  }
  await ProductionOrder.updateOne(
    { _id: order._id, status: 'COMPLETED' },
    { $set: { status: 'IN_PROGRESS', updatedBy: userId } },
  );
  await syncSchedulesForBatch(reopened, reworkStage, userId);
  await syncWipForBatch(reopened, userId);
  return reopened;
}

export async function rollbackBatchStage(id, userId, factoryId) {
  const batch = await getBatch(id, factoryId);
  const { stages, stageIdx } = await assertBatchCanRollback(batch);

  const prevStage = stages[stageIdx - 1];
  const now = new Date();
  const rolled = await ProductionBatch.findOneAndUpdate(
    {
      _id: batch._id,
      factoryId: batch.factoryId,
      status: { $in: BATCH_RUNNING_STATUSES },
      currentStage: batch.currentStage,
    },
    {
      $set: {
        currentStage: prevStage,
        status: 'REWORK',
        // The stage being reworked must pass in-process QC again before it can be completed.
        [`stageQcPassed.${prevStage}`]: false,
        'stageHistory.$[open].completedAt': now,
        updatedBy: userId,
        updatedAt: now,
      },
    },
    { new: true, arrayFilters: [{ 'open.stage': batch.currentStage, 'open.completedAt': null }] },
  );
  if (!rolled) throw new ConflictError('Batch stage changed — refresh and retry');
  await ProductionBatch.updateOne(
    { _id: rolled._id },
    { $push: { stageHistory: { stage: prevStage, startedAt: now } } },
  );
  await syncSchedulesForBatch(rolled, prevStage, userId);
  await notifyInProcessQcDue(rolled, userId);
  return getBatch(rolled._id, rolled.factoryId);
}

const SCHEDULE_FIELDS = ['productionOrderId', 'batchId', 'stage', 'productionLineId', 'machineId', 'shiftId', 'workerIds', 'plannedStart', 'plannedEnd', 'status', 'notes'];

export async function createSchedule(data, userId, factoryId) {
  const order = await getProductionOrder(data.productionOrderId, factoryId);
  const fields = {};
  for (const key of SCHEDULE_FIELDS) {
    if (data[key] !== undefined) fields[key] = data[key];
  }
  await assertBatchResourcesInFactory({
    workerIds: fields.workerIds,
    shiftId: fields.shiftId,
    machineId: fields.machineId,
    productionLineId: fields.productionLineId,
  }, order.factoryId);
  if (fields.batchId) {
    const batchOk = await ProductionBatch.exists({
      _id: fields.batchId,
      factoryId: order.factoryId,
      productionOrderId: order._id,
      isDeleted: false,
    });
    if (!batchOk) throw new NotFoundError('Batch not found for this production order');
  }
  await validateScheduleConflicts({ factoryId: order.factoryId, ...fields });
  return ProductionSchedule.create({
    ...fields,
    organizationId: order.organizationId,
    factoryId: order.factoryId,
    createdBy: userId,
    updatedBy: userId,
  });
}

export async function listSchedules(factoryId, { page, limit, skip, from, to, productionOrderId, status }) {
  const filter = applySoftDeleteFilter({ factoryId });
  const orderQ = queryString(productionOrderId);
  const statusQ = queryString(status);
  const fromQ = queryString(from);
  const toQ = queryString(to);
  if (orderQ) filter.productionOrderId = orderQ;
  if (statusQ) filter.status = statusQ;
  if (fromQ || toQ) {
    filter.plannedStart = {};
    if (fromQ) filter.plannedStart.$gte = new Date(fromQ);
    if (toQ) filter.plannedStart.$lte = new Date(toQ);
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
  await assertBatchResourcesInFactory({
    workerIds: data.workerIds,
    shiftId: data.shiftId || undefined,
    machineId: data.machineId || undefined,
    productionLineId: data.productionLineId || undefined,
  }, schedule.factoryId);
  if (data.batchId) {
    const batchOk = await ProductionBatch.exists({
      _id: data.batchId,
      factoryId: schedule.factoryId,
      productionOrderId: schedule.productionOrderId,
      isDeleted: false,
    });
    if (!batchOk) throw new NotFoundError('Batch not found for this production order');
  }
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
  const [stats, machineTotal, lineTotal] = await Promise.all([
    getProductionStats(factoryId),
    // All non-deleted (incl. inactive / maintenance) — what the Machines and Lines lists show;
    // machineCount / lineCount stay "active only" (they feed capacity).
    Machine.countDocuments({ factoryId, isDeleted: false }),
    ProductionLine.countDocuments({ factoryId, isDeleted: false }),
  ]);
  return {
    machineTotal,
    lineTotal,
    inProgressBatches: stats.batchesInProgress,
    pendingOrders: stats.ordersApproved + stats.ordersInProgress,
    overdueOrders: stats.overdueOrders,
    machineCount: stats.machineCount,
    lineCount: stats.lineCount,
    totalCapacityPerHour: stats.totalCapacityPerHour,
    fulfillmentPct: stats.fulfillmentPct,
  };
}
