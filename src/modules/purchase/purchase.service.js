import { Supplier } from './supplier.model.js';
import { PurchaseRequisition } from './purchaseRequisition.model.js';
import { PurchaseOrder } from './purchaseOrder.model.js';
import { GoodsReceipt } from './goodsReceipt.model.js';
import { Material } from '../inventory/material.model.js';
import { MaterialRequirement } from '../mrp/materialRequirement.model.js';
import { Factory } from '../organization/factory.model.js';
import { nextDocumentNumber } from '../../shared/utils/numbering.js';
import { NotFoundError, ConflictError, ValidationError } from '../../shared/errors/AppError.js';
import { applySoftDeleteFilter, asObjectId, pickFields } from '../../shared/utils/schema.js';
import { notify } from '../notification/notification.service.js';
import { submitForApproval, approveInstance, rejectInstance } from '../approval/approval.service.js';
import {
  findPendingApproval, syncApprovalRevisionRequested, cancelPendingApproval,
} from '../../shared/services/approvalSync.js';
import { ApprovalWorkflow } from '../approval/approvalWorkflow.model.js';
import { createIncomingInspection } from '../quality/quality.service.js';
import { notifyUsersWithPermission } from '../inventory/materialMasterRequest.service.js';
import { PO_OPEN_STATUSES, PR_OPEN_STATUSES } from './purchase.defaults.js';
import { computeOnOrderByMaterial } from './purchase.onOrder.js';
import { persistPurchaseReceipts, sendLocalUpload } from '../../shared/services/localFiles.service.js';

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// status is not settable on create (defaults ACTIVE; changed via update)
const SUPPLIER_CREATE_FIELDS = [
  'supplierCode', 'name', 'contactPerson', 'contactEmail', 'phone', 'gstNumber',
  'materialsSupplied', 'leadTimeDays', 'paymentTerms',
];

/** localFiles throws plain Error on bad type/size — validate+store before creating docs, as a 422. */
async function persistReceiptsOrReject(inputs, docCode) {
  if (!inputs?.length) return [];
  try {
    return await persistPurchaseReceipts(inputs, docCode);
  } catch (err) {
    throw new ValidationError(err.message || 'Invalid invoice file');
  }
}

const PR_POPULATE = [
  { path: 'lines.materialId', select: 'materialCode name unit unitCost category' },
  { path: 'requestedBy', select: 'firstName lastName email' },
  { path: 'approvedBy', select: 'firstName lastName email' },
];

const PO_POPULATE = [
  { path: 'supplierId', select: 'name supplierCode contactEmail leadTimeDays' },
  { path: 'prId', select: 'prNumber status' },
  { path: 'lines.materialId', select: 'materialCode name unit unitCost' },
  { path: 'approvedBy', select: 'firstName lastName' },
  { path: 'paidBy', select: 'firstName lastName' },
];

const GRN_POPULATE = [
  { path: 'poId', select: 'poNumber status supplierId' },
  { path: 'lines.materialId', select: 'materialCode name unit' },
  { path: 'receivedBy', select: 'firstName lastName' },
];

async function populatePr(doc) {
  if (!doc) return doc;
  return PurchaseRequisition.findById(doc._id).populate(PR_POPULATE);
}

async function populatePo(doc) {
  if (!doc) return doc;
  return PurchaseOrder.findById(doc._id).populate(PO_POPULATE);
}

async function populateGrn(doc) {
  if (!doc) return doc;
  return GoodsReceipt.findById(doc._id).populate(GRN_POPULATE);
}

/** Pattern/BOM short units → material master units (same quantity, different spelling). */
const UNIT_ALIASES = {
  M: 'METERS', MTR: 'METERS', METER: 'METERS', METRE: 'METERS', METRES: 'METERS',
  YD: 'YARDS', YARD: 'YARDS',
  PC: 'PIECES', PCS: 'PIECES', PIECE: 'PIECES',
  CONE: 'CONES',
  KGS: 'KG',
};

export function normalizeUnit(unit) {
  if (!unit) return unit;
  const key = String(unit).trim().toUpperCase();
  return UNIT_ALIASES[key] || key;
}

/** A purchase line is always in the material's master unit — a different unit would corrupt stock. */
function assertLineUnit(line, mat) {
  if (line.unit && mat?.unit && normalizeUnit(line.unit) !== mat.unit) {
    throw new ValidationError(
      `Unit ${line.unit} does not match material unit ${mat.unit} for ${mat.materialCode || line.materialId}`,
    );
  }
  return mat?.unit || normalizeUnit(line.unit) || 'PIECES';
}

function assertUniqueMaterials(lines, docLabel) {
  const ids = (lines || []).map((l) => l.materialId?.toString());
  if (new Set(ids).size !== ids.length) {
    throw new ValidationError(`Each material may appear only once on a ${docLabel}`);
  }
}

async function assertMaterials(lines, factoryId) {
  if (!lines?.length) throw new ValidationError('At least one line is required');
  const ids = [...new Set(lines.map((l) => l.materialId?.toString()))];
  const materials = await Material.find({ _id: { $in: ids }, factoryId, isDeleted: false });
  if (materials.length !== ids.length) {
    throw new ValidationError('One or more materials are invalid for this factory');
  }
  const matMap = new Map(materials.map((m) => [m._id.toString(), m]));
  return lines.map((line) => {
    const mat = matMap.get(line.materialId.toString());
    return {
      materialId: line.materialId,
      requiredQty: line.requiredQty ?? line.quantity ?? line.orderedQty,
      unit: assertLineUnit(line, mat),
      estimatedUnitCost: line.estimatedUnitCost ?? line.unitPrice ?? mat?.unitCost ?? 0,
    };
  });
}

async function assertSupplierActive(supplierId, factoryId) {
  const supplier = await Supplier.findOne(applySoftDeleteFilter({ _id: supplierId, factoryId }));
  if (!supplier) throw new NotFoundError('Supplier not found');
  if (supplier.status === 'INACTIVE') throw new ConflictError(`Supplier ${supplier.name} is inactive`);
  return supplier;
}

/** Notifications are side effects — never fail the business operation because of them. */
async function safeNotify(fn) {
  try {
    await fn();
  } catch {
    // ignore notification failures
  }
}

/** Short-hand used for PO/GRN line matching: GRN line → PO line by poLineId, else by material. */
function findPoLine(po, grnLine) {
  if (grnLine.poLineId) {
    const byId = po.lines.find((l) => l._id?.toString() === grnLine.poLineId.toString());
    if (byId) return byId;
  }
  return po.lines.find((l) => l.materialId.toString() === grnLine.materialId.toString());
}

