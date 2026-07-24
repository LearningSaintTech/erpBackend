import { Router } from 'express';
import { validate } from '../../middleware/errorHandler.js';
import { authMiddleware } from '../../middleware/auth.js';
import { tenantMiddleware, requireFactory } from '../../middleware/tenant.js';
import { rbac } from '../../middleware/rbac.js';
import * as ctrl from './sku.controller.js';

const router = Router();
router.use(authMiddleware, tenantMiddleware, requireFactory);

router.get('/skus/catalog', rbac('sku.read'), ctrl.catalog);
router.get('/skus/stats', rbac('sku.read'), ctrl.stats);
router.get('/skus/eligible-samples', rbac('sku.create'), ctrl.eligibleSamples);
router.get('/skus/preview', rbac('sku.create'), ctrl.preview);
router.post('/skus/bulk', rbac('sku.create'), validate(ctrl.bulkSchema), ctrl.bulkCreate);
router.get('/skus', rbac('sku.read'), ctrl.list);
router.post('/skus', rbac('sku.create'), validate(ctrl.createSchema), ctrl.create);
router.get('/skus/:id', rbac('sku.read'), ctrl.get);
router.patch('/skus/:id', rbac('sku.update'), validate(ctrl.updateSchema), ctrl.update);

export default router;
