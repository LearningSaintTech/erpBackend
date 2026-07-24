import Joi from 'joi';
import * as approvalService from './approval.service.js';
import { success, paginate, buildMeta } from '../../shared/utils/response.js';
import { getUserPermissions } from '../user/user.service.js';
import {
  APPROVAL_DOCUMENT_TYPES, APPROVER_PERMISSION_OPTIONS, APPROVAL_STATUS_LIST,
} from './approval.defaults.js';

const levelSchema = Joi.object({
  level: Joi.number().integer().min(1),
  approverRoles: Joi.array().items(Joi.string()).min(1).required(),
  approvalType: Joi.string().valid('ANY', 'ALL'),
  slaHours: Joi.number().integer().min(1).max(720),
  escalationRole: Joi.string().allow(''),
});

export const submitSchema = Joi.object({
  body: Joi.object({
    documentType: Joi.string().valid(...APPROVAL_DOCUMENT_TYPES).required(),
    documentId: Joi.string().required(),
    organizationId: Joi.string().required(),
    factoryId: Joi.string().required(),
    workflowId: Joi.string(),
  }),
});

export const approveSchema = Joi.object({
  body: Joi.object({
    comments: Joi.string().allow(''),
  }),
});

export const rejectSchema = Joi.object({
  body: Joi.object({
    comments: Joi.string().trim().min(3).required(),
  }),
});

export const requestChangesSchema = Joi.object({
  body: Joi.object({
    comments: Joi.string().trim().min(3).required(),
  }),
});

export const workflowSchema = Joi.object({
  body: Joi.object({
    organizationId: Joi.string().required(),
    factoryId: Joi.string().required(),
    documentType: Joi.string().valid(...APPROVAL_DOCUMENT_TYPES).required(),
    name: Joi.string().trim().min(2).required(),
    levels: Joi.array().items(levelSchema).min(1).max(5).required(),
    isActive: Joi.boolean(),
  }),
});

async function actionContext(req) {
  if (req.user?.isSuperAdmin) {
    return { factoryId: req.factoryId, permissions: ['*'] };
  }
  const permissions = req.permissions?.length
    ? req.permissions
    : await getUserPermissions(req.user._id, req.factoryId);
  return { factoryId: req.factoryId, permissions };
}

export async function submit(req, res, next) {
  try {
    const instance = await approvalService.submitForApproval({
      ...req.body,
      submittedBy: req.user._id,
    });
    return success(res, instance, null, 201);
  } catch (err) {
    next(err);
  }
}

export async function approve(req, res, next) {
  try {
    const ctx = await actionContext(req);
    const instance = await approvalService.approveInstance(
      req.params.id, req.user._id, req.body.comments, ctx,
    );
    return success(res, instance);
  } catch (err) {
    next(err);
  }
}

export async function reject(req, res, next) {
  try {
    const ctx = await actionContext(req);
    const instance = await approvalService.rejectInstance(
      req.params.id, req.user._id, req.body.comments, ctx,
    );
    return success(res, instance);
  } catch (err) {
    next(err);
  }
}

export async function requestChanges(req, res, next) {
  try {
    const ctx = await actionContext(req);
    const instance = await approvalService.requestChangesInstance(
      req.params.id, req.user._id, req.body.comments, ctx,
    );
    return success(res, instance);
  } catch (err) {
    next(err);
  }
}

export async function listApprovals(req, res, next) {
  try {
    const { page, limit, skip } = paginate(req.query);
    const { items, total } = await approvalService.listApprovals(req.factoryId, {
      status: req.query.status || 'PENDING',
      documentType: req.query.documentType,
      search: req.query.search,
      submittedBy: req.query.scope === 'mine' ? req.user._id : undefined,
      skip,
      limit,
    });
    return success(res, items, buildMeta(page, limit, total));
  } catch (err) {
    next(err);
  }
}

export async function listPending(req, res, next) {
  try {
    const { page, limit, skip } = paginate(req.query);
    const { items, total } = await approvalService.listPendingApprovals(req.factoryId, {
      documentType: req.query.documentType,
      search: req.query.search,
      skip,
      limit,
    });
    return success(res, items, buildMeta(page, limit, total));
  } catch (err) {
    next(err);
  }
}

export async function getById(req, res, next) {
  try {
    return success(res, await approvalService.getApprovalInstance(req.params.id, req.factoryId));
  } catch (err) {
    next(err);
  }
}

export async function stats(req, res, next) {
  try {
    return success(res, await approvalService.getApprovalStats(req.factoryId, req.user._id));
  } catch (err) {
    next(err);
  }
}

export async function createWorkflow(req, res, next) {
  try {
    const workflow = await approvalService.createWorkflow(req.body);
    return success(res, workflow, null, 201);
  } catch (err) {
    next(err);
  }
}

export async function listWorkflows(req, res, next) {
  try {
    const items = await approvalService.listWorkflows(
      req.organizationId,
      req.factoryId,
      { includeInactive: req.query.includeInactive === 'true' },
    );
    return success(res, items);
  } catch (err) {
    next(err);
  }
}

export async function deactivateWorkflow(req, res, next) {
  try {
    const workflow = await approvalService.deactivateWorkflow(
      req.params.id, req.organizationId, req.factoryId,
    );
    return success(res, workflow);
  } catch (err) {
    next(err);
  }
}

export function getCatalog(_req, res) {
  success(res, {
    documentTypes: APPROVAL_DOCUMENT_TYPES,
    statuses: APPROVAL_STATUS_LIST,
    approverPermissions: APPROVER_PERMISSION_OPTIONS,
  });
}
