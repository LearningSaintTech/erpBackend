import { ApprovalWorkflow } from './approvalWorkflow.model.js';
import { ApprovalInstance } from './approvalInstance.model.js';
import { Design } from '../design/design.model.js';
import { Sample } from '../sampling/sample.model.js';
import { ProductionOrder } from '../production/productionOrder.model.js';
import { PurchaseRequisition } from '../purchase/purchaseRequisition.model.js';
import { PurchaseOrder } from '../purchase/purchaseOrder.model.js';
import { Bom } from '../bom/bom.model.js';
import { InventoryCode } from '../inventoryCode/inventoryCode.model.js';
import { NotFoundError, ConflictError, ForbiddenError, ValidationError } from '../../shared/errors/AppError.js';
import { applyApprovalResult } from '../../shared/services/approvalBridge.js';
import { APPROVAL_DOCUMENT_TYPES, defaultApproverPermission } from './approval.defaults.js';
import { notify } from '../notification/notification.service.js';
import { findUserIdsWithFactoryPermission } from '../user/user.service.js';

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function getInstanceForFactory(instanceId, factoryId) {
  const filter = { _id: instanceId };
  if (factoryId) filter.factoryId = factoryId;
  const instance = await ApprovalInstance.findOne(filter);
  if (!instance) throw new NotFoundError('Approval instance not found');
  return instance;
}

function hasPermission(permissions, required) {
  if (!required?.length) return true;
  if (permissions?.includes('*')) return true;
  return required.some((p) => permissions?.includes(p));
}

function assertCanAct(instance, approverId, permissions, workflow) {
  // Block self-approval at level 1 only. After an independent L1, the original
  // submitter may act at later levels if they hold that level's permission
  // (e.g. Factory Admin L2 on a PR they raised for testing / urgency).
  if (String(instance.submittedBy) === String(approverId) && (instance.currentLevel ?? 1) <= 1) {
    throw new ForbiddenError('Submitter cannot approve their own request at the first level');
  }
  // Segregation of duties in multi-level chains: whoever approved an earlier level cannot also
  // decide a later one (otherwise one Factory Admin holding both permissions clears every level).
  if (!permissions?.includes('*')) {
    const earlier = (instance.steps || []).find((s) => s.action === 'APPROVED'
      && String(s.approverId?._id || s.approverId) === String(approverId)
      && s.level < (instance.currentLevel ?? 1));
    if (earlier) {
      throw new ForbiddenError(
        `You approved level ${earlier.level} of this request — a different approver must decide level ${instance.currentLevel}`,
      );
    }
  }
  // Pure design authors must not act on DESIGN approvals (even via stray delegation)
  if (instance.documentType === 'DESIGN' && !permissions?.includes('*')) {
    const isAuthor = permissions?.includes('design.create') || permissions?.includes('design.update');
    const elevated = permissions?.includes('design.delete')
      || permissions?.includes('user.read')
      || permissions?.includes('user.update')
      || permissions?.includes('approval.approve')
      || permissions?.includes('approval.configure')
      || permissions?.includes('role.configure');
    if (isAuthor && !elevated) {
      throw new ForbiddenError('Design authors cannot approve designs');
    }
  }
  const levels = workflow?.levels?.slice().sort((a, b) => a.level - b.level) || [];
  const levelConfig = levels.find((l) => l.level === instance.currentLevel);
  // Use only this level's roles so multi-level workflows (e.g. purchase.approve → approval.approve) are enforceable
  const required = levelConfig?.approverRoles?.length
    ? levelConfig.approverRoles
    : [defaultApproverPermission(instance.documentType)];

  if (hasPermission(permissions, required)) return;
  // General approval authority (approval.approve) fills in only where the workflow level
  // names no roles, and still needs the document's domain approve permission — otherwise a
  // Quality sub-admin could approve designs the design module itself would deny them.
  if (
    instance.documentType !== 'PURCHASE_REQUISITION'
    && !levelConfig?.approverRoles?.length
    && hasPermission(permissions, ['approval.approve'])
    && hasPermission(permissions, [defaultApproverPermission(instance.documentType)])
  ) return;

  throw new ForbiddenError('You are not authorized to act at the current approval level');
}

