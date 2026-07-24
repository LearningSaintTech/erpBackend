import { Supplier } from './supplier.model.js';
import { PurchaseRequisition } from './purchaseRequisition.model.js';
import { PurchaseOrder } from './purchaseOrder.model.js';
import { GoodsReceipt } from './goodsReceipt.model.js';
import { Rfq } from './rfq.model.js';
import { Material } from '../inventory/material.model.js';
import { MaterialRequirement } from '../mrp/materialRequirement.model.js';
import { Factory } from '../organization/factory.model.js';
import { nextDocumentNumber } from '../../shared/utils/numbering.js';
import { NotFoundError, ConflictError, ValidationError } from '../../shared/errors/AppError.js';
import { applySoftDeleteFilter } from '../../shared/utils/schema.js';
import { notify } from '../notification/notification.service.js';
import { submitForApproval, approveInstance, rejectInstance } from '../approval/approval.service.js';
import { findPendingApproval } from '../../shared/services/approvalSync.js';
import { createIncomingInspection } from '../quality/quality.service.js';
import { PO_OPEN_STATUSES } from './purchase.defaults.js';

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
      unit: line.unit || mat?.unit || 'PIECES',
      estimatedUnitCost: line.estimatedUnitCost ?? line.unitPrice ?? mat?.unitCost ?? 0,
    };
  });
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
    grnPendingQc,
    grnDraft,
    rfqOpen,
  ] = await Promise.all([
    Supplier.countDocuments(base),
    PurchaseRequisition.countDocuments({ ...base, status: 'DRAFT' }),
    PurchaseRequisition.countDocuments({ ...base, status: 'SUBMITTED' }),
    PurchaseRequisition.countDocuments({ ...base, status: 'APPROVED' }),
    PurchaseOrder.countDocuments({ ...base, status: 'DRAFT' }),
    PurchaseOrder.countDocuments({ ...base, status: { $in: PO_OPEN_STATUSES } }),
    GoodsReceipt.countDocuments({ ...base, status: 'PENDING_QC' }),
    GoodsReceipt.countDocuments({ ...base, status: 'DRAFT' }),
    Rfq.countDocuments({ ...base, status: { $in: ['DRAFT', 'SENT'] } }),
  ]);

  const openPos = await PurchaseOrder.find({ ...base, status: { $in: PO_OPEN_STATUSES } }).select('totalAmount');
  const openPoValue = openPos.reduce((sum, po) => sum + (po.totalAmount || 0), 0);

  return {
    suppliers,
    prDraft,
    prSubmitted,
    prApproved,
    poDraft,
    poOpen,
    grnPendingQc,
    grnDraft,
    rfqOpen,
    openPoValue: Math.round(openPoValue),
  };
}

export async function createSupplier(data, userId) {
  const existing = await Supplier.findOne(applySoftDeleteFilter({
    factoryId: data.factoryId,
    supplierCode: data.supplierCode?.trim(),
  }));
  if (existing) throw new ConflictError(`Supplier code already exists: ${data.supplierCode}`);
  return Supplier.create({ ...data, createdBy: userId, updatedBy: userId });
}

export async function updateSupplier(id, factoryId, data, userId) {
  const supplier = await Supplier.findOne(applySoftDeleteFilter({ _id: id, factoryId }));
  if (!supplier) throw new NotFoundError('Supplier not found');
  if (data.name?.trim()) supplier.name = data.name.trim();
  if (data.contactEmail != null) supplier.contactEmail = data.contactEmail;
  if (data.phone != null) supplier.phone = data.phone;
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
    filter.$or = [{ supplierCode: re }, { name: re }, { contactEmail: re }];
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

  const lines = shortageLines.map((l) => ({
    materialId: l.materialId,
    requiredQty: l.shortageQty,
    unit: l.unit,
    estimatedUnitCost: l.unitCost || 0,
  }));

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
  pr.status = 'SUBMITTED';
  pr.rejectionComments = undefined;
  pr.updatedBy = userId;
  await pr.save();
  await submitForApproval({
    organizationId: pr.organizationId,
    factoryId: pr.factoryId,
    documentType: 'PURCHASE_REQUISITION',
    documentId: pr._id,
    submittedBy: userId,
  });
  if (pr.requestedBy) {
    await notify({
      organizationId: pr.organizationId,
      factoryId: pr.factoryId,
      userId: pr.requestedBy,
      eventType: 'pr.submitted',
      title: 'PR submitted',
      message: `${pr.prNumber} submitted for approval (Purchase Manager → Admin)`,
      referenceType: 'PURCHASE_REQUISITION',
      referenceId: pr._id,
    });
  }
  return populatePr(pr);
}

