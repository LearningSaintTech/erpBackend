import { Router } from 'express';
import { validate } from '../../middleware/errorHandler.js';
import { authMiddleware } from '../../middleware/auth.js';
import { tenantMiddleware, requireFactory } from '../../middleware/tenant.js';
import { rbac, rbacAny } from '../../middleware/rbac.js';
import * as ctrl from './approval.controller.js';
import { ALL_DOCUMENT_APPROVE_PERMISSIONS } from './approval.defaults.js';

const router = Router();

router.use(authMiddleware, tenantMiddleware);

router.get('/approvals/catalog', rbac('approval.read'), ctrl.getCatalog);
router.get('/approvals/stats', requireFactory, rbac('approval.read'), ctrl.stats);
router.get('/approvals/pending', requireFactory, rbac('approval.read'), ctrl.listPending);
router.get('/approvals', requireFactory, rbac('approval.read'), ctrl.listApprovals);
router.get('/approvals/:id', requireFactory, rbac('approval.read'), ctrl.getById);

router.post('/approvals/submit', requireFactory, rbac('approval.configure'), validate(ctrl.submitSchema), ctrl.submit);
router.post('/approvals/:id/approve', requireFactory, rbacAny(...ALL_DOCUMENT_APPROVE_PERMISSIONS), validate(ctrl.approveSchema), ctrl.approve);
router.post('/approvals/:id/reject', requireFactory, rbacAny(...ALL_DOCUMENT_APPROVE_PERMISSIONS), validate(ctrl.rejectSchema), ctrl.reject);
router.post(
  '/approvals/:id/request-changes',
  requireFactory,
  rbacAny(...ALL_DOCUMENT_APPROVE_PERMISSIONS),
  validate(ctrl.requestChangesSchema),
  ctrl.requestChanges,
);

router.get('/approval-workflows', requireFactory, rbac('approval.read'), ctrl.listWorkflows);
router.post('/approval-workflows', requireFactory, rbac('approval.configure'), validate(ctrl.workflowSchema), ctrl.createWorkflow);
router.post('/approval-workflows/:id/deactivate', requireFactory, rbac('approval.configure'), ctrl.deactivateWorkflow);

export default router;