async function loadWorkflow(instance) {
  if (!instance.workflowId) return null;
  return ApprovalWorkflow.findById(instance.workflowId);
}

function maxWorkflowLevel(workflow) {
  const levels = workflow?.levels || [];
  if (!levels.length) return 1;
  return Math.max(...levels.map((l) => l.level));
}

/**
 * Per document type: model + the fields the summary needs. Used to batch-load documents for a
 * page of approval rows (one query per type instead of one per row — perf audit).
 */
const SUMMARY_LOADERS = {
  DESIGN: { model: () => Design, select: 'title styleNumber status category revisionComments rejectionComments colorVariants sizeChartData targetPrice' },
  SAMPLE: { model: () => Sample, select: 'sampleCode status sampleType designId', populate: ['designId', 'designCode title'] },
  SAMPLE_MATERIAL: {
    model: () => Sample,
    select: 'sampleCode status sampleType designId materialRequirements',
    populate: ['designId materialRequirements.materialId', 'designCode title materialCode name unit'],
  },
  PRODUCTION_ORDER: {
    model: () => ProductionOrder,
    select: 'orderNumber status priority plannedQuantity deliveryDate skuId',
    populate: ['skuId', 'skuCode name'],
  },
  PURCHASE_REQUISITION: {
    model: () => PurchaseRequisition,
    select: 'prNumber status sourceType lines',
    populate: ['lines.materialId', 'materialCode name'],
  },
  PURCHASE_ORDER: { model: () => PurchaseOrder, select: 'poNumber status totalAmount' },
  BOM: { model: () => Bom, select: 'bomCode status version skuId totalCostPerPiece lines', populate: ['skuId', 'skuCode name'] },
};

function loadSummaryDocs(documentType, ids) {
  const l = SUMMARY_LOADERS[documentType];
  if (!l) return null;
  const q = l.model().find({ _id: ids.length === 1 ? ids[0] : { $in: ids } }).select(l.select);
  return l.populate ? q.populate(...l.populate) : q;
}

