import { Router } from 'express';
import { validate } from '../../middleware/errorHandler.js';
import { authMiddleware } from '../../middleware/auth.js';
import { tenantMiddleware, requireFactory } from '../../middleware/tenant.js';
import { rbac } from '../../middleware/rbac.js';
import * as ctrl from './bom.controller.js';

const router = Router();
router.use(authMiddleware, tenantMiddleware, requireFactory);

router.get('/boms/catalog', rbac('bom.read'), ctrl.catalog);
router.get('/boms/stats', rbac('bom.read'), ctrl.stats);
router.get('/boms/suggest-lines', rbac('bom.create'), ctrl.suggestLines);
router.get('/boms', rbac('bom.read'), ctrl.list);
router.post('/boms', rbac('bom.create'), validate(ctrl.createSchema), ctrl.create);
router.get('/boms/:id/mrp-preview', rbac('bom.read'), ctrl.mrpPreview);
router.get('/boms/:id', rbac('bom.read'), ctrl.get);
router.put('/boms/:id', rbac('bom.update'), validate(ctrl.updateSchema), ctrl.update);
router.post('/boms/:id/approve', rbac('bom.approve'), ctrl.approve);
router.post('/boms/:id/finalize', rbac('bom.update'), ctrl.finalize);
router.get('/skus/:skuId/bom', rbac('bom.read'), ctrl.activeForSku);

export default router;
