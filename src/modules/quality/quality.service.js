import mongoose from 'mongoose';
import { QualityInspection } from './qualityInspection.model.js';
import { Defect } from './defect.model.js';
import { CapaRecord } from './capaRecord.model.js';
import { GoodsReceipt } from '../purchase/goodsReceipt.model.js';
import { ProductionBatch } from '../production/productionBatch.model.js';
import { ProductionOrder } from '../production/productionOrder.model.js';
import { Material } from '../inventory/material.model.js';
import { Factory } from '../organization/factory.model.js';
import { Sample } from '../sampling/sample.model.js';
import { PurchaseOrder } from '../purchase/purchaseOrder.model.js';
import { InventoryBalance } from '../inventory/inventoryBalance.model.js';
import { StorageBin } from '../warehouse/storageBin.model.js';
import { Warehouse } from '../warehouse/warehouse.model.js';
import { notify } from '../notification/notification.service.js';
import * as inventoryService from '../inventory/inventory.service.js';
import * as warehouseService from '../warehouse/warehouse.service.js';
import * as productionService from '../production/production.service.js';
import * as wasteService from '../waste/waste.service.js';
import { nextDocumentNumber } from '../../shared/utils/numbering.js';
import { NotFoundError, ConflictError, ValidationError } from '../../shared/errors/AppError.js';
import {
  applySoftDeleteFilter, asObjectId, escapeRegex, queryString,
} from '../../shared/utils/schema.js';

/** A completeInspection claim older than this (process crashed mid-complete) may be re-claimed. */
const COMPLETE_CLAIM_STALE_MS = 10 * 60 * 1000;

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
    pendingSampleQc,
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
    ProductionBatch.countDocuments({
      factoryId,
      status: 'COMPLETED',
      currentStage: 'COMPLETED',
      $or: [{ qcInspectionId: { $exists: false } }, { qcInspectionId: null }],
      isDeleted: false,
    }),
    ProductionBatch.countDocuments({ factoryId, status: { $in: ['IN_PROGRESS', 'REWORK'] }, isDeleted: false }),
    Sample.countDocuments({ factoryId, status: 'QC_PENDING', isDeleted: false }),
  ]);

  // First-pass yield: FINAL inspections only — pieces passed / pieces inspected.
  const fpyRows = await QualityInspection.aggregate([
    {
      $match: {
        factoryId: asObjectId(factoryId),
        isDeleted: false,
        status: 'COMPLETED',
        inspectionType: 'FINAL',
      },
    },
    { $group: { _id: null, passed: { $sum: '$passedQuantity' }, failed: { $sum: '$failedQuantity' } } },
  ]);
  const finalPassedQty = fpyRows[0]?.passed || 0;
  const finalInspectedQty = finalPassedQty + (fpyRows[0]?.failed || 0);
  const firstPassYield = finalInspectedQty > 0 ? Math.round((finalPassedQty / finalInspectedQty) * 100) : 0;

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
    pendingSampleQc,
    finalPassedQty,
    finalInspectedQty,
    firstPassYield,
  };
}

