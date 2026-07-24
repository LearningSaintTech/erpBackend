import { Router } from 'express';
import { validate } from '../../middleware/errorHandler.js';
import { authMiddleware } from '../../middleware/auth.js';
import { tenantMiddleware, requireFactory } from '../../middleware/tenant.js';
import { rbac } from '../../middleware/rbac.js';
import * as ctrl from './machine.controller.js';

const router = Router();
router.use(authMiddleware, tenantMiddleware, requireFactory);

router.post('/machines', rbac('production.configure'), validate(ctrl.createMachineSchema), ctrl.createMachine);
router.get('/machines', rbac('production.read'), ctrl.listMachines);
router.get('/machines/:id', rbac('production.read'), ctrl.getMachine);
router.patch('/machines/:id', rbac('production.configure'), validate(ctrl.updateMachineSchema), ctrl.updateMachine);

router.post('/production-lines', rbac('production.configure'), validate(ctrl.createLineSchema), ctrl.createLine);
router.get('/production-lines', rbac('production.read'), ctrl.listLines);

router.post('/shifts', rbac('production.configure'), validate(ctrl.createShiftSchema), ctrl.createShift);
router.get('/shifts', rbac('production.read'), ctrl.listShifts);

router.post('/batches/:id/assign-machine', rbac('batch.update'), ctrl.assignMachineToBatch);

export default router;
