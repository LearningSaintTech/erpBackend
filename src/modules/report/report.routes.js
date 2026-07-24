import { Router } from 'express';
import { authMiddleware } from '../../middleware/auth.js';
import { tenantMiddleware, requireFactory } from '../../middleware/tenant.js';
import { rbac } from '../../middleware/rbac.js';
import { validate } from '../../middleware/errorHandler.js';
import * as ctrl from './report.controller.js';

const router = Router();
router.use(authMiddleware, tenantMiddleware, requireFactory);

router.get('/reports/catalog', rbac('report.read'), ctrl.catalog);
router.get('/reports/stats', rbac('report.read'), validate(ctrl.dateFilterSchema), ctrl.stats);

router.get('/reports/factory', rbac('report.read'), validate(ctrl.dateFilterSchema), ctrl.factory);
router.get('/reports/production', rbac('report.read'), validate(ctrl.dateFilterSchema), ctrl.production);
router.get('/reports/inventory', rbac('report.read'), validate(ctrl.dateFilterSchema), ctrl.inventory);
router.get('/reports/purchase', rbac('report.read'), validate(ctrl.dateFilterSchema), ctrl.purchase);
router.get('/reports/quality', rbac('report.read'), validate(ctrl.dateFilterSchema), ctrl.quality);
router.get('/reports/waste', rbac('report.read'), validate(ctrl.dateFilterSchema), ctrl.waste);
router.get('/reports/machine', rbac('report.read'), validate(ctrl.dateFilterSchema), ctrl.machine);
router.get('/reports/employee', rbac('report.read'), validate(ctrl.dateFilterSchema), ctrl.employee);
router.get('/reports/financial', rbac('report.read'), validate(ctrl.dateFilterSchema), ctrl.financial);
router.get('/reports/approval', rbac('report.read'), validate(ctrl.dateFilterSchema), ctrl.approval);

router.get('/reports/drill-down/low-stock', rbac('report.read'), ctrl.lowStock);
router.get('/reports/drill-down/pending-approvals', rbac('report.read'), ctrl.pendingApprovals);
router.get('/reports/drill-down/top-defects', rbac('report.read'), validate(ctrl.dateFilterSchema), ctrl.topDefects);

router.get('/reports/:type/export', rbac('report.export'), validate(ctrl.dateFilterSchema), ctrl.exportCsv);

export default router;