/** `preloaded`: the document already fetched by enrichInstances (null = not found). */
async function resolveDocumentSummary(documentType, documentId, preloaded) {
  const id = documentId;
  const load = async () => {
    if (preloaded !== undefined) return preloaded;
    const q = loadSummaryDocs(documentType, [id]);
    return q ? (await q)[0] || null : null;
  };
  switch (documentType) {
    case 'DESIGN': {
      const doc = await load();
      if (!doc) return null;
      // Category is a catalogue code (e.g. "TW-SH") — show its name ("Shirt").
      const cat = doc.category
        ? await InventoryCode.findOne({ type: 'CATEGORY', code: doc.category }).select('name').lean()
        : null;
      const { listThumbnailUrls } = await import('../design/design.service.js');
      const thumbs = await listThumbnailUrls([doc._id]);
      return {
        code: doc.styleNumber || String(id).slice(-8),
        title: doc.title,
        status: doc.status,
        subtitle: cat?.name || (doc.category ? doc.category.charAt(0) + doc.category.slice(1).toLowerCase().replace(/_/g, ' ') : undefined),
        // Enough for the reviewer to decide from the approval drawer.
        preview: {
          imageUrl: thumbs.get(String(doc._id)),
          colors: (doc.colorVariants || []).map((c) => ({ name: c.name || c.code, hexCode: c.hexCode })).filter((c) => c.name),
          sizes: doc.sizeChartData?.sizeLabels || [],
          targetPrice: doc.targetPrice,
        },
        revisionComments: doc.revisionComments || undefined,
        rejectionComments: doc.rejectionComments || undefined,
        route: `/designs/${id}/edit`,
      };
    }
    case 'SAMPLE':
    case 'SAMPLE_MATERIAL': {
      const doc = await load();
      if (!doc) return null;
      // "Fit sample" for "Printed Resort Shirt", plus the fabric & trims being approved.
      const st = doc.sampleType || '';
      const type = !st ? 'Sample' : st.length <= 3 ? st : st.charAt(0) + st.slice(1).toLowerCase().replace(/_/g, ' ');
      const design = doc.designId && typeof doc.designId === 'object' ? doc.designId : null;
      const lines = documentType === 'SAMPLE_MATERIAL'
        ? (doc.materialRequirements || []).map((l) => {
          const m = l.materialId && typeof l.materialId === 'object' ? l.materialId : null;
          return `${m?.name || m?.materialCode || 'Material'} ${l.requiredQty ?? ''} ${(l.unit || m?.unit || '').toLowerCase()}`.trim();
        })
        : [];
      return {
        code: doc.sampleCode,
        title: `${type} sample${design?.title ? ` · ${design.title}` : ''}`,
        subtitle: lines.length ? lines.join(', ') : undefined,
        status: doc.status,
        route: `/samples?sampleId=${id}`,
      };
    }
    case 'PRODUCTION_ORDER': {
      const doc = await load();
      if (!doc) return null;
      const sku = doc.skuId?.skuCode || doc.skuId?.name;
      const due = doc.deliveryDate ? new Date(doc.deliveryDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : null;
      return {
        code: doc.orderNumber,
        // e.g. "100 pcs of STY-0001…-M" — what the approver is committing the factory to.
        title: sku ? `${doc.plannedQuantity ?? ''} pcs of ${sku}`.trim() : 'Production order',
        status: doc.status,
        subtitle: [doc.priority && `${doc.priority.charAt(0)}${doc.priority.slice(1).toLowerCase()} priority`, due && `due ${due}`]
          .filter(Boolean).join(' · ') || undefined,
        route: '/production/orders',
      };
    }
    case 'PURCHASE_REQUISITION': {
      const doc = await load();
      if (!doc) return null;
      const lines = doc.lines || [];
      const first = lines[0];
      const firstLabel = first
        ? `${first.materialId?.name || first.materialId?.materialCode || 'Material'} · ${first.requiredQty ?? ''} ${String(first.unit || '').toLowerCase()}`.trim()
        : 'Purchase requisition';
      const estimate = lines.reduce((sum, l) => sum + (Number(l.requiredQty) || 0) * (Number(l.estimatedUnitCost) || 0), 0);
      return {
        code: doc.prNumber,
        title: lines.length > 1 ? `${firstLabel} +${lines.length - 1} more` : firstLabel,
        status: doc.status,
        subtitle: estimate > 0 ? `≈ ₹${Math.round(estimate).toLocaleString('en-IN')}` : undefined,
        route: '/purchase',
      };
    }
    case 'PURCHASE_ORDER': {
      const doc = await load();
      if (!doc) return null;
      return {
        code: doc.poNumber,
        title: 'Purchase order',
        status: doc.status,
        subtitle: doc.totalAmount != null ? `₹${doc.totalAmount}` : undefined,
        route: '/purchase',
      };
    }
    case 'BOM': {
      const doc = await load();
      if (!doc) return null;
      // What is being approved: the product, the version and the standard cost it freezes.
      const sku = doc.skuId && typeof doc.skuId === 'object' ? doc.skuId : null;
      const cost = Number(doc.totalCostPerPiece) || 0;
      return {
        code: doc.bomCode,
        title: `${sku?.name || sku?.skuCode || 'BOM'} · v${doc.version}`,
        subtitle: [
          `${(doc.lines || []).length} material${(doc.lines || []).length === 1 ? '' : 's'}`,
          cost > 0 ? `₹${cost.toLocaleString('en-IN', { maximumFractionDigits: 2 })} per piece` : null,
        ].filter(Boolean).join(' · '),
        status: doc.status,
        route: '/products/boms',
      };
    }
    default:
      return null;
  }
}

async function enrichInstances(instances) {
  const rows = instances.map((i) => (i.toObject ? i.toObject() : i));
  // Batch-load the referenced documents: one query per document type, not one per row.
  const idsByType = new Map();
  for (const row of rows) {
    if (!SUMMARY_LOADERS[row.documentType] || !row.documentId) continue;
    if (!idsByType.has(row.documentType)) idsByType.set(row.documentType, []);
    idsByType.get(row.documentType).push(row.documentId);
  }
  const docsById = new Map();
  await Promise.all([...idsByType].map(async ([type, ids]) => {
    const docs = await loadSummaryDocs(type, ids);
    for (const d of docs) docsById.set(`${type}:${d._id}`, d);
  }));
  await Promise.all(rows.map(async (row) => {
    const preloaded = SUMMARY_LOADERS[row.documentType]
      ? docsById.get(`${row.documentType}:${row.documentId}`) || null
      : undefined;
    row.documentSummary = await resolveDocumentSummary(row.documentType, row.documentId, preloaded);
  }));
  return rows;
}


/**
 * Document types whose own module does not notify approvers / submitters — the engine
 * does it for them (DESIGN, SAMPLE* and BOM modules send their own domain notifications).
 */
const ENGINE_NOTIFIED_TYPES = new Set(['PURCHASE_REQUISITION', 'PRODUCTION_ORDER']);

const DOCUMENT_LABELS = {
  PURCHASE_REQUISITION: 'Purchase requisition',
  PRODUCTION_ORDER: 'Production order',
};

async function notifyApproversOfPending(instance, workflow) {
  if (!ENGINE_NOTIFIED_TYPES.has(instance.documentType)) return;
  try {
    const level = workflow?.levels?.find((l) => l.level === instance.currentLevel);
    const roles = level?.approverRoles?.length
      ? level.approverRoles
      : [defaultApproverPermission(instance.documentType)];
    const ids = await findUserIdsWithFactoryPermission(instance.factoryId, roles, {
      excludeUserId: instance.submittedBy,
    });
    const label = DOCUMENT_LABELS[instance.documentType] || instance.documentType;
    await Promise.all(ids.map((userId) => notify({
      organizationId: instance.organizationId,
      factoryId: instance.factoryId,
      userId,
      eventType: 'approval.pending',
      title: `${label} awaiting approval`,
      message: `A ${label.toLowerCase()} is waiting for your approval (level ${instance.currentLevel}).`,
      referenceType: 'APPROVAL',
      referenceId: instance._id,
    })));
  } catch (err) {
    console.warn('[APPROVAL] pending notification failed:', err.message);
  }
}

const OUTCOME_EVENTS = {
  APPROVED: ['approval.approved', 'approved'],
  REJECTED: ['approval.rejected', 'rejected'],
  CHANGES_REQUESTED: ['approval.changes_requested', 'sent back for changes'],
};

export async function notifySubmitterOfOutcome(instance) {
  if (!instance || !ENGINE_NOTIFIED_TYPES.has(instance.documentType)) return;
  // The purchase module already sends pr.approved / pr.rejected / changes notices to the requester.
  if (instance.documentType === 'PURCHASE_REQUISITION') return;
  const outcome = OUTCOME_EVENTS[instance.status];
  if (!outcome) return;
  try {
    const label = DOCUMENT_LABELS[instance.documentType] || instance.documentType;
    const comments = instance.steps?.at(-1)?.comments;
    await notify({
      organizationId: instance.organizationId,
      factoryId: instance.factoryId,
      userId: instance.submittedBy,
      eventType: outcome[0],
      title: `${label} ${outcome[1]}`,
      message: comments ? `${label} ${outcome[1]}: ${comments}` : `Your ${label.toLowerCase()} was ${outcome[1]}.`,
      referenceType: instance.documentType,
      referenceId: instance.documentId,
    });
  } catch (err) {
    console.warn('[APPROVAL] outcome notification failed:', err.message);
  }
}

export async function submitForApproval({
  organizationId, factoryId, documentType, documentId, submittedBy, workflowId,
}) {
  if (!APPROVAL_DOCUMENT_TYPES.includes(documentType)) {
    throw new ValidationError(`Unsupported document type: ${documentType}`);
  }

  const existing = await ApprovalInstance.findOne({ documentType, documentId, status: 'PENDING' });
  if (existing) throw new ConflictError('Approval already pending');

  const workflow = workflowId
    ? await ApprovalWorkflow.findById(workflowId)
    : await ApprovalWorkflow.findOne({ organizationId, factoryId, documentType, isActive: true });

  const instance = await ApprovalInstance.create({
    organizationId,
    factoryId,
    workflowId: workflow?._id,
    documentType,
    documentId,
    submittedBy,
    status: 'PENDING',
    currentLevel: 1,
    steps: [],
  });
  await notifyApproversOfPending(instance, workflow);
  return instance;
}

const DOCUMENT_MODELS = {
  DESIGN: Design,
  SAMPLE: Sample,
  SAMPLE_MATERIAL: Sample,
  PRODUCTION_ORDER: ProductionOrder,
  PURCHASE_REQUISITION: PurchaseRequisition,
  PURCHASE_ORDER: PurchaseOrder,
  BOM: Bom,
};

/** API entry point: the document and workflow must belong to the caller's factory. */
export async function submitDocumentForApproval({
  organizationId, factoryId, documentType, documentId, submittedBy, workflowId,
}) {
  const Model = DOCUMENT_MODELS[documentType];
  if (!Model) throw new ValidationError(`Unsupported document type: ${documentType}`);
  const doc = await Model.exists({ _id: documentId, factoryId, isDeleted: { $ne: true } });
  if (!doc) throw new NotFoundError('Document not found in this factory');
  if (workflowId) {
    const wf = await ApprovalWorkflow.exists({ _id: workflowId, factoryId, documentType });
    if (!wf) throw new NotFoundError('Workflow not found in this factory');
  }
  return submitForApproval({ organizationId, factoryId, documentType, documentId, submittedBy, workflowId });
}

/**
 * Atomically move a PENDING instance to its final state so two concurrent actions cannot both
 * succeed, then apply the document change; if that fails, put the instance back to PENDING.
 */
async function finalizeInstance(instance, step, finalStatus, approverId) {
  const completedAt = new Date();
  const claimed = await ApprovalInstance.findOneAndUpdate(
    { _id: instance._id, status: 'PENDING', currentLevel: instance.currentLevel },
    { $set: { status: finalStatus, completedAt }, $push: { steps: step } },
    { new: true },
  );
  if (!claimed) throw new ConflictError('Approval was already actioned');
  try {
    await applyApprovalResult(claimed, approverId);
  } catch (err) {
    await ApprovalInstance.updateOne(
      { _id: claimed._id, status: finalStatus },
      { $set: { status: 'PENDING', completedAt: null }, $pull: { steps: { _id: claimed.steps[claimed.steps.length - 1]?._id } } },
    );
    throw err;
  }
  await notifySubmitterOfOutcome(claimed);
  return claimed;
}

export async function approveInstance(instanceId, approverId, comments, { factoryId, permissions } = {}) {
  const instance = await getInstanceForFactory(instanceId, factoryId);
  if (instance.status !== 'PENDING') throw new ConflictError('Approval not pending');

  const workflow = await loadWorkflow(instance);
  assertCanAct(instance, approverId, permissions, workflow);

  const step = {
    level: instance.currentLevel,
    approverId,
    action: 'APPROVED',
    comments: comments || '',
    actionAt: new Date(),
  };

  const maxLevel = maxWorkflowLevel(workflow);
  if (workflow?.levels?.length && instance.currentLevel < maxLevel) {
    const advanced = await ApprovalInstance.findOneAndUpdate(
      { _id: instance._id, status: 'PENDING', currentLevel: instance.currentLevel },
      { $inc: { currentLevel: 1 }, $push: { steps: step } },
      { new: true },
    );
    if (!advanced) throw new ConflictError('Approval was already actioned');
    await notifyApproversOfPending(advanced, workflow);
    return advanced;
  }

  return finalizeInstance(instance, step, 'APPROVED', approverId);
}

export async function rejectInstance(instanceId, approverId, comments, { factoryId, permissions } = {}) {
  if (!comments?.trim()) throw new ValidationError('Comments are required when rejecting');
  const instance = await getInstanceForFactory(instanceId, factoryId);
  if (instance.status !== 'PENDING') throw new ConflictError('Approval not pending');

  const workflow = await loadWorkflow(instance);
  assertCanAct(instance, approverId, permissions, workflow);

  return finalizeInstance(instance, {
    level: instance.currentLevel,
    approverId,
    action: 'REJECTED',
    comments: comments.trim(),
    actionAt: new Date(),
  }, 'REJECTED', approverId);
}

export async function requestChangesInstance(instanceId, approverId, comments, { factoryId, permissions } = {}) {
  if (!comments?.trim()) throw new ValidationError('Comments are required when requesting changes');
  const instance = await getInstanceForFactory(instanceId, factoryId);
  if (instance.status !== 'PENDING') throw new ConflictError('Approval not pending');

  const workflow = await loadWorkflow(instance);
  assertCanAct(instance, approverId, permissions, workflow);

  return finalizeInstance(instance, {
    level: instance.currentLevel,
    approverId,
    action: 'CHANGES_REQUESTED',
    comments: comments.trim(),
    actionAt: new Date(),
  }, 'CHANGES_REQUESTED', approverId);
}

export async function listApprovals(factoryId, {
  status = 'PENDING',
  documentType,
  search,
  submittedBy,
  skip = 0,
  limit = 20,
} = {}) {
  const filter = { factoryId };
  if (status && status !== 'ALL') filter.status = status;
  if (documentType) filter.documentType = documentType;
  if (submittedBy) filter.submittedBy = submittedBy;

  if (search?.trim()) {
    const re = new RegExp(escapeRegex(search.trim()), 'i');
    const or = [{ documentType: re }];
    const matchingTypes = APPROVAL_DOCUMENT_TYPES.filter((t) => re.test(t));
    if (matchingTypes.length) or.push({ documentType: { $in: matchingTypes } });
    filter.$or = or;
  }

  const [items, total] = await Promise.all([
    ApprovalInstance.find(filter)
      .populate('submittedBy', 'firstName lastName email')
      .populate('workflowId', 'name levels')
      .sort({ submittedAt: -1 })
      .skip(skip)
      .limit(limit),
    ApprovalInstance.countDocuments(filter),
  ]);

  const enriched = await enrichInstances(items);
  return { items: enriched, total };
}

export async function listPendingApprovals(factoryId, options = {}) {
  return listApprovals(factoryId, { ...options, status: 'PENDING' });
}

export async function getApprovalInstance(instanceId, factoryId) {
  const instance = await ApprovalInstance.findOne({ _id: instanceId, factoryId })
    .populate('submittedBy', 'firstName lastName email')
    .populate('workflowId', 'name levels documentType')
    .populate('steps.approverId', 'firstName lastName email');
  if (!instance) throw new NotFoundError('Approval instance not found');
  const [enriched] = await enrichInstances([instance]);
  return enriched;
}

export async function getApprovalStats(factoryId, userId) {
  const [pending, overdue, submittedByMe, completedToday] = await Promise.all([
    ApprovalInstance.countDocuments({ factoryId, status: 'PENDING' }),
    ApprovalInstance.countDocuments({
      factoryId,
      status: 'PENDING',
      submittedAt: { $lt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    }),
    ApprovalInstance.countDocuments({ factoryId, submittedBy: userId, status: 'PENDING' }),
    ApprovalInstance.countDocuments({
      factoryId,
      status: { $in: ['APPROVED', 'REJECTED', 'CHANGES_REQUESTED'] },
      completedAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) },
    }),
  ]);
  return { pending, overdue, submittedByMe, completedToday };
}

