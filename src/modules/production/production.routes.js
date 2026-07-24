import { Router } from 'express';
import { validate } from '../../middleware/errorHandler.js';
import { authMiddleware } from '../../middleware/auth.js';
import { tenantMiddleware, requireFactory } from '../../middleware/tenant.js';
import { rbac } from '../../middleware/rbac.js';
import * as ctrl from './production.controller.js';

const router = Router();
router.use(authMiddleware, tenantMiddleware, requireFactory);

router.get('/production/catalog', rbac('production.read'), ctrl.catalog);
router.get('/production/stats', rbac('production.read'), ctrl.stats);
router.get('/production/capacity', rbac('production.read'), ctrl.capacity);
router.get('/production/stages', rbac('production.read'), ctrl.listStages);

router.post('/production-orders', rbac('production.create'), validate(ctrl.createOrderSchema), ctrl.createOrder);
router.get('/production-orders', rbac('production.read'), ctrl.listOrders);
router.get('/production-orders/:id', rbac('production.read'), ctrl.getOrder);
router.put('/production-orders/:id', rbac('production.update'), validate(ctrl.updateOrderSchema), ctrl.updateOrder);
router.post('/production-orders/:id/cancel', rbac('production.update'), ctrl.cancelOrder);
router.post('/production-orders/:id/mrp', rbac('production.update'), ctrl.runMrp);
router.post('/production-orders/:id/reserve', rbac('production.update'), ctrl.reserveMaterials);
router.post('/production-orders/:id/submit-approval', rbac('production.update'), ctrl.submitApproval);
router.post('/production-orders/:id/approve', rbac('production.approve'), ctrl.approveOrder);
router.post('/production-orders/:id/reject', rbac('production.approve'), validate(ctrl.commentSchema), ctrl.rejectOrder);
router.post('/production-orders/:id/batches', rbac('batch.create'), validate(ctrl.createBatchSchema), ctrl.createBatch);

router.get('/batches', rbac('batch.read'), ctrl.listBatches);
router.get('/batches/board', rbac('batch.read'), ctrl.batchBoard);
router.get('/batches/:id', rbac('batch.read'), ctrl.getBatch);
router.post('/batches/:id/assign-resources', rbac('batch.update'), validate(ctrl.assignResourcesSchema), ctrl.assignResources);
router.post('/batches/:id/start', rbac('batch.update'), ctrl.startBatch);
router.post('/batches/:id/complete-stage', rbac('batch.update'), validate(ctrl.completeStageSchema), ctrl.completeStage);
router.post('/batches/:id/rollback-stage', rbac('batch.update'), ctrl.rollbackStage);

router.post('/production-schedules', rbac('production.update'), validate(ctrl.createScheduleSchema), ctrl.createSchedule);
router.get('/production-schedules', rbac('production.read'), ctrl.listSchedules);
router.put('/production-schedules/:id', rbac('production.update'), validate(ctrl.updateScheduleSchema), ctrl.updateSchedule);

export default router;