/**
 * PO receipt status from its lines. receivedQty is net of QC rejections, so a PO whose goods
 * were rejected drops back to PARTIAL and can take a replacement GRN.
 * Never touches DRAFT / CANCELLED / CLOSED.
 */
function derivePoReceiptStatus(po) {
  if (['DRAFT', 'CANCELLED', 'CLOSED'].includes(po.status)) return po.status;
  const lines = po.lines || [];
  const fullyReceived = lines.length > 0 && lines.every((l) => (l.receivedQty || 0) >= l.orderedQty);
  if (fullyReceived) return 'RECEIVED';
  const anyActivity = lines.some((l) => (l.receivedQty || 0) > 0 || (l.acceptedQty || 0) > 0);
  if (anyActivity) return 'PARTIAL';
  return po.sentAt ? 'SENT' : 'APPROVED';
}

async function recomputePoStatus(poId, userId) {
  const po = await PurchaseOrder.findById(poId);
  if (!po) return null;
  const next = derivePoReceiptStatus(po);
  if (next === po.status) return po;
  await PurchaseOrder.updateOne(
    { _id: po._id, status: { $nin: ['DRAFT', 'CANCELLED', 'CLOSED'] } },
    { $set: { status: next, updatedBy: userId, updatedAt: new Date() }, $inc: { __v: 1 } },
  );
  return PurchaseOrder.findById(po._id);
}

export async function getPurchaseStats(factoryId) {
  const base = applySoftDeleteFilter({ factoryId });
  const [
    suppliers,
    prDraft,
    prSubmitted,
    prApproved,
    poDraft,
    poOpen,
    poUnpaid,
    grnPendingQc,
    grnDraft,
  ] = await Promise.all([
    Supplier.countDocuments(base),
    PurchaseRequisition.countDocuments({ ...base, status: 'DRAFT' }),
    PurchaseRequisition.countDocuments({ ...base, status: 'SUBMITTED' }),
    PurchaseRequisition.countDocuments({ ...base, status: 'APPROVED' }),
    PurchaseOrder.countDocuments({ ...base, status: 'DRAFT' }),
    PurchaseOrder.countDocuments({ ...base, status: { $in: PO_OPEN_STATUSES } }),
    PurchaseOrder.countDocuments({ ...base, status: { $ne: 'CANCELLED' }, paymentStatus: { $ne: 'PAID' } }),
    GoodsReceipt.countDocuments({ ...base, status: 'PENDING_QC' }),
    GoodsReceipt.countDocuments({ ...base, status: 'DRAFT' }),
  ]);

  // Summed in MongoDB instead of hydrating every open/unpaid PO (perf audit).
  const sumTotal = async (match) => {
    const [row] = await PurchaseOrder.aggregate([
      { $match: { factoryId: asObjectId(factoryId), isDeleted: false, ...match } },
      { $group: { _id: null, total: { $sum: { $ifNull: ['$totalAmount', 0] } } } },
    ]);
    return row?.total || 0;
  };
  const [openPoValue, unpaidValue] = await Promise.all([
    sumTotal({ status: { $in: PO_OPEN_STATUSES } }),
    sumTotal({ status: { $ne: 'CANCELLED' }, paymentStatus: { $ne: 'PAID' } }),
  ]);

  return {
    suppliers,
    prDraft,
    prSubmitted,
    prApproved,
    poDraft,
    poOpen,
    poUnpaid,
    grnPendingQc,
    grnDraft,
    openPoValue: Math.round(openPoValue),
    unpaidValue: Math.round(unpaidValue),
  };
}

export async function createSupplier(data, userId) {
  const existing = await Supplier.findOne(applySoftDeleteFilter({
    factoryId: data.factoryId,
    supplierCode: data.supplierCode?.trim(),
  }));
  if (existing) throw new ConflictError(`Supplier code already exists: ${data.supplierCode}`);
  return Supplier.create({
    ...pickFields(data, SUPPLIER_CREATE_FIELDS),
    factoryId: data.factoryId,
    organizationId: data.organizationId,
    createdBy: userId,
    updatedBy: userId,
  });
}

export async function updateSupplier(id, factoryId, data, userId) {
  const supplier = await Supplier.findOne(applySoftDeleteFilter({ _id: id, factoryId }));
  if (!supplier) throw new NotFoundError('Supplier not found');
  if (data.name?.trim()) supplier.name = data.name.trim();
  if (data.contactPerson != null) supplier.contactPerson = data.contactPerson;
  if (data.contactEmail != null) supplier.contactEmail = data.contactEmail;
  if (data.phone != null) supplier.phone = data.phone;
  if (data.gstNumber != null) supplier.gstNumber = data.gstNumber;
  if (data.materialsSupplied != null) supplier.materialsSupplied = data.materialsSupplied;
  if (data.leadTimeDays != null) supplier.leadTimeDays = data.leadTimeDays;
  if (data.paymentTerms != null) supplier.paymentTerms = data.paymentTerms;
  if (data.status) supplier.status = data.status;
  supplier.updatedBy = userId;
  await supplier.save();
  return supplier;
}

export async function listSuppliers(factoryId, { page, limit, skip, search, status }) {
  const filter = applySoftDeleteFilter({ factoryId });
  if (status) filter.status = status;
  if (search?.trim()) {
    const re = new RegExp(escapeRegex(search.trim()), 'i');
    filter.$or = [
      { supplierCode: re },
      { name: re },
      { contactEmail: re },
      { contactPerson: re },
      { gstNumber: re },
      { materialsSupplied: re },
      { phone: re },
    ];
  }
  const [items, total] = await Promise.all([
    Supplier.find(filter).skip(skip).limit(limit).sort({ name: 1 }),
    Supplier.countDocuments(filter),
  ]);
  return { items, total };
}

export async function getSupplier(id, factoryId) {
  const supplier = await Supplier.findOne(applySoftDeleteFilter({ _id: id, factoryId }));
  if (!supplier) throw new NotFoundError('Supplier not found');
  return supplier;
}

export async function createPurchaseRequisition({ factoryId, organizationId, lines, sourceType, mrpId }, userId) {
  assertUniqueMaterials(lines, 'PR');
  const normalizedLines = await assertMaterials(
    lines.map((l) => ({ ...l, requiredQty: l.requiredQty ?? l.quantity })),
    factoryId,
  );
  const factory = await Factory.findById(factoryId);
  const prNumber = await nextDocumentNumber(factoryId, 'PR', `PR-${factory.code}-`);
  const pr = await PurchaseRequisition.create({
    organizationId,
    factoryId,
    prNumber,
    lines: normalizedLines,
    sourceType: sourceType || 'MANUAL',
    mrpId,
    status: 'DRAFT',
    requestedBy: userId,
    createdBy: userId,
    updatedBy: userId,
  });
  return populatePr(pr);
}