export async function getPendingWork(factoryId) {
  const [pendingGrns, inProgressBatches, completedBatches, pendingSamples] = await Promise.all([
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
    Sample.find({ factoryId, status: 'QC_PENDING', isDeleted: false })
      .populate('designId', 'designCode title')
      .populate('qcInspectionId', 'inspectionNumber status')
      .sort({ updatedAt: -1 })
      .limit(50),
  ]);
  for (const sample of pendingSamples) {
    if (!sample.qcInspectionId) {
      await ensureSampleQcInspection(sample, sample.updatedBy || sample.createdBy);
    }
  }
  return { pendingGrns, inProgressBatches, completedBatches, pendingSamples };
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

/**
 * @param {string} grnId
 * @param {string} userId
 * @param {string} [factoryId] request factory — required from HTTP callers; internal callers that
 *   already loaded a factory-scoped GRN may omit it.
 */
export async function createIncomingInspection(grnId, userId, factoryId) {
  const grnFilter = applySoftDeleteFilter({ _id: grnId });
  if (factoryId) grnFilter.factoryId = factoryId;
  const grn = await GoodsReceipt.findOne(grnFilter);
  if (!grn) throw new NotFoundError('Goods receipt not found');
  if (grn.status !== 'PENDING_QC') throw new ConflictError('GRN must be PENDING_QC');

  if (grn.qcInspectionId) {
    const existing = await QualityInspection.findOne({ _id: grn.qcInspectionId, factoryId: grn.factoryId });
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

  const inspection = await createInspectionRecord({
    organizationId: grn.organizationId,
    factoryId: grn.factoryId,
    inspectionNumber,
    inspectionType: 'INCOMING',
    referenceType: 'GOODS_RECEIPT',
    referenceId: grn._id,
    userId,
  });
  return linkInspectionOrReuse(GoodsReceipt, grn, inspection, userId);
}

/**
 * Atomically link a freshly created inspection to its reference doc's qcInspectionId. If a concurrent
 * request linked another inspection first, soft-delete ours and return the winner (no duplicates).
 */
async function linkInspectionOrReuse(Model, doc, inspection, userId) {
  const linked = await Model.findOneAndUpdate(
    {
      _id: doc._id,
      factoryId: doc.factoryId,
      $or: [{ qcInspectionId: { $exists: false } }, { qcInspectionId: null }],
    },
    { $set: { qcInspectionId: inspection._id, updatedBy: userId, updatedAt: new Date() } },
    { new: true },
  );
  if (linked) {
    doc.qcInspectionId = inspection._id;
    return inspection;
  }
  await QualityInspection.updateOne({ _id: inspection._id }, { $set: { isDeleted: true, updatedBy: userId } });
  const current = await Model.findById(doc._id).select('qcInspectionId');
  const winner = current?.qcInspectionId
    ? await QualityInspection.findOne({ _id: current.qcInspectionId, factoryId: doc.factoryId, isDeleted: false })
    : null;
  if (!winner) throw new ConflictError('Inspection is being created by another request — retry');
  return winner;
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

export async function ensureSampleQcInspection(sample, userId) {
  if (!sample || sample.status !== 'QC_PENDING') return null;
  const existing = await QualityInspection.findOne(applySoftDeleteFilter({
    factoryId: sample.factoryId,
    referenceType: 'SAMPLE',
    referenceId: sample._id,
    status: { $in: ['PENDING', 'IN_PROGRESS'] },
  }));
  if (existing) {
    if (!sample.qcInspectionId) {
      sample.qcInspectionId = existing._id;
      sample.updatedBy = userId;
      await sample.save();
    }
    return existing;
  }

  const factory = await Factory.findById(sample.factoryId);
  const inspectionNumber = await nextDocumentNumber(sample.factoryId, 'QC', `QC-${factory?.code || 'F'}-`);
  const created = await createInspectionRecord({
    organizationId: sample.organizationId,
    factoryId: sample.factoryId,
    inspectionNumber,
    inspectionType: 'SAMPLING',
    referenceType: 'SAMPLE',
    referenceId: sample._id,
    stageAtInspection: 'SAMPLE_QC',
    userId,
  });

  // Concurrent callers (e.g. parallel GET /quality/pending-work) may each have created one —
  // the oldest open inspection wins; later duplicates are soft-deleted.
  const open = await QualityInspection.find(applySoftDeleteFilter({
    factoryId: sample.factoryId,
    referenceType: 'SAMPLE',
    referenceId: sample._id,
    status: { $in: ['PENDING', 'IN_PROGRESS'] },
  })).sort({ createdAt: 1, _id: 1 });
  const winner = open[0] || created;
  const losers = open.slice(1).map((i) => i._id);
  if (losers.length) {
    await QualityInspection.updateMany(
      { _id: { $in: losers }, status: 'PENDING' },
      { $set: { isDeleted: true, updatedBy: userId } },
    );
  }

  await Sample.updateOne(
    { _id: sample._id, factoryId: sample.factoryId },
    { $set: { qcInspectionId: winner._id, updatedBy: userId, updatedAt: new Date() } },
  );
  sample.qcInspectionId = winner._id;
  return winner;
}

/**
 * @param {string} batchId
 * @param {string} userId
 * @param {object} opts
 * @param {string} [factoryId] request factory (HTTP callers must pass it)
 */
export async function createFinalInspection(batchId, userId, { storageBinId, autoDispatchReady } = {}, factoryId) {
  const batchFilter = applySoftDeleteFilter({ _id: batchId });
  if (factoryId) batchFilter.factoryId = factoryId;
  const batch = await ProductionBatch.findOne(batchFilter);
  if (!batch) throw new NotFoundError('Batch not found');
  if (batch.status !== 'COMPLETED' || batch.currentStage !== 'COMPLETED') {
    throw new ConflictError('Batch must be completed before final QC');
  }

  if (batch.qcInspectionId) {
    const existing = await QualityInspection.findOne({
      _id: batch.qcInspectionId,
      factoryId: batch.factoryId,
      isDeleted: false,
    });
    if (existing && existing.status !== 'COMPLETED') return existing;
    if (existing) throw new ConflictError('Final QC already completed for this batch');
  }

  const factory = await Factory.findById(batch.factoryId);
  const inspectionNumber = await nextDocumentNumber(batch.factoryId, 'QC', `QC-${factory.code}-`);

  const inspection = await createInspectionRecord({
    organizationId: batch.organizationId,
    factoryId: batch.factoryId,
    inspectionNumber,
    inspectionType: 'FINAL',
    referenceType: 'PRODUCTION_BATCH',
    referenceId: batch._id,
    storageBinId,
    autoDispatchReady,
    userId,
  });
  if (batch.qcInspectionId) {
    // Stale link (deleted inspection) — clear so the atomic link below can claim it.
    await ProductionBatch.updateOne(
      { _id: batch._id, qcInspectionId: batch.qcInspectionId },
      { $unset: { qcInspectionId: 1 } },
    );
  }
  return linkInspectionOrReuse(ProductionBatch, batch, inspection, userId);
}

export async function listInspections(factoryId, { page, limit, skip, status, inspectionType, search, referenceId }) {
  const filter = applySoftDeleteFilter({ factoryId });
  const statusQ = queryString(status);
  const typeQ = queryString(inspectionType);
  const searchQ = queryString(search)?.trim();
  if (statusQ) filter.status = statusQ;
  if (typeQ) filter.inspectionType = typeQ;
  const refQ = queryString(referenceId);
  if (refQ && mongoose.isValidObjectId(refQ)) filter.referenceId = refQ;
  if (searchQ) {
    const re = new RegExp(escapeRegex(searchQ), 'i');
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

const ROUND = (n) => Math.round(n * 1000) / 1000;
const idOf = (v) => (v && typeof v === 'object' && v._id ? v._id : v) || undefined;

/** PASS / FAIL / PARTIAL from quantities; `fallback` is used only when both are 0. */
function labelFromQuantities(passed, failed, fallback = 'PASS') {
  if (passed > 0 && failed === 0) return 'PASS';
  if (passed === 0 && failed > 0) return 'FAIL';
  if (passed > 0 && failed > 0) return 'PARTIAL';
  return fallback;
}

/**
 * Resolve passed/failed quantities and a result/disposition consistent with them.
 * `base` = the lot size the counts must fit in (null when unknown, e.g. samples).
 * REWORK posts nothing: its stored counts are always 0 / 0.
 */
function resolveQcOutcome({ passedQuantity, failedQuantity, result, disposition }, base) {
  const normalized = result === 'REJECT' ? 'FAIL' : result;
  if (disposition === 'REWORK' || normalized === 'REWORK') {
    return { passed: 0, failed: 0, result: 'REWORK', disposition: 'REWORK' };
  }

  const explicitFail = normalized === 'FAIL' || disposition === 'REJECT';
  let passed = passedQuantity ?? null;
  let failed = failedQuantity ?? null;
  if (base !== null && base !== undefined) {
    if (passed === null && failed === null) {
      passed = explicitFail ? 0 : base;
      failed = explicitFail ? base : 0;
    } else if (passed === null) {
      passed = explicitFail ? 0 : Math.max(0, ROUND(base - failed));
    } else if (failed === null) {
      failed = (explicitFail || normalized === 'PARTIAL') ? Math.max(0, ROUND(base - passed)) : 0;
    }
  }
  passed = passed ?? 0;
  failed = failed ?? 0;

  // Quantities win whenever they say something; the client's label is only used when both are 0.
  const finalResult = labelFromQuantities(
    passed,
    failed,
    normalized || (disposition === 'REJECT' ? 'FAIL' : 'PASS'),
  );
  return {
    passed,
    failed,
    result: finalResult,
    disposition: finalResult === 'FAIL' ? 'REJECT' : 'PASS',
  };
}

/**
 * Incoming QC: one decision per GRN line, accounting for every piece (accepted + rejected = received) —
 * otherwise the remainder would be neither in stock nor re-orderable on the PO.
 * - body.lines given → must cover every received GRN line exactly once.
 * - no lines, single-line GRN → lot-level passed/failed apply to that line.
 * - no lines, multi-line GRN → only an all-PASS / all-REJECT verdict without quantities is accepted.
 */
function planIncomingLines(grn, body) {
  const grnLines = (grn.lines || []).filter((l) => (l.receivedQty || 0) > 0);
  const normalized = body.result === 'REJECT' ? 'FAIL' : body.result;
  const out = [];

  if (Array.isArray(body.lines) && body.lines.length) {
    const used = new Set();
    for (const input of body.lines) {
      const line = grnLines.find(
        (l) => !used.has(String(l._id)) && String(l.materialId?._id || l.materialId) === String(input.materialId),
      );
      if (!line) throw new ValidationError(`Material ${input.materialId} is not on this GRN (or is listed twice)`);
      used.add(String(line._id));
      const accepted = Math.max(0, Number(input.acceptedQty) || 0);
      const rejected = Math.max(0, Number(input.rejectedQty) || 0);
      if (Math.abs(accepted + rejected - (line.receivedQty || 0)) > 1e-9) {
        throw new ValidationError(
          `Accepted (${accepted}) + rejected (${rejected}) must equal the received qty (${line.receivedQty}) for material ${input.materialId}`,
        );
      }
      out.push({ line, accepted, rejected });
    }
    if (used.size < grnLines.length) {
      throw new ValidationError('A QC result is required for every GRN line');
    }
  } else if (grnLines.length <= 1) {
    const line = grnLines[0];
    if (line) {
      const base = line.receivedQty;
      const o = resolveQcOutcome(body, base);
      if (Math.abs(o.passed + o.failed - base) > 1e-9) {
        throw new ValidationError(`Passed (${o.passed}) + failed (${o.failed}) must equal the GRN received qty (${base})`);
      }
      out.push({ line, accepted: o.passed, rejected: o.failed });
    }
  } else {
    const hasQty = body.passedQuantity !== undefined || body.failedQuantity !== undefined;
    const rejectAll = normalized === 'FAIL' || body.disposition === 'REJECT';
    const acceptAll = !rejectAll && (normalized === 'PASS' || body.disposition === 'PASS');
    if (hasQty || (!rejectAll && !acceptAll)) {
      throw new ValidationError('This GRN has several lines — send per-line results in lines[]');
    }
    for (const line of grnLines) {
      out.push({
        line,
        accepted: rejectAll ? 0 : line.receivedQty,
        rejected: rejectAll ? line.receivedQty : 0,
      });
    }
  }

  const passed = ROUND(out.reduce((s, l) => s + l.accepted, 0));
  const failed = ROUND(out.reduce((s, l) => s + l.rejected, 0));
  return { lines: out, passed, failed };
}

/** Bin must be in this factory, ACTIVE and in a warehouse of `type`. */
async function assertBinOfType(binId, factoryId, type) {
  const bin = await StorageBin.findOne({ _id: binId, factoryId, isDeleted: false });
  if (!bin) throw new NotFoundError('Storage bin not found');
  if (bin.status !== 'ACTIVE') throw new ConflictError(`Bin ${bin.binCode} is not active`);
  const wh = await Warehouse.findOne({ _id: bin.warehouseId, factoryId, isDeleted: false });
  if (!wh) throw new NotFoundError('Warehouse not found');
  if (wh.type !== type) throw new ConflictError(`Bin ${bin.binCode} must be in a ${type} warehouse`);
  return bin;
}

export async function completeInspection(id, body, userId, factoryId) {
  const inspection = await getInspection(id, factoryId);
  if (inspection.status === 'COMPLETED') throw new ConflictError('Inspection already completed');

  const { storageBinId, autoDispatchReady } = body;
  const scope = { _id: inspection.referenceId, factoryId: inspection.factoryId };
  const isIncoming = inspection.referenceType === 'GOODS_RECEIPT';
  const isBatch = inspection.referenceType === 'PRODUCTION_BATCH';
  const isInProcess = isBatch && inspection.inspectionType === 'IN_PROCESS';
  const isFinal = isBatch && !isInProcess;
  const normalized = body.result === 'REJECT' ? 'FAIL' : body.result;
  const wantsRework = body.disposition === 'REWORK' || normalized === 'REWORK';

  // ── Validate everything BEFORE claiming / marking the inspection completed ──
  let base = null;
  let batch = null;
  let incomingPlan = null;
  if (isIncoming) {
    if (wantsRework) {
      throw new ValidationError('REWORK is not a valid disposition for incoming QC — use PASS/REJECT');
    }
    const grn = await GoodsReceipt.findOne(scope);
    if (!grn) throw new NotFoundError('Goods receipt not found');
    if (grn.status === 'COMPLETED') throw new ConflictError('GRN incoming QC already completed');
    if (grn.status !== 'PENDING_QC') throw new ConflictError('GRN must be PENDING_QC');
    incomingPlan = planIncomingLines(grn, body);
  } else if (isBatch) {
    batch = await ProductionBatch.findOne(scope);
    if (!batch) throw new NotFoundError('Batch not found');
    if (isInProcess) {
      if (!['IN_PROGRESS', 'REWORK'].includes(batch.status)
        || (inspection.stageAtInspection && batch.currentStage !== inspection.stageAtInspection)) {
        throw new ConflictError(
          `Batch is no longer at ${inspection.stageAtInspection || 'the inspected stage'} — this in-process inspection no longer applies`,
        );
      }
      base = productionService.batchGoodQuantity(batch);
    } else {
      base = batch.producedQuantity > 0 ? batch.producedQuantity : productionService.batchGoodQuantity(batch);
    }
  }

  let outcome;
  if (incomingPlan) {
    const label = labelFromQuantities(incomingPlan.passed, incomingPlan.failed, normalized === 'FAIL' ? 'FAIL' : 'PASS');
    outcome = {
      passed: incomingPlan.passed,
      failed: incomingPlan.failed,
      result: label,
      disposition: label === 'FAIL' ? 'REJECT' : 'PASS',
    };
  } else {
    outcome = resolveQcOutcome(body, base);
  }
  const { passed, failed } = outcome;
  if (base !== null && outcome.disposition !== 'REWORK') {
    if (isFinal && Math.abs(passed + failed - base) > 1e-9) {
      throw new ValidationError(`Final QC must account for every piece: passed (${passed}) + failed (${failed}) must equal ${base}`);
    }
    if (passed + failed > base + 1e-9) {
      throw new ValidationError(`Passed (${passed}) + failed (${failed}) cannot exceed batch good quantity (${base})`);
    }
  }

  if (outcome.disposition === 'REWORK') {
    if (batch && isInProcess) {
      await productionService.assertBatchCanRollback(batch);
    } else if (batch) {
      await productionService.assertBatchCanReopenForRework(batch);
    }
  } else if (batch && isFinal
    && (batch.status !== 'COMPLETED' || batch.currentStage !== 'COMPLETED')) {
    throw new ConflictError('Batch must be completed before final QC');
  }

  // Bins are validated once, up front — never half-way through posting stock.
  const binId = idOf(storageBinId) || idOf(inspection.storageBinId);
  if (binId && passed > 0 && outcome.disposition !== 'REWORK') {
    if (isFinal) await assertBinOfType(binId, inspection.factoryId, 'FINISHED_GOODS');
    if (isIncoming) await assertBinOfType(binId, inspection.factoryId, 'RAW_MATERIAL');
  }

  // ── Atomic claim: only one request may apply this inspection's side effects ──
  const claimAt = new Date();
  const claimed = await QualityInspection.findOneAndUpdate(
    {
      _id: inspection._id,
      factoryId: inspection.factoryId,
      status: { $ne: 'COMPLETED' },
      isDeleted: false,
      $or: [
        { completingAt: null },
        { completingAt: { $lt: new Date(claimAt.getTime() - COMPLETE_CLAIM_STALE_MS) } },
      ],
    },
    { $set: { completingAt: claimAt } },
    { new: true },
  );
  if (!claimed) throw new ConflictError('Inspection already completed or being completed');

  inspection.passedQuantity = passed;
  inspection.failedQuantity = failed;
  inspection.disposition = outcome.disposition;
  inspection.result = outcome.result;
  if (storageBinId) inspection.storageBinId = storageBinId;
  else if (inspection.storageBinId) inspection.storageBinId = idOf(inspection.storageBinId);
  if (autoDispatchReady !== undefined) inspection.autoDispatchReady = autoDispatchReady;
  // Posting markers written by an earlier, partially failed attempt (read fresh from the claim).
  inspection.postedLines = claimed.postedLines || [];
  inspection.status = 'COMPLETED';
  inspection.inspectedBy = userId;
  inspection.completedAt = new Date();
  inspection.updatedBy = userId;

  let afterSave = null;
  try {
    if (isIncoming) {
      afterSave = await completeIncomingQc(inspection, incomingPlan, userId);
    } else if (isBatch) {
      if (isInProcess) {
        await completeInProcessQc(inspection, userId);
      } else {
        afterSave = await completeFinalQc(inspection, userId);
      }
    } else {
      // Samples: persist first — the sampling service syncs any still-open inspection itself.
      await inspection.save();
    }
  } catch (err) {
    await QualityInspection.updateOne(
      { _id: inspection._id, completingAt: claimAt, status: { $ne: 'COMPLETED' } },
      { $unset: { completingAt: 1 } },
    );
    throw err;
  }

  if (inspection.referenceType !== 'SAMPLE') {
    await inspection.save();
    if (afterSave) {
      // Follow-ups (order completion, MRP unblock, notifications) never fail a committed inspection.
      try {
        await afterSave();
      } catch (err) {
        console.warn(`[quality] post-completion step for ${inspection.inspectionNumber} failed:`, err?.message);
      }
    }
    return inspection;
  }

  const { applySampleQcFromInspection } = await import('../sampling/sample.service.js');
  await applySampleQcFromInspection(inspection.referenceId, inspection.factoryId, userId, {
    result: inspection.result,
    disposition: inspection.disposition,
    passed,
    failed,
    notes: body.notes,
  });

  return inspection;
}

/**
 * Posts accepted qty per GRN line into stock (idempotent via inspection.postedLines), writes the
 * QC result back to the PO, completes the GRN. Returns the post-save follow-up.
 */
async function completeIncomingQc(inspection, plan, userId) {
  const grn = await GoodsReceipt.findOne({ _id: inspection.referenceId, factoryId: inspection.factoryId });
  if (!grn) return null;
  if (grn.status === 'COMPLETED') return null;

  const binId = idOf(inspection.storageBinId);
  const posted = new Map((inspection.postedLines || []).map((p) => [String(p.grnLineId), p.postedQty || 0]));
  const persistPosted = async () => {
    inspection.postedLines = [...posted].map(([grnLineId, postedQty]) => ({ grnLineId, postedQty }));
    await QualityInspection.updateOne(
      { _id: inspection._id },
      { $set: { postedLines: inspection.postedLines } },
    );
  };

  let po;
  const poUnitPrice = async (line) => {
    if (po === undefined) {
      po = await PurchaseOrder.findOne({ _id: grn.poId, factoryId: grn.factoryId }).select('lines');
    }
    const lines = po?.lines || [];
    const poLine = (line.poLineId && lines.find((l) => String(l._id) === String(line.poLineId)))
      || lines.find((l) => String(l.materialId) === String(line.materialId));
    return poLine?.unitPrice || 0;
  };

  const receivedMaterialIds = [];
  const lineResults = [];
  for (const { line: planLine, accepted, rejected } of plan.lines) {
    const line = grn.lines.id(planLine._id) || planLine;
    line.acceptedQty = accepted;
    line.rejectedQty = rejected;
    lineResults.push({
      grnLineId: line._id,
      materialId: line.materialId,
      unit: line.unit,
      receivedQty: line.receivedQty,
      acceptedQty: accepted,
      rejectedQty: rejected,
    });

    const key = String(line._id);
    const already = posted.get(key) || 0;
    const toPost = ROUND(accepted - already);
    if (toPost > 0) {
      const mat = await Material.findById(line.materialId);
      const unitCost = line.unitPrice || await poUnitPrice(line);
      await inventoryService.receiptMaterial({
        factoryId: grn.factoryId,
        organizationId: grn.organizationId,
        materialId: line.materialId,
        quantity: toPost,
        unit: line.unit || mat?.unit,
        strictUnit: true,
        unitCost,
        userId,
        storageBinId: binId,
        referenceType: 'GOODS_RECEIPT',
        referenceId: grn._id,
      });
      posted.set(key, ROUND(already + toPost));
      await persistPosted();
    }
    if (accepted > 0) receivedMaterialIds.push(line.materialId);
  }
  inspection.lineResults = lineResults;

  // PO write-back (idempotent on the purchase side via grn.poSyncedAt).
  const purchaseService = await import('../purchase/purchase.service.js');
  if (typeof purchaseService.recordIncomingQcResult === 'function') {
    await purchaseService.recordIncomingQcResult({
      grnId: grn._id,
      factoryId: grn.factoryId,
      lines: lineResults.map((l) => ({ materialId: l.materialId, acceptedQty: l.acceptedQty, rejectedQty: l.rejectedQty })),
      userId,
    });
  }

  grn.status = 'COMPLETED';
  grn.qcInspectionId = inspection._id;
  grn.updatedBy = userId;
  await grn.save();

  return async () => {
    if (receivedMaterialIds.length) {
      try {
        await productionService.tryUnblockProductionOrdersAfterReceipt({
          factoryId: grn.factoryId,
          materialIds: receivedMaterialIds,
          userId,
        });
      } catch (err) {
        console.warn(`[quality] production unblock after ${grn.grnNumber} failed:`, err?.message);
      }
    }
    const recipients = new Set();
    if (grn.receivedBy) recipients.add(String(grn.receivedBy));
    if (grn.createdBy) recipients.add(String(grn.createdBy));
    const poDoc = await PurchaseOrder.findOne({ _id: grn.poId }).select('createdBy poNumber');
    if (poDoc?.createdBy) recipients.add(String(poDoc.createdBy));
    const message = `${grn.grnNumber}${poDoc?.poNumber ? ` (${poDoc.poNumber})` : ''}: accepted ${inspection.passedQuantity}, rejected ${inspection.failedQuantity}`;
    for (const recipient of recipients) {
      await notify({
        organizationId: grn.organizationId,
        factoryId: grn.factoryId,
        userId: recipient,
        eventType: 'quality.incoming_completed',
        title: 'Incoming QC completed',
        message,
        referenceType: 'GOODS_RECEIPT',
        referenceId: grn._id,
      }).catch(() => {});
    }
  };
}

/** Rejected pieces → REJECTED stock + REJECTED_PIECES waste valued at the batch's cost per piece. */
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
    unitCost: productionService.batchCostPerPiece(batch, order),
    reasonCode: 'QC_REJECT',
    userId,
  });
}

async function completeInProcessQc(inspection, userId) {
  const batch = await ProductionBatch.findOne({ _id: inspection.referenceId, factoryId: inspection.factoryId });
  if (!batch) return;

  const stage = inspection.stageAtInspection || batch.currentStage;
  const order = await ProductionOrder.findOne({ _id: batch.productionOrderId, factoryId: batch.factoryId });

  if (inspection.disposition === 'REWORK' || inspection.result === 'REWORK') {
    await productionService.rollbackBatchStage(batch._id, userId, batch.factoryId);
    return;
  }

  const failed = inspection.failedQuantity || 0;
  const passed = inspection.passedQuantity || 0;
  if (failed > 0) {
    // FAIL and PARTIAL alike: rejected pieces leave the batch's good quantity (atomic, guarded).
    await productionService.recordInProcessReject(batch._id, failed, userId, batch.factoryId);
    try {
      await recordQcRejectWaste(inspection, batch, order, userId);
    } catch (err) {
      console.warn(`[quality] reject stock/waste for ${batch.batchNumber} failed:`, err?.message);
    }
  }

  if (passed > 0 && inspection.result !== 'FAIL') {
    await productionService.markStageQcPassed(batch._id, stage, userId, batch.factoryId);
  }
}

async function completeFinalQc(inspection, userId) {
  const batch = await ProductionBatch.findOne({ _id: inspection.referenceId, factoryId: inspection.factoryId });
  if (!batch) return null;

  const order = await ProductionOrder.findOne({ _id: batch.productionOrderId, factoryId: batch.factoryId });
  if (!order) return null;

  if (inspection.disposition === 'REWORK' || inspection.result === 'REWORK') {
    // Nothing is posted for a REWORK verdict — the batch goes back to the line.
    await productionService.reopenBatchForFinalRework(batch._id, userId, batch.factoryId);
    return null;
  }

  // Explicit 0 means 0 — defaults were already resolved in completeInspection.
  const passed = inspection.passedQuantity ?? 0;
  const failed = inspection.failedQuantity ?? 0;
  const binId = idOf(inspection.storageBinId);

  if (passed > 0) {
    const warehouse = await warehouseService.getDefaultWarehouse(batch.factoryId, 'FINISHED_GOODS');
    const balance = await inventoryService.receiptFinishedGoods({
      factoryId: batch.factoryId,
      organizationId: batch.organizationId,
      skuId: order.skuId,
      quantity: passed,
      locationId: warehouse?._id,
      storageBinId: binId,
      userId,
    });

    if (binId && !balance.storageBinId) {
      await warehouseService.putAwayFinishedGoods({
        factoryId: batch.factoryId,
        organizationId: batch.organizationId,
        skuId: order.skuId,
        binId,
        quantity: passed,
        userId,
      });
    }

    // Fresh stock has not been cleared for dispatch yet — the SKU row goes back to STAGED.
    await InventoryBalance.updateOne(
      { _id: balance._id, dispatchStatus: { $in: ['READY_FOR_DISPATCH', 'DISPATCHED'] } },
      { $set: { dispatchStatus: 'STAGED', updatedBy: userId, updatedAt: new Date() } },
    );

    if (inspection.autoDispatchReady && binId) {
      await warehouseService.markReadyForDispatch({
        factoryId: batch.factoryId,
        skuId: order.skuId,
        storageBinId: binId,
        userId,
      });
    }
  }

  if (failed > 0) {
    await recordQcRejectWaste(inspection, batch, order, userId);
  }

  await productionService.recordFinalQcResult(batch._id, { passed, failed }, userId, batch.factoryId);

  // Runs after the inspection is saved as COMPLETED (completion counts COMPLETED FINAL inspections).
  return async () => {
    await productionService.refreshOrderCompletion(order._id, batch.factoryId, userId);
    if (passed > 0) {
      // Warehouse owns FG put-away / staging / dispatch from here.
      await productionService.notifyFactoryRole(batch.factoryId, batch.organizationId, ['warehouse.create'], {
        eventType: 'warehouse.fg_received',
        title: 'Finished goods received',
        message: `${batch.batchNumber}: ${passed} pcs passed final QC${binId ? '' : ' — put them away into a finished-goods bin'}`,
        referenceType: 'PRODUCTION_BATCH',
        referenceId: batch._id,
      }, { excludeUserId: userId });
    }
  };
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
