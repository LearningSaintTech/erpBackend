import { Router } from 'express';
import { validate } from '../../middleware/errorHandler.js';
import { authMiddleware } from '../../middleware/auth.js';
import { tenantMiddleware, requireFactory } from '../../middleware/tenant.js';
import { rbac } from '../../middleware/rbac.js';
import * as ctrl from './quality.controller.js';

const router = Router();
router.use(authMiddleware, tenantMiddleware, requireFactory);

router.get('/quality/catalog', rbac('quality.read'), ctrl.catalog);
router.get('/quality/stats', rbac('quality.read'), ctrl.stats);
router.get('/quality/pending-work', rbac('quality.read'), ctrl.pendingWork);

router.get('/quality-inspections/queue', rbac('quality.read'), ctrl.queue);
router.get('/quality-inspections', rbac('quality.read'), ctrl.listInspections);
router.get('/quality-inspections/:id', rbac('quality.read'), ctrl.getInspection);
router.post('/quality-inspections/:id/start', rbac('quality.update'), ctrl.startInspection);
router.post('/quality-inspections/:id/complete', rbac('quality.update'), validate(ctrl.completeInspectionSchema), ctrl.completeInspection);
router.get('/quality-inspections/:id/defects', rbac('quality.read'), ctrl.listDefects);
router.post('/quality-inspections/:id/defects', rbac('quality.update'), validate(ctrl.recordDefectSchema), ctrl.recordDefect);

router.get('/goods-receipts/:id/qc-context', rbac('quality.read'), ctrl.incomingQcContext);
router.post('/goods-receipts/:id/qc', rbac('quality.create'), ctrl.createIncoming);
router.post('/batches/:id/qc', rbac('quality.create'), validate(ctrl.createFinalSchema), ctrl.createFinal);
router.post('/batches/:id/in-process-qc', rbac('quality.create'), ctrl.createInProcess);

router.get('/defect-categories', rbac('quality.read'), ctrl.listDefectCategories);
router.post('/defect-categories', rbac('quality.configure'), validate(ctrl.createCategorySchema), ctrl.createDefectCategory);

router.get('/inspection-templates', rbac('quality.read'), ctrl.listTemplates);
router.post('/inspection-templates', rbac('quality.configure'), validate(ctrl.createTemplateSchema), ctrl.createTemplate);

router.get('/capa-records', rbac('quality.read'), ctrl.listCapa);
router.get('/capa-records/:id', rbac('quality.read'), ctrl.getCapa);
router.post('/capa-records', rbac('quality.create'), validate(ctrl.createCapaSchema), ctrl.createCapa);
router.patch('/capa-records/:id', rbac('quality.update'), validate(ctrl.updateCapaSchema), ctrl.updateCapa);
router.post('/capa-records/:id/close', rbac('quality.approve'), ctrl.closeCapa);

export default router;