export async function createPrFromMrp(mrpId, factoryId, userId) {
  const mrp = await MaterialRequirement.findOne({ _id: mrpId, factoryId, isDeleted: false });
  if (!mrp) throw new NotFoundError('MRP record not found');

  const shortageLines = mrp.lines.filter((l) => l.shortageQty > 0);
  if (!shortageLines.length) throw new ConflictError('No material shortages in MRP');

  // Same MRP run already has a live PR → idempotent: return it (REJECTED / CANCELLED don't block)
  const existingPr = await PurchaseRequisition.findOne(applySoftDeleteFilter({
    factoryId,
    mrpId: mrp._id,
    status: { $nin: ['REJECTED', 'CANCELLED'] },
  })).sort({ createdAt: -1 });
  if (existingPr) return populatePr(existingPr);

  // Dedupe across MRP runs of the same production order / sample / BOM: quantity already on a
  // live PR (or on the PO / pending-QC GRN created from one) for this reference is not re-requested.
  const siblingMrpIds = await MaterialRequirement.find({
    factoryId,
    referenceType: mrp.referenceType,
    referenceId: mrp.referenceId,
    isDeleted: false,
  }).distinct('_id');
  const coveringPrs = await PurchaseRequisition.find(applySoftDeleteFilter({
    factoryId,
    mrpId: { $in: siblingMrpIds },
    status: { $in: [...PR_OPEN_STATUSES, 'CONVERTED'] },
  })).select('_id createdAt status').sort({ createdAt: -1 });
  const covered = await computeOnOrderByMaterial(factoryId, {
    prIds: coveringPrs.map((p) => p._id),
    materialIds: shortageLines.map((l) => l.materialId),
  });

  const lines = shortageLines
    .map((l) => ({
      materialId: l.materialId,
      requiredQty: Math.max(0, l.shortageQty - (covered.get(l.materialId.toString()) || 0)),
      // MRP lines may carry BOM/pattern spellings (M, PC) — PR lines are always in the material unit
      unit: undefined,
      estimatedUnitCost: l.unitCost || 0,
    }))
    .filter((l) => l.requiredQty > 0);

  if (!lines.length) {
    const live = coveringPrs.find((p) => PR_OPEN_STATUSES.includes(p.status)) || coveringPrs[0];
    if (live) return populatePr(live);
    throw new ConflictError('Shortages are already covered by open requisitions / purchase orders');
  }

  return createPurchaseRequisition({
    factoryId: mrp.factoryId,
    organizationId: mrp.organizationId,
    lines,
    sourceType: 'MRP',
    mrpId: mrp._id,
  }, userId);
}

export async function listPurchaseRequisitions(factoryId, { page, limit, skip, status, excludeStatus, search, sourceType }) {
  const filter = applySoftDeleteFilter({ factoryId });
  if (status) {
    const statuses = String(status).split(',').map((s) => s.trim()).filter(Boolean);
    filter.status = statuses.length > 1 ? { $in: statuses } : statuses[0];
  } else if (excludeStatus) {
    const excluded = String(excludeStatus).split(',').map((s) => s.trim()).filter(Boolean);
    filter.status = { $nin: excluded };
  }
  if (sourceType) filter.sourceType = sourceType;
  if (search?.trim()) {
    filter.prNumber = new RegExp(escapeRegex(search.trim()), 'i');
  }
  const [items, total] = await Promise.all([
    PurchaseRequisition.find(filter).populate(PR_POPULATE).skip(skip).limit(limit).sort({ updatedAt: -1 }),
    PurchaseRequisition.countDocuments(filter),
  ]);
  return { items, total };
}

async function loadPr(id, factoryId) {
  const pr = await PurchaseRequisition.findOne(applySoftDeleteFilter({ _id: id, factoryId }));
  if (!pr) throw new NotFoundError('Purchase requisition not found');
  return pr;
}

export async function getPurchaseRequisition(id, factoryId) {
  const pr = await PurchaseRequisition.findOne(applySoftDeleteFilter({ _id: id, factoryId })).populate(PR_POPULATE);
  if (!pr) throw new NotFoundError('Purchase requisition not found');
  return pr;
}

export async function submitPurchaseRequisition(id, factoryId, userId) {
  const pr = await loadPr(id, factoryId);
  if (!['DRAFT', 'REJECTED'].includes(pr.status)) {
    throw new ConflictError('Only DRAFT or REJECTED PR can be submitted');
  }
  if (!pr.lines?.length) throw new ValidationError('PR must have at least one line');
  const previous = {
    status: pr.status,
    rejectionComments: pr.rejectionComments,
    revisionComments: pr.revisionComments,
  };
  pr.status = 'SUBMITTED';
  pr.rejectionComments = undefined;
  pr.revisionComments = undefined;
  pr.updatedBy = userId;
  await pr.save();
  try {
    await submitForApproval({
      organizationId: pr.organizationId,
      factoryId: pr.factoryId,
      documentType: 'PURCHASE_REQUISITION',
      documentId: pr._id,
      submittedBy: userId,
    });
  } catch (err) {
    // Don't leave a SUBMITTED PR with no approval instance (nobody could act on it)
    await PurchaseRequisition.updateOne(
      { _id: pr._id, status: 'SUBMITTED' },
      { $set: { ...pickFields(previous, Object.keys(previous)), updatedBy: userId, updatedAt: new Date() } },
    ).catch(() => {});
    throw err;
  }
  if (pr.requestedBy) {
    await notify({
      organizationId: pr.organizationId,
      factoryId: pr.factoryId,
      userId: pr.requestedBy,
      eventType: 'pr.submitted',
      title: 'PR submitted',
      message: `${pr.prNumber} submitted for Factory Admin / Super Admin approval`,
      referenceType: 'PURCHASE_REQUISITION',
      referenceId: pr._id,
    });
  }
  return populatePr(pr);
}

/**
 * Direct approve/reject (no pending instance) is only allowed when this factory has no approval
 * workflow for PRs — otherwise it would skip the configured levels.
 */
