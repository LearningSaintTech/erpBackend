import { Router } from 'express';
import { validate } from '../../middleware/errorHandler.js';
import { authMiddleware } from '../../middleware/auth.js';
import { tenantMiddleware, requireFactory } from '../../middleware/tenant.js';
import { rbac } from '../../middleware/rbac.js';
import * as ctrl from './pattern.controller.js';

const router = Router();
router.use(authMiddleware, tenantMiddleware, requireFactory);

router.get('/pattern-developments/catalog', rbac('pattern.read'), ctrl.catalog);
router.get('/pattern-developments/stats', rbac('pattern.read'), ctrl.stats);
router.get('/pattern-developments', rbac('pattern.read'), ctrl.list);
router.post('/pattern-developments/assign', rbac('pattern.create'), validate(ctrl.assignSchema), ctrl.assign);
router.get('/pattern-developments/:designId/tech-pack', rbac('pattern.read'), ctrl.techPack);
router.get('/pattern-developments/:designId/evidence', rbac('pattern.read'), ctrl.evidence);
router.get('/pattern-developments/:designId', rbac('pattern.read'), ctrl.getByDesign);
router.put('/pattern-developments/:designId', rbac('pattern.update'), validate(ctrl.updateSchema), ctrl.update);
router.post('/pattern-developments/:designId/marker-file', rbac('pattern.update'), validate(ctrl.markerUploadSchema), ctrl.uploadMarker);
router.post('/pattern-developments/:designId/complete', rbac('pattern.update'), ctrl.complete);
router.post('/pattern-developments/:designId/reopen-for-fit', rbac('pattern.approve'), validate(ctrl.reopenForFitSchema), ctrl.reopenForFit);
router.post('/pattern-developments/:designId/reopen', rbac('pattern.approve'), ctrl.reopen);

export default router;