export async function createWorkflow(data) {
  if (!APPROVAL_DOCUMENT_TYPES.includes(data.documentType)) {
    throw new ValidationError(`Unsupported document type: ${data.documentType}`);
  }
  if (!data.levels?.length) throw new ValidationError('At least one approval level is required');

  await ApprovalWorkflow.updateMany(
    { organizationId: data.organizationId, factoryId: data.factoryId, documentType: data.documentType, isActive: true },
    { isActive: false },
  );

  return ApprovalWorkflow.create({
    ...data,
    isActive: data.isActive !== false,
    levels: data.levels.map((l, idx) => ({
      level: l.level ?? idx + 1,
      approverRoles: l.approverRoles || [],
      approvalType: l.approvalType || 'ANY',
      slaHours: l.slaHours ?? 24,
      escalationRole: l.escalationRole || '',
    })),
  });
}

export async function listWorkflows(organizationId, factoryId, { includeInactive = false } = {}) {
  const filter = { organizationId, factoryId };
  if (!includeInactive) filter.isActive = true;
  return ApprovalWorkflow.find(filter).sort({ documentType: 1, name: 1 });
}

export async function deactivateWorkflow(workflowId, organizationId, factoryId) {
  const workflow = await ApprovalWorkflow.findOne({ _id: workflowId, organizationId, factoryId });
  if (!workflow) throw new NotFoundError('Workflow not found');
  workflow.isActive = false;
  await workflow.save();
  return workflow;
}