async function assertNoWorkflowBypass(pr) {
  const workflow = await ApprovalWorkflow.exists({
    factoryId: pr.factoryId,
    documentType: 'PURCHASE_REQUISITION',
    isActive: true,
  });
  if (workflow) {
    throw new ConflictError(
      `${pr.prNumber} has no pending approval — request changes or resubmit it so the approval workflow applies`,
    );
  }
}

/**
 * Approver sends a SUBMITTED PR back to the requester (→ DRAFT) with revision comments.
 * Direct calls (syncApproval) also close the pending approval instance as CHANGES_REQUESTED;
 * the approval bridge calls with syncApproval:false because it already closed it.
 */
export async function requestPurchaseRequisitionChanges(id, factoryId, userId, comments, { syncApproval = true } = {}) {
  const note = String(comments || '').trim();
  if (note.length < 3) throw new ValidationError('Comments are required when requesting changes');
  const pr = await PurchaseRequisition.findOneAndUpdate(
    { _id: id, factoryId, status: 'SUBMITTED', isDeleted: false },
    {
      $set: {
        status: 'DRAFT',
        revisionComments: note,
        revisionRequestedAt: new Date(),
        revisionRequestedBy: userId,
        updatedBy: userId,
        updatedAt: new Date(),
      },
    },
    { new: true },
  );
  if (!pr) {
    await loadPr(id, factoryId);
    throw new ConflictError('PR must be SUBMITTED to request changes');
  }
  if (syncApproval) {
    try {
      await syncApprovalRevisionRequested('PURCHASE_REQUISITION', pr._id, userId, note);
    } catch (err) {
      await PurchaseRequisition.updateOne(
        { _id: pr._id, status: 'DRAFT' },
        {
          $set: { status: 'SUBMITTED', updatedBy: userId, updatedAt: new Date() },
          $unset: { revisionComments: 1, revisionRequestedAt: 1, revisionRequestedBy: 1 },
        },
      ).catch(() => {});
      throw err;
    }
  }
  if (pr.requestedBy) {
    await safeNotify(() => notify({
      organizationId: pr.organizationId,
      factoryId: pr.factoryId,
      userId: pr.requestedBy,
      eventType: 'pr.revision_requested',
      title: 'PR changes requested',
      message: `${pr.prNumber} sent back for changes: ${note}`,
      referenceType: 'PURCHASE_REQUISITION',
      referenceId: pr._id,
    }));
  }
  return populatePr(pr);
}

/**
 * Requester revises a DRAFT / REJECTED PR (typically after "Request changes"). Lines are replaced;
 * the revision / rejection comments stay visible until it is resubmitted.
 */
export async function updatePurchaseRequisition(id, factoryId, { lines }, userId) {
  const pr = await loadPr(id, factoryId);
  if (!['DRAFT', 'REJECTED'].includes(pr.status)) {
    throw new ConflictError('Only a DRAFT or REJECTED requisition can be edited');
  }
  assertUniqueMaterials(lines, 'PR');
  const normalizedLines = await assertMaterials(
    lines.map((l) => ({ ...l, requiredQty: l.requiredQty ?? l.quantity })),
    factoryId,
  );
  const updated = await PurchaseRequisition.findOneAndUpdate(
    { _id: pr._id, factoryId, status: { $in: ['DRAFT', 'REJECTED'] }, isDeleted: false },
    { $set: { lines: normalizedLines, updatedBy: userId, updatedAt: new Date() } },
    { new: true, runValidators: true },
  );
  if (!updated) throw new ConflictError('Requisition changed while saving — refresh and try again');
  return populatePr(updated);
}

/** Withdraw a DRAFT or REJECTED PR (never reached a PO). */
export async function cancelPurchaseRequisition(id, factoryId, userId) {
  const pr = await PurchaseRequisition.findOneAndUpdate(
    { _id: id, factoryId, status: { $in: ['DRAFT', 'REJECTED'] }, isDeleted: false },
    { $set: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: userId, updatedBy: userId, updatedAt: new Date() } },
    { new: true },
  );
  if (!pr) {
    await loadPr(id, factoryId);
    throw new ConflictError('Only DRAFT or REJECTED PR can be cancelled');
  }
  await cancelPendingApproval('PURCHASE_REQUISITION', pr._id, userId, 'PR cancelled').catch(() => {});
  return populatePr(pr);
}

/**
 * Advance PR approval. Single-level Factory Admin / Super Admin (purchase.authorize).
 * Final APPROVED is applied by the approval bridge.
 */
export async function approvePurchaseRequisition(id, factoryId, userId, { syncApproval = true, permissions } = {}) {
  if (syncApproval) {
    const pending = await findPendingApproval('PURCHASE_REQUISITION', id);
    if (pending) {
      await approveInstance(pending._id, userId, '', { factoryId, permissions });
      return populatePr(await loadPr(id, factoryId));
    }
  }

  const pr = await loadPr(id, factoryId);
  if (pr.status !== 'SUBMITTED') throw new ConflictError('PR must be SUBMITTED to approve');
  if (syncApproval) await assertNoWorkflowBypass(pr);
  pr.status = 'APPROVED';
  pr.approvedBy = userId;
  pr.approvedAt = new Date();
  pr.updatedBy = userId;
  await pr.save();
  if (pr.requestedBy) {
    await notify({
      organizationId: pr.organizationId,
      factoryId: pr.factoryId,
      userId: pr.requestedBy,
      eventType: 'pr.approved',
      title: 'PR approved',
      message: `${pr.prNumber} approved — create a payment (agreed with supplier on call)`,
      referenceType: 'PURCHASE_REQUISITION',
      referenceId: pr._id,
    });
  }
  return populatePr(pr);
}

export async function rejectPurchaseRequisition(id, factoryId, userId, comments, { syncApproval = true, permissions } = {}) {
  if (syncApproval) {
    const pending = await findPendingApproval('PURCHASE_REQUISITION', id);
    if (pending) {
      await rejectInstance(pending._id, userId, comments, { factoryId, permissions });
      return populatePr(await loadPr(id, factoryId));
    }
  }

  const pr = await loadPr(id, factoryId);
  if (pr.status !== 'SUBMITTED') throw new ConflictError('PR must be SUBMITTED to reject');
  if (syncApproval) await assertNoWorkflowBypass(pr);
  pr.status = 'REJECTED';
  pr.rejectionComments = comments;
  pr.updatedBy = userId;
  await pr.save();
  if (pr.requestedBy) {
    await notify({
      organizationId: pr.organizationId,
      factoryId: pr.factoryId,
      userId: pr.requestedBy,
      eventType: 'pr.rejected',
      title: 'PR rejected',
      message: `${pr.prNumber} rejected${comments ? `: ${comments}` : ''}`,
      referenceType: 'PURCHASE_REQUISITION',
      referenceId: pr._id,
    });
  }
  return populatePr(pr);
}

