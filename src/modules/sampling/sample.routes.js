import { Router } from 'express';
import { validate } from '../../middleware/errorHandler.js';
import { authMiddleware } from '../../middleware/auth.js';
import { tenantMiddleware, requireFactory } from '../../middleware/tenant.js';
import { rbac, rbacAny } from '../../middleware/rbac.js';
import * as ctrl from './sample.controller.js';

const router = Router();
router.use(authMiddleware, tenantMiddleware, requireFactory);

router.get('/samples/catalog', rbac('sampling.read'), ctrl.catalog);
router.get('/samples/material-options', rbac('sampling.read'), ctrl.materialOptions);
router.get('/samples/stats', rbac('sampling.read'), ctrl.stats);
router.get('/samples/eligible-designs', rbac('sampling.create'), ctrl.eligibleDesigns);
router.get('/samples', rbac('sampling.read'), ctrl.list);
router.post('/samples', rbac('sampling.create'), validate(ctrl.createSchema), ctrl.create);

router.get('/samples/:id', rbac('sampling.read'), ctrl.get);
router.put('/samples/:id/materials', rbac('sampling.update'), validate(ctrl.updateMaterialsSchema), ctrl.updateMaterials);
router.post('/samples/:id/refresh-materials', rbac('sampling.update'), ctrl.refreshMaterials);
router.post('/samples/:id/submit-material-request', rbac('sampling.update'), ctrl.submitMaterialRequest);
router.post('/samples/:id/approve-material-request', rbac('sampling.approve'), ctrl.approveMaterialRequest);
router.post('/samples/:id/reject-material-request', rbac('sampling.approve'), validate(ctrl.commentSchema), ctrl.rejectMaterialRequest);
router.post('/samples/:id/submit-for-approval', rbacAny('sampling.update', 'sampling.create'), ctrl.submitForApproval);
router.post('/samples/:id/reserve-materials', rbac('inventory.update'), ctrl.reserveMaterials);
router.post('/samples/:id/issue-materials', rbac('inventory.update'), ctrl.issueMaterials);
router.post('/samples/:id/complete-cutting', rbacAny('sampling.update', 'sampling.create'), ctrl.completeCutting);
router.post('/samples/:id/complete', rbacAny('sampling.update', 'sampling.create'), ctrl.complete);
router.post('/samples/:id/qc-pass', rbac('quality.update'), validate(ctrl.optionalCommentSchema), ctrl.qcPass);
router.post('/samples/:id/qc-fail', rbac('quality.update'), validate(ctrl.commentSchema), ctrl.qcFail);
router.post('/samples/:id/complete-fit-trial', rbacAny('sampling.update', 'sampling.create'), validate(ctrl.optionalCommentSchema), ctrl.completeFitTrial);
router.post('/samples/:id/approve', rbac('sampling.approve'), ctrl.approve);
router.post('/samples/:id/reject', rbac('sampling.approve'), validate(ctrl.commentSchema), ctrl.reject);
router.post('/samples/:id/revision', rbac('sampling.approve'), validate(ctrl.commentSchema), ctrl.revision);
router.post('/samples/:id/reopen', rbac('sampling.update'), ctrl.reopen);

export default router;
