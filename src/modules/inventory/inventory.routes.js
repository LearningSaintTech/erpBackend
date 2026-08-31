import { Router } from 'express';
import { validate } from '../../middleware/errorHandler.js';
import { authMiddleware } from '../../middleware/auth.js';
import { tenantMiddleware, requireFactory } from '../../middleware/tenant.js';
import { rbac, rbacAny } from '../../middleware/rbac.js';
import * as ctrl from './inventory.controller.js';

const router = Router();
router.use(authMiddleware, tenantMiddleware, requireFactory);

router.get('/inventory/catalog', rbac('inventory.read'), ctrl.catalog);
router.get('/inventory/stats', rbac('inventory.read'), ctrl.stats);
router.get('/inventory/balances', rbac('inventory.read'), ctrl.balances);
router.get('/inventory/transactions', rbac('inventory.read'), ctrl.transactions);
router.post('/inventory/receipt', rbac('inventory.update'), validate(ctrl.receiptSchema), ctrl.receipt);
router.post('/inventory/reserve', rbac('inventory.update'), validate(ctrl.reserveSchema), ctrl.reserve);
router.post('/inventory/issue', rbac('inventory.update'), validate(ctrl.issueSchema), ctrl.issue);
router.post('/inventory/release-reservations', rbac('inventory.update'), validate(ctrl.releaseSchema), ctrl.releaseReservations);
router.get('/inventory/availability', rbac('inventory.read'), ctrl.availability);

router.post('/materials', rbac('inventory.create'), validate(ctrl.createMaterialSchema), ctrl.createMaterial);
router.post('/materials/bulk', rbac('inventory.create'), validate(ctrl.bulkImportMaterialsSchema), ctrl.bulkImportMaterials);
router.get('/materials', rbacAny('inventory.read', 'sampling.read', 'sampling.update', 'purchase.read', 'purchase.create'), ctrl.listMaterials);
router.get('/materials/:id', rbac('inventory.read'), ctrl.getMaterial);
router.patch('/materials/:id', rbac('inventory.update'), validate(ctrl.updateMaterialSchema), ctrl.updateMaterial);

router.get(
  '/material-master-requests',
  rbacAny('inventory.read', 'pattern.read', 'pattern.update'),
  ctrl.listMaterialMasterRequests,
);
router.post(
  '/material-master-requests',
  rbacAny('pattern.update', 'pattern.create'),
  validate(ctrl.createMaterialMasterRequestSchema),
  ctrl.createMaterialMasterRequest,
);
router.post(
  '/material-master-requests/:id/approve',
  rbac('inventory.create'),
  validate(ctrl.approveMaterialMasterRequestSchema),
  ctrl.approveMaterialMasterRequest,
);
router.post(
  '/material-master-requests/:id/reject',
  rbacAny('inventory.create', 'inventory.update'),
  validate(ctrl.rejectMaterialMasterRequestSchema),
  ctrl.rejectMaterialMasterRequest,
);

export default router;