export async function createPurchaseOrder({ factoryId, organizationId, supplierId, prId, lines, receipts }, userId) {
  const supplier = await assertSupplierActive(supplierId, factoryId);

  let orderLines = lines;
  if (prId) {
    // Any PO tied to a PR requires a factory-scoped, APPROVED PR
    const pr = await loadPr(prId, factoryId);
    if (pr.status !== 'APPROVED') throw new ConflictError('PR must be APPROVED');
    const prLineByMat = new Map(pr.lines.map((l) => [l.materialId.toString(), l]));
    if (!lines?.length) {
      orderLines = pr.lines.map((line) => ({
        materialId: line.materialId,
        orderedQty: line.requiredQty,
        unit: line.unit,
        unitPrice: line.estimatedUnitCost || undefined,
      }));
    } else {
      // Explicit lines (agreed price override) must stay within the approved PR
      assertUniqueMaterials(lines, 'PO');
      orderLines = lines.map((line) => {
        const prLine = prLineByMat.get(line.materialId?.toString());
        if (!prLine) throw new ValidationError(`Material ${line.materialId} is not on ${pr.prNumber}`);
        const qty = line.orderedQty ?? line.quantity ?? prLine.requiredQty;
        if (qty > prLine.requiredQty) {
          throw new ValidationError(
            `Ordered qty ${qty} exceeds approved PR qty ${prLine.requiredQty} for material ${line.materialId}`,
          );
        }
        return {
          materialId: line.materialId,
          orderedQty: qty,
          unit: line.unit || prLine.unit,
          unitPrice: line.unitPrice ?? (prLine.estimatedUnitCost || undefined),
        };
      });
    }
  }

  if (!orderLines?.length) throw new ValidationError('Add at least one material line to the payment');
  assertUniqueMaterials(orderLines, 'PO');
  if (orderLines.some((l) => !((l.orderedQty ?? l.quantity) > 0))) {
    throw new ValidationError('Each payment line needs a quantity greater than zero');
  }
  const checked = await assertMaterials(orderLines.map((l) => ({
    materialId: l.materialId,
    requiredQty: l.orderedQty ?? l.quantity,
    unit: l.unit,
    estimatedUnitCost: l.unitPrice,
  })), factoryId);
  // Unit pinned to the material master; default price = PR estimate → material cost
  orderLines = orderLines.map((l, i) => ({
    ...l,
    unit: checked[i].unit,
    unitPrice: l.unitPrice ?? checked[i].estimatedUnitCost ?? 0,
  }));

  const factory = await Factory.findById(factoryId);
  const poNumber = await nextDocumentNumber(factoryId, 'PO', `PO-${factory.code}-`);

  const savedReceipts = await persistReceiptsOrReject(receipts, poNumber);

  const po = await PurchaseOrder.create({
    organizationId,
    factoryId,
    poNumber,
    supplierId,
    prId,
    lines: orderLines.map((l) => ({
      materialId: l.materialId,
      orderedQty: l.orderedQty ?? l.quantity,
      unit: l.unit,
      unitPrice: l.unitPrice ?? 0,
      receivedQty: 0,
    })),
    status: 'APPROVED',
    paymentStatus: 'UNPAID',
    approvedBy: userId,
    approvedAt: new Date(),
    receipts: savedReceipts,
    createdBy: userId,
    updatedBy: userId,
  });

  if (prId) {
    // Claim the PR atomically only after the PO exists; if another request won, undo our PO
    const converted = await PurchaseRequisition.findOneAndUpdate(
      { _id: prId, factoryId, status: 'APPROVED', isDeleted: false },
      { $set: { status: 'CONVERTED', updatedBy: userId, updatedAt: new Date() } },
      { new: true },
    );
    if (!converted) {
      await PurchaseOrder.deleteOne({ _id: po._id });
      throw new ConflictError('PR was already converted to a purchase order');
    }
  }

  // Finance (purchase.pay) needs to know a payment is now owed
  await safeNotify(() => notifyUsersWithPermission({
    organizationId: po.organizationId,
    factoryId: po.factoryId,
    permission: 'purchase.pay',
    excludeUserId: userId,
    eventType: 'po.created',
    title: 'Payment created',
    message: `${po.poNumber} — ${supplier.name} · ${Math.round(po.totalAmount || 0)} — mark paid once the invoice is on GRN`,
    referenceType: 'PURCHASE_ORDER',
    referenceId: po._id,
  }));
  return populatePo(po);
}

/**
 * Cancel an APPROVED/SENT PO that has no receipts and is not paid. The source PR goes back to
 * APPROVED so a new payment can be raised.
 */
export async function cancelPurchaseOrder(id, factoryId, userId, reason) {
  const po = await loadPo(id, factoryId);
  if (!['APPROVED', 'SENT'].includes(po.status)) {
    throw new ConflictError('Only APPROVED or SENT payments with no receipts can be cancelled');
  }
  if (po.paymentStatus === 'PAID') throw new ConflictError('Paid payment cannot be cancelled');
  const hasGrn = await GoodsReceipt.exists(applySoftDeleteFilter({
    factoryId, poId: po._id, status: { $ne: 'CANCELLED' },
  }));
  if (hasGrn) throw new ConflictError('Goods were already received against this payment — cancel the GRN first or short-close');

  // Atomic claim; the __v bump makes a concurrent GRN's po.save() fail with VersionError
  const cancelled = await PurchaseOrder.findOneAndUpdate(
    {
      _id: po._id,
      factoryId,
      isDeleted: false,
      status: { $in: ['APPROVED', 'SENT'] },
      paymentStatus: { $ne: 'PAID' },
      'lines.receivedQty': { $not: { $gt: 0 } },
    },
    {
      $set: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledBy: userId,
        cancelReason: String(reason || '').trim() || undefined,
        updatedBy: userId,
        updatedAt: new Date(),
      },
      $inc: { __v: 1 },
    },
    { new: true },
  );
  if (!cancelled) throw new ConflictError('Payment changed while cancelling — refresh and try again');

  if (cancelled.prId) {
    await PurchaseRequisition.updateOne(
      { _id: cancelled.prId, factoryId, status: 'CONVERTED', isDeleted: false },
      { $set: { status: 'APPROVED', updatedBy: userId, updatedAt: new Date() } },
    );
  }
  await cancelPendingApproval('PURCHASE_ORDER', cancelled._id, userId, 'Payment cancelled').catch(() => {});
  return populatePo(cancelled);
}