/**
 * Advance PR approval. When a pending ApprovalInstance exists, routes through the
 * multi-level engine (L1 Purchase Manager → L2 Factory Admin). Final APPROVED
 * is applied by the approval bridge; mid-level leaves PR as SUBMITTED.
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
      message: `${pr.prNumber} approved — Purchase Manager can create PO / RFQ`,
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

export async function createPurchaseOrder({ factoryId, organizationId, supplierId, prId, lines }, userId) {
  const supplier = await Supplier.findOne(applySoftDeleteFilter({ _id: supplierId, factoryId }));
  if (!supplier) throw new NotFoundError('Supplier not found');

  const factory = await Factory.findById(factoryId);
  const poNumber = await nextDocumentNumber(factoryId, 'PO', `PO-${factory.code}-`);

  let orderLines = lines;
  if (prId && !lines?.length) {
    const pr = await loadPr(prId, factoryId);
    if (pr.status !== 'APPROVED') throw new ConflictError('PR must be APPROVED');
    orderLines = [];
    for (const line of pr.lines) {
      const mat = await Material.findById(line.materialId);
      orderLines.push({
        materialId: line.materialId,
        orderedQty: line.requiredQty,
        unit: line.unit || mat?.unit,
        unitPrice: line.estimatedUnitCost || mat?.unitCost || 0,
      });
    }
    pr.status = 'CONVERTED';
    pr.updatedBy = userId;
    await pr.save();
  }

  if (!orderLines?.length) throw new ValidationError('PO lines are required');
  await assertMaterials(orderLines.map((l) => ({
    materialId: l.materialId,
    requiredQty: l.orderedQty ?? l.quantity,
    unit: l.unit,
    estimatedUnitCost: l.unitPrice,
  })), factoryId);

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
    status: 'DRAFT',
    createdBy: userId,
    updatedBy: userId,
  });
  return populatePo(po);
}

export async function listPurchaseOrders(factoryId, { page, limit, skip, status, excludeStatus, search, supplierId }) {
  const filter = applySoftDeleteFilter({ factoryId });
  if (status) {
    const statuses = String(status).split(',').map((s) => s.trim()).filter(Boolean);
    filter.status = statuses.length > 1 ? { $in: statuses } : statuses[0];
  } else if (excludeStatus) {
    const excluded = String(excludeStatus).split(',').map((s) => s.trim()).filter(Boolean);
    filter.status = { $nin: excluded };
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
  if (po.status !== 'DRAFT') throw new ConflictError('Only DRAFT PO can be approved');
  if (!po.lines?.length) throw new ValidationError('PO has no lines');
  po.status = 'APPROVED';
  po.approvedBy = userId;
  po.approvedAt = new Date();
  po.updatedBy = userId;
  await po.save();
  return populatePo(po);
}

export async function sendPurchaseOrder(id, factoryId, userId) {
  const po = await loadPo(id, factoryId);
  if (po.status !== 'APPROVED') throw new ConflictError('PO must be APPROVED to send');
  po.status = 'SENT';
  po.updatedBy = userId;
  await po.save();
  return populatePo(po);
}

export async function createGoodsReceipt({ factoryId, organizationId, poId, lines }, userId) {
  const po = await loadPo(poId, factoryId);
  if (!PO_OPEN_STATUSES.includes(po.status)) {
    throw new ConflictError('PO not open for receipt');
  }
  if (!lines?.length) throw new ValidationError('GRN lines are required');

  const factory = await Factory.findById(factoryId);
  const grnNumber = await nextDocumentNumber(factoryId, 'GRN', `GRN-${factory.code}-`);

  const grnLines = [];
  for (const line of lines) {
    const poLine = po.lines.find((l) => l.materialId.toString() === line.materialId.toString());
    if (!poLine) throw new ConflictError(`Material ${line.materialId} not on PO`);
    const remaining = poLine.orderedQty - (poLine.receivedQty || 0);
    if (line.receivedQty <= 0) throw new ValidationError('Received quantity must be greater than zero');
    if (line.receivedQty > remaining) {
      throw new ConflictError(`GRN qty exceeds PO remaining for material ${line.materialId}`);
    }
    const mat = await Material.findById(line.materialId);
    grnLines.push({
      materialId: line.materialId,
      receivedQty: line.receivedQty,
      unit: line.unit || mat?.unit || poLine.unit,
    });
    poLine.receivedQty = (poLine.receivedQty || 0) + line.receivedQty;
  }

  const allReceived = po.lines.every((l) => (l.receivedQty || 0) >= l.orderedQty);
  po.status = allReceived ? 'RECEIVED' : 'PARTIAL';
  po.updatedBy = userId;
  await po.save();

  const grn = await GoodsReceipt.create({
    organizationId,
    factoryId,
    grnNumber,
    poId,
    lines: grnLines,
    status: 'DRAFT',
    receivedBy: userId,
    createdBy: userId,
    updatedBy: userId,
  });
  return populateGrn(grn);
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

export async function submitGrnForQc(id, factoryId, userId) {
  const grn = await loadGrn(id, factoryId);
  if (grn.status !== 'DRAFT') throw new ConflictError('GRN already submitted');
  grn.status = 'PENDING_QC';
  grn.updatedBy = userId;
  await grn.save();
  await createIncomingInspection(grn._id, userId);
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
