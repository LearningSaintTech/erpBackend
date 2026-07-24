import { Router } from 'express';
import { authMiddleware } from '../../middleware/auth.js';
import { tenantMiddleware, requireFactory } from '../../middleware/tenant.js';
import { rbac } from '../../middleware/rbac.js';
import { validate } from '../../middleware/errorHandler.js';
import * as ctrl from './waste.controller.js';

const router = Router();
router.use(authMiddleware, tenantMiddleware, requireFactory);

router.get('/waste/catalog', rbac('waste.read'), ctrl.catalog);
router.get('/waste/stats', rbac('waste.read'), ctrl.stats);
router.get('/waste-records/export', rbac('waste.export'), ctrl.exportCsv);
router.get('/waste-records/summary', rbac('waste.read'), ctrl.summary);
router.post('/waste-records', rbac('waste.create'), validate(ctrl.createSchema), ctrl.create);
router.get('/waste-records', rbac('waste.read'), ctrl.list);
router.get('/waste-records/:id', rbac('waste.read'), ctrl.get);
router.post('/waste-records/:id/recovery', rbac('waste.update'), validate(ctrl.recoverySchema), ctrl.recovery);

export default router;