/** Short-close a PARTIAL PO: the unreceived balance is no longer expected. */
export async function closePurchaseOrder(id, factoryId, userId, reason) {
  const po = await loadPo(id, factoryId);
  if (po.status !== 'PARTIAL') throw new ConflictError('Only a PARTIAL payment can be short-closed');
  const draftGrn = await GoodsReceipt.exists(applySoftDeleteFilter({ factoryId, poId: po._id, status: 'DRAFT' }));
  if (draftGrn) throw new ConflictError('Submit or cancel the DRAFT GRN before closing');
  const closed = await PurchaseOrder.findOneAndUpdate(
    { _id: po._id, factoryId, isDeleted: false, status: 'PARTIAL' },
    {
      $set: {
        status: 'CLOSED',
        closedAt: new Date(),
        closedBy: userId,
        closeReason: String(reason || '').trim() || undefined,
        updatedBy: userId,
        updatedAt: new Date(),
      },
      $inc: { __v: 1 },
    },
    { new: true },
  );
  if (!closed) throw new ConflictError('Payment changed while closing — refresh and try again');
  return populatePo(closed);
}

export async function listPurchaseOrders(factoryId, { page, limit, skip, status, excludeStatus, search, supplierId, paymentStatus }) {
  const filter = applySoftDeleteFilter({ factoryId });
  if (status) {
    const statuses = String(status).split(',').map((s) => s.trim()).filter(Boolean);
    filter.status = statuses.length > 1 ? { $in: statuses } : statuses[0];
  } else if (excludeStatus) {
    const excluded = String(excludeStatus).split(',').map((s) => s.trim()).filter(Boolean);
    filter.status = { $nin: excluded };
  }
  if (paymentStatus) {
    const pay = String(paymentStatus).toUpperCase();
    if (pay === 'UNPAID') filter.paymentStatus = { $ne: 'PAID' };
    else filter.paymentStatus = pay;
  }
  if (supplierId) filter.supplierId = supplierId;
  if (search?.trim()) {
    filter.poNumber = new RegExp(escapeRegex(search.trim()), 'i');
  }
  const [items, total] = await Promise.all([
    PurchaseOrder.find(filter).populate(PO_POPULATE).skip(skip).limit(limit).sort({ updatedAt: -1 }),
    PurchaseOrder.countDocuments(filter),
  ]);
  return { items, total };
}

async function loadPo(id, factoryId) {
  const po = await PurchaseOrder.findOne(applySoftDeleteFilter({ _id: id, factoryId }));
  if (!po) throw new NotFoundError('Purchase order not found');
  return po;
}

export async function getPurchaseOrder(id, factoryId) {
  const po = await PurchaseOrder.findOne(applySoftDeleteFilter({ _id: id, factoryId })).populate(PO_POPULATE);
  if (!po) throw new NotFoundError('Purchase order not found');
  return po;
}

export async function approvePurchaseOrder(id, factoryId, userId, { syncApproval: _syncApproval = true } = {}) {
  const po = await loadPo(id, factoryId);
  if (po.status === 'APPROVED' || po.status === 'SENT' || po.status === 'PARTIAL') {
    return populatePo(po);
  }
  if (po.status !== 'DRAFT') throw new ConflictError('Only a draft payment can be approved');
  if (!po.lines?.length) throw new ValidationError('The payment has no material lines');
  po.status = 'APPROVED';
  po.approvedBy = userId;
  po.approvedAt = new Date();
  po.updatedBy = userId;
  await po.save();
  return populatePo(po);
}

export async function setPurchaseOrderReceipts(id, factoryId, receipts, userId) {
  const po = await loadPo(id, factoryId);
  const kept = (receipts || []).filter((r) => r?.url && !r.data && !r.dataUrl);
  const incoming = (receipts || []).filter((r) => r?.data || r?.dataUrl);
  const saved = await persistReceiptsOrReject(incoming, po.poNumber);
  po.receipts = [...kept.map((r) => ({ url: r.url, fileName: r.fileName || '' })), ...saved].slice(0, 12);
  po.updatedBy = userId;
  await po.save();
  return populatePo(po);
}

export async function sendPurchaseOrder(id, factoryId, userId) {
  const po = await loadPo(id, factoryId);
  if (po.status !== 'APPROVED') throw new ConflictError('The payment must be approved before it is sent');
  po.status = 'SENT';
  po.sentAt = new Date();
  po.updatedBy = userId;
  await po.save();
  return populatePo(po);
}

export async function downloadDocumentReceipt(kind, id, index, factoryId, res) {
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0) throw new ValidationError('Invalid invoice');
  const doc = kind === 'grn' ? await loadGrn(id, factoryId) : await loadPo(id, factoryId);
  const item = (doc.receipts || [])[i];
  if (!item?.url) throw new NotFoundError('Invoice not found');
  const prefix = kind === 'grn' ? doc.grnNumber : doc.poNumber;
  const name = item.fileName || `${prefix}-invoice-${i + 1}`;
  try {
    await sendLocalUpload(res, item.url, name);
  } catch (err) {
    if (err.statusCode === 404 || err.message === 'Invoice file not found' || err.message === 'Invalid file path') {
      throw new NotFoundError('Invoice file not found');
    }
    throw err;
  }
}

export async function markPurchaseOrderPaid(id, factoryId, userId) {
  const po = await loadPo(id, factoryId);
  if (po.status === 'CANCELLED') throw new ConflictError('Cancelled payment cannot be marked paid');
  if (po.paymentStatus === 'PAID') throw new ConflictError('Already marked paid');
  const hasPoInvoice = (po.receipts || []).length > 0;
  const hasGrnInvoice = await GoodsReceipt.exists(applySoftDeleteFilter({
    factoryId,
    poId: po._id,
    'receipts.0': { $exists: true },
  }));
  if (!hasPoInvoice && !hasGrnInvoice) {
    throw new ValidationError('Upload the supplier invoice on GRN before marking paid');
  }
  po.paymentStatus = 'PAID';
  po.paidAt = new Date();
  po.paidBy = userId;
  po.updatedBy = userId;
  await po.save();
  return populatePo(po);
}

