import { Router } from 'express';
import { authMiddleware } from '../../middleware/auth.js';
import { rbac, rbacAny } from '../../middleware/rbac.js';
import { validate } from '../../middleware/errorHandler.js';
import * as ctrl from './inventoryCode.controller.js';

const router = Router();

router.use(authMiddleware);

router.get(
  '/inventory-codes/stats',
  rbacAny('inventory.read', 'design.read', 'pattern.read'),
  ctrl.getInventoryCodeStats,
);
router.get(
  '/inventory-codes',
  rbacAny('inventory.read', 'design.read', 'pattern.read'),
  ctrl.listInventoryCodes,
);
router.get('/inventory-codes/:id', rbacAny('inventory.read', 'design.read', 'pattern.read'), ctrl.getInventoryCode);
router.post(
  '/inventory-codes',
  rbacAny('inventory.configure', 'design.create', 'design.update', 'pattern.update', 'pattern.create'),
  validate(ctrl.createCodeSchema),
  ctrl.createInventoryCode,
);
router.patch(
  '/inventory-codes/:id',
  rbac('inventory.configure'),
  validate(ctrl.patchCodeSchema),
  ctrl.updateInventoryCode,
);
router.delete('/inventory-codes/:id', rbac('inventory.configure'), ctrl.deleteInventoryCode);

router.get('/sku-formula-config/catalog', rbac('inventory.read'), ctrl.getSkuSegmentCatalog);
router.get('/sku-formula-config', rbac('inventory.read'), ctrl.getSkuFormulaConfig);
router.put(
  '/sku-formula-config',
  rbac('inventory.configure'),
  validate(ctrl.skuFormulaSchema),
  ctrl.updateSkuFormulaConfig,
);

export default router;
