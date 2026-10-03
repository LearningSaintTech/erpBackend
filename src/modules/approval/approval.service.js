import { ApprovalWorkflow } from './approvalWorkflow.model.js';
import { ApprovalInstance } from './approvalInstance.model.js';
import { Design } from '../design/design.model.js';
import { Sample } from '../sampling/sample.model.js';
import { ProductionOrder } from '../production/productionOrder.model.js';
import { PurchaseRequisition } from '../purchase/purchaseRequisition.model.js';
import { PurchaseOrder } from '../purchase/purchaseOrder.model.js';
import { Bom } from '../bom/bom.model.js';
import { NotFoundError, ConflictError, ForbiddenError, ValidationError } from '../../shared/errors/AppError.js';
import { applyApprovalResult } from '../../shared/services/approvalBridge.js';
import { APPROVAL_DOCUMENT_TYPES, defaultApproverPermission } from './approval.defaults.js';

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
  // Factory admin / delegated general approvers may act at any level, except PR:
  // only Super Admin or Factory Admin (purchase.authorize) may approve requisitions.
  if (instance.documentType !== 'PURCHASE_REQUISITION' && hasPermission(permissions, ['approval.approve'])) return;

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

async function resolveDocumentSummary(documentType, documentId) {
  const id = documentId;
  switch (documentType) {
    case 'DESIGN': {
      const doc = await Design.findById(id).select('title styleNumber status category revisionComments rejectionComments');
      if (!doc) return null;
      return {
        code: doc.styleNumber || String(id).slice(-8),
        title: doc.title,
        status: doc.status,
        subtitle: doc.category,
        revisionComments: doc.revisionComments || undefined,
        rejectionComments: doc.rejectionComments || undefined,
        route: `/designs/${id}/edit`,
      };
    }
    case 'SAMPLE':
    case 'SAMPLE_MATERIAL': {
      const doc = await Sample.findById(id).select('sampleCode status sampleType designId');
      if (!doc) return null;
      return {
        code: doc.sampleCode,
        title: doc.sampleType?.replace(/_/g, ' '),
        status: doc.status,
        route: `/samples?sampleId=${id}`,
      };
    }
    case 'PRODUCTION_ORDER': {
      const doc = await ProductionOrder.findById(id).select('orderNumber status priority');
      if (!doc) return null;
      return {
        code: doc.orderNumber,
        title: 'Production order',
        status: doc.status,
        subtitle: doc.priority,
        route: '/production/orders',
      };
    }
    case 'PURCHASE_REQUISITION': {
      const doc = await PurchaseRequisition.findById(id).select('prNumber status sourceType');
      if (!doc) return null;
      return {
        code: doc.prNumber,
        title: doc.sourceType?.replace(/_/g, ' ') || 'Purchase requisition',
        status: doc.status,
        route: '/purchase',
      };
    }
    case 'PURCHASE_ORDER': {
      const doc = await PurchaseOrder.findById(id).select('poNumber status totalAmount');
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
      const doc = await Bom.findById(id).select('bomCode status version');
      if (!doc) return null;
      return {
        code: doc.bomCode,
        title: `BOM v${doc.version}`,
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
  await Promise.all(rows.map(async (row) => {
    row.documentSummary = await resolveDocumentSummary(row.documentType, row.documentId);
  }));
  return rows;
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

  return ApprovalInstance.create({
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
}

export async function approveInstance(instanceId, approverId, comments, { factoryId, permissions } = {}) {
  const instance = await getInstanceForFactory(instanceId, factoryId);
  if (instance.status !== 'PENDING') throw new ConflictError('Approval not pending');

  const workflow = await loadWorkflow(instance);
  assertCanAct(instance, approverId, permissions, workflow);

  instance.steps.push({
    level: instance.currentLevel,
    approverId,
    action: 'APPROVED',
    comments: comments || '',
    actionAt: new Date(),
  });

  const maxLevel = maxWorkflowLevel(workflow);
  if (workflow?.levels?.length && instance.currentLevel < maxLevel) {
    instance.currentLevel += 1;
    await instance.save();
    return instance;
  }

  instance.status = 'APPROVED';
  instance.completedAt = new Date();
  await instance.save();
  await applyApprovalResult(instance, approverId);
  return instance;
}

export async function rejectInstance(instanceId, approverId, comments, { factoryId, permissions } = {}) {
  if (!comments?.trim()) throw new ValidationError('Comments are required when rejecting');
  const instance = await getInstanceForFactory(instanceId, factoryId);
  if (instance.status !== 'PENDING') throw new ConflictError('Approval not pending');

  const workflow = await loadWorkflow(instance);
  assertCanAct(instance, approverId, permissions, workflow);

  instance.steps.push({
    level: instance.currentLevel,
    approverId,
    action: 'REJECTED',
    comments: comments.trim(),
    actionAt: new Date(),
  });
  instance.status = 'REJECTED';
  instance.completedAt = new Date();
  await instance.save();
  await applyApprovalResult(instance, approverId);
  return instance;
}

export async function requestChangesInstance(instanceId, approverId, comments, { factoryId, permissions } = {}) {
  if (!comments?.trim()) throw new ValidationError('Comments are required when requesting changes');
  const instance = await getInstanceForFactory(instanceId, factoryId);
  if (instance.status !== 'PENDING') throw new ConflictError('Approval not pending');

  const workflow = await loadWorkflow(instance);
  assertCanAct(instance, approverId, permissions, workflow);

  instance.steps.push({
    level: instance.currentLevel,
    approverId,
    action: 'CHANGES_REQUESTED',
    comments: comments.trim(),
    actionAt: new Date(),
  });
  instance.status = 'CHANGES_REQUESTED';
  instance.completedAt = new Date();
  await instance.save();
  await applyApprovalResult(instance, approverId);
  return instance;
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