export async function createGoodsReceipt({ factoryId, organizationId, poId, lines, receipts }, userId) {
  const po = await loadPo(poId, factoryId);
  if (!PO_OPEN_STATUSES.includes(po.status)) {
    throw new ConflictError('This payment is not open for receiving goods');
  }
  if (!lines?.length) throw new ValidationError('GRN lines are required');

  const factory = await Factory.findById(factoryId);
  const grnNumber = await nextDocumentNumber(factoryId, 'GRN', `GRN-${factory.code}-`);

  assertUniqueMaterials(lines, 'GRN');
  const grnLines = [];
  for (const line of lines) {
    const mat = await Material.findById(line.materialId);
    // Messages name the material by code — users never see raw ids.
    const matLabel = mat?.materialCode || String(line.materialId);
    const poLine = po.lines.find((l) => l.materialId.toString() === line.materialId.toString());
    if (!poLine) throw new ConflictError(`${matLabel} is not on this payment`);
    const remaining = poLine.orderedQty - (poLine.receivedQty || 0);
    if (line.receivedQty <= 0) throw new ValidationError('Received quantity must be greater than zero');
    if (line.receivedQty > remaining) {
      throw new ConflictError(`${matLabel}: received quantity is more than the ${remaining} still open on this payment`);
    }
    // GRN is received in the PO's unit; a different unit would corrupt receivedQty and stock
    const poUnit = poLine.unit || mat?.unit;
    if (line.unit && poUnit && normalizeUnit(line.unit) !== poUnit) {
      throw new ValidationError(`${matLabel} is received in ${poUnit} (the payment's unit), not ${line.unit}`);
    }
    grnLines.push({
      materialId: line.materialId,
      poLineId: poLine._id,
      receivedQty: line.receivedQty,
      unit: poUnit || line.unit,
      unitPrice: poLine.unitPrice || 0,
    });
  }

  const savedReceipts = await persistReceiptsOrReject(receipts, grnNumber);

  // GRN first, then the PO draw-down; if the PO write fails, the GRN is removed again
  const grn = await GoodsReceipt.create({
    organizationId,
    factoryId,
    grnNumber,
    poId,
    lines: grnLines,
    status: 'DRAFT',
    receivedBy: userId,
    receipts: savedReceipts,
    createdBy: userId,
    updatedBy: userId,
  });

  try {
    for (const line of grnLines) {
      const poLine = po.lines.id(line.poLineId);
      poLine.receivedQty = (poLine.receivedQty || 0) + line.receivedQty;
    }
    po.status = derivePoReceiptStatus(po);
    po.updatedBy = userId;
    // optimisticConcurrency on PO: a concurrent GRN / cancel / QC write-back fails here with VersionError (409)
    await po.save();
  } catch (err) {
    await GoodsReceipt.deleteOne({ _id: grn._id }).catch(() => {});
    throw err;
  }
  return populateGrn(grn);
}

/** Cancel a DRAFT GRN (not yet sent to QC): its quantities go back to the PO's open balance. */
export async function cancelGoodsReceipt(id, factoryId, userId) {
  const grn = await GoodsReceipt.findOneAndUpdate(
    { _id: id, factoryId, status: 'DRAFT', isDeleted: false },
    { $set: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: userId, updatedBy: userId, updatedAt: new Date() } },
    { new: true },
  );
  if (!grn) {
    await loadGrn(id, factoryId);
    throw new ConflictError('Only a DRAFT GRN can be cancelled');
  }
  try {
    const po = await loadPo(grn.poId, factoryId);
    for (const line of grn.lines) {
      const poLine = findPoLine(po, line);
      if (!poLine) continue;
      poLine.receivedQty = Math.max(0, (poLine.receivedQty || 0) - (line.receivedQty || 0));
    }
    po.status = derivePoReceiptStatus(po);
    po.updatedBy = userId;
    await po.save();
  } catch (err) {
    await GoodsReceipt.updateOne(
      { _id: grn._id, status: 'CANCELLED' },
      { $set: { status: 'DRAFT', updatedBy: userId, updatedAt: new Date() }, $unset: { cancelledAt: 1, cancelledBy: 1 } },
    ).catch(() => {});
    throw err;
  }
  return populateGrn(grn);
}

/**
 * Incoming QC write-back (called by quality completeIncomingQc).
 * Per PO line: acceptedQty += accepted, rejectedQty += rejected, receivedQty -= rejected (rejected
 * goods no longer count as received, so a replacement GRN can be raised), then PO status is
 * recomputed (CANCELLED / CLOSED untouched). Idempotent via grn.poSyncedAt.
 *
 * @param {{ grnId, factoryId, lines: Array<{ materialId, acceptedQty, rejectedQty }>, userId }} args
 *   Per GRN line, rejected is clamped to the GRN line's receivedQty and accepted to the rest.
 * @returns {Promise<{ applied: boolean, po: object|null }>}
 */
export async function recordIncomingQcResult({ grnId, factoryId, lines, userId }) {
  const claimFilter = { _id: grnId, isDeleted: false, poSyncedAt: null, status: { $ne: 'CANCELLED' } };
  if (factoryId) claimFilter.factoryId = factoryId;
  const grn = await GoodsReceipt.findOneAndUpdate(
    claimFilter,
    { $set: { poSyncedAt: new Date(), updatedBy: userId, updatedAt: new Date() } },
    { new: true },
  );
  if (!grn) {
    const exists = await GoodsReceipt.exists({ ...pickFields({ _id: grnId, factoryId }, ['_id', 'factoryId']), isDeleted: false });
    if (!exists) throw new NotFoundError('Goods receipt not found');
    return { applied: false, po: null }; // already written back
  }

  // Sum the QC result per material (defensive against duplicate lines)
  const byMaterial = new Map();
  for (const l of lines || []) {
    if (!l?.materialId) continue;
    const key = l.materialId.toString();
    const cur = byMaterial.get(key) || { accepted: 0, rejected: 0 };
    cur.accepted += Math.max(0, Number(l.acceptedQty) || 0);
    cur.rejected += Math.max(0, Number(l.rejectedQty) || 0);
    byMaterial.set(key, cur);
  }

  const applied = [];
  try {
    const po = await PurchaseOrder.findOne({ _id: grn.poId, isDeleted: false });
    if (!po) throw new NotFoundError('Purchase order not found');
    for (const grnLine of grn.lines) {
      const result = byMaterial.get(grnLine.materialId.toString());
      if (!result) continue;
      const received = grnLine.receivedQty || 0;
      const rejected = Math.min(result.rejected, received);
      const accepted = Math.min(result.accepted, Math.max(0, received - rejected));
      if (!accepted && !rejected) continue;
      const poLine = findPoLine(po, grnLine);
      if (!poLine) continue;
      const inc = {
        'lines.$.acceptedQty': accepted,
        'lines.$.rejectedQty': rejected,
        'lines.$.receivedQty': -rejected,
        __v: 1,
      };
      const res = await PurchaseOrder.updateOne(
        { _id: po._id, 'lines._id': poLine._id },
        { $inc: inc, $set: { updatedBy: userId, updatedAt: new Date() } },
      );
      if (!res.matchedCount) throw new ConflictError('PO line not found for QC write-back');
      applied.push({ poLineId: poLine._id, accepted, rejected });
    }
    const updatedPo = await recomputePoStatus(po._id, userId);
    return { applied: true, po: updatedPo };
  } catch (err) {
    for (const a of applied) {
      await PurchaseOrder.updateOne(
        { _id: grn.poId, 'lines._id': a.poLineId },
        {
          $inc: {
            'lines.$.acceptedQty': -a.accepted,
            'lines.$.rejectedQty': -a.rejected,
            'lines.$.receivedQty': a.rejected,
            __v: 1,
          },
        },
      ).catch(() => {});
    }
    await GoodsReceipt.updateOne({ _id: grn._id }, { $set: { poSyncedAt: null } }).catch(() => {});
    throw err;
  }
}

/** Unit price of the PO line a GRN line draws from (GRN lines also carry unitPrice since creation). */
export async function getPoLineUnitPrice(grnId, materialId, factoryId) {
  const filter = applySoftDeleteFilter({ _id: grnId });
  if (factoryId) filter.factoryId = factoryId;
  const grn = await GoodsReceipt.findOne(filter);
  if (!grn) throw new NotFoundError('Goods receipt not found');
  const grnLine = grn.lines.find((l) => l.materialId.toString() === String(materialId));
  if (!grnLine) return 0;
  if (grnLine.unitPrice) return grnLine.unitPrice;
  const po = await PurchaseOrder.findById(grn.poId).select('lines');
  const poLine = po ? findPoLine(po, grnLine) : null;
  return poLine?.unitPrice || 0;
}

export async function listGoodsReceipts(factoryId, { page, limit, skip, status, excludeStatus, search }) {
  const filter = applySoftDeleteFilter({ factoryId });
  if (status) {
    const statuses = String(status).split(',').map((s) => s.trim()).filter(Boolean);
    filter.status = statuses.length > 1 ? { $in: statuses } : statuses[0];
  } else if (excludeStatus) {
    const excluded = String(excludeStatus).split(',').map((s) => s.trim()).filter(Boolean);
    filter.status = { $nin: excluded };
  }
  if (search?.trim()) {
    filter.grnNumber = new RegExp(escapeRegex(search.trim()), 'i');
  }
  const [items, total] = await Promise.all([
    GoodsReceipt.find(filter).populate(GRN_POPULATE).skip(skip).limit(limit).sort({ updatedAt: -1 }),
    GoodsReceipt.countDocuments(filter),
  ]);
  return { items, total };
}

async function loadGrn(id, factoryId) {
  const grn = await GoodsReceipt.findOne(applySoftDeleteFilter({ _id: id, factoryId }));
  if (!grn) throw new NotFoundError('Goods receipt not found');
  return grn;
}

export async function getGoodsReceipt(id, factoryId) {
  const grn = await GoodsReceipt.findOne(applySoftDeleteFilter({ _id: id, factoryId })).populate(GRN_POPULATE);
  if (!grn) throw new NotFoundError('Goods receipt not found');
  return grn;
}

export async function setGoodsReceiptReceipts(id, factoryId, receipts, userId) {
  const grn = await loadGrn(id, factoryId);
  const kept = (receipts || []).filter((r) => r?.url && !r.data && !r.dataUrl);
  const incoming = (receipts || []).filter((r) => r?.data || r?.dataUrl);
  const saved = await persistReceiptsOrReject(incoming, grn.grnNumber);
  grn.receipts = [...kept.map((r) => ({ url: r.url, fileName: r.fileName || '' })), ...saved].slice(0, 12);
  grn.updatedBy = userId;
  await grn.save();
  return populateGrn(grn);
}

export async function submitGrnForQc(id, factoryId, userId) {
  // Atomic DRAFT → PENDING_QC so a concurrent cancel / double submit can't both win
  const grn = await GoodsReceipt.findOneAndUpdate(
    { _id: id, factoryId, status: 'DRAFT', isDeleted: false },
    { $set: { status: 'PENDING_QC', updatedBy: userId, updatedAt: new Date() } },
    { new: true },
  );
  if (!grn) {
    const existing = await loadGrn(id, factoryId);
    throw new ConflictError(existing.status === 'CANCELLED' ? 'GRN is cancelled' : 'GRN already submitted');
  }
  let inspection;
  try {
    inspection = await createIncomingInspection(grn._id, userId, grn.factoryId);
  } catch (err) {
    await GoodsReceipt.updateOne(
      { _id: grn._id, status: 'PENDING_QC' },
      { $set: { status: 'DRAFT', updatedBy: userId, updatedAt: new Date() } },
    ).catch(() => {});
    throw err;
  }
  await safeNotify(() => notifyUsersWithPermission({
    organizationId: grn.organizationId,
    factoryId: grn.factoryId,
    permission: 'quality.update',
    excludeUserId: userId,
    eventType: 'grn.qc_pending',
    title: 'Incoming QC pending',
    message: `${grn.grnNumber} received — inspect to release stock${inspection?.inspectionNumber ? ` (${inspection.inspectionNumber})` : ''}`,
    referenceType: inspection?._id ? 'QUALITY_INSPECTION' : 'GOODS_RECEIPT',
    referenceId: inspection?._id || grn._id,
  }));
  return populateGrn(grn);
}

export async function getPoReceiptPreview(poId, factoryId) {
  const po = await getPurchaseOrder(poId, factoryId);
  const lines = (po.lines || []).map((line) => {
    const mat = line.materialId;
    const ordered = line.orderedQty || 0;
    const received = line.receivedQty || 0;
    return {
      materialId: typeof mat === 'object' ? mat._id : line.materialId,
      materialCode: typeof mat === 'object' ? mat.materialCode : undefined,
      materialName: typeof mat === 'object' ? mat.name : undefined,
      orderedQty: ordered,
      receivedQty: received,
      remainingQty: Math.max(0, ordered - received),
      unit: line.unit || (typeof mat === 'object' ? mat.unit : undefined),
    };
  }).filter((l) => l.remainingQty > 0);
  return { poId: po._id, poNumber: po.poNumber, poStatus: po.status, lines };
}
