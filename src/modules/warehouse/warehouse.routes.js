import { Router } from 'express';
import { validate } from '../../middleware/errorHandler.js';
import { authMiddleware } from '../../middleware/auth.js';
import { tenantMiddleware, requireFactory } from '../../middleware/tenant.js';
import { rbac } from '../../middleware/rbac.js';
import * as ctrl from './warehouse.controller.js';

const router = Router();
router.use(authMiddleware, tenantMiddleware, requireFactory);

router.get('/warehouse/catalog', rbac('warehouse.read'), ctrl.catalog);
router.get('/warehouse/stats', rbac('warehouse.read'), ctrl.stats);
router.get('/warehouse/stock-locator', rbac('warehouse.read'), ctrl.stockLocator);

router.post('/warehouses', rbac('warehouse.create'), validate(ctrl.createWarehouseSchema), ctrl.createWarehouse);
router.get('/warehouses', rbac('warehouse.read'), ctrl.listWarehouses);
router.get('/warehouses/:id', rbac('warehouse.read'), ctrl.getWarehouse);
router.patch('/warehouses/:id', rbac('warehouse.update'), validate(ctrl.updateWarehouseSchema), ctrl.updateWarehouse);

router.post('/warehouses/:warehouseId/bins', rbac('warehouse.create'), validate(ctrl.createBinSchema), ctrl.createBin);
router.get('/warehouses/:warehouseId/bins', rbac('warehouse.read'), ctrl.listBins);
router.patch('/warehouses/:warehouseId/bins/:binId', rbac('warehouse.update'), validate(ctrl.updateBinSchema), ctrl.updateBin);
router.get('/warehouses/:warehouseId/bins/:binId/contents', rbac('warehouse.read'), ctrl.binContents);

router.post('/warehouse-operations/put-away', rbac('warehouse.update'), validate(ctrl.materialOpSchema), ctrl.putAway);
router.post('/warehouse-operations/fg-put-away', rbac('warehouse.update'), validate(ctrl.fgOpSchema), ctrl.fgPutAway);
router.post('/warehouse-operations/mark-dispatch-ready', rbac('warehouse.update'), validate(ctrl.fgOpSchema), ctrl.markDispatchReady);
router.get('/warehouse/dispatch-ready', rbac('warehouse.read'), ctrl.listDispatchReady);
router.post('/warehouse-operations/dispatch', rbac('warehouse.update'), validate(ctrl.dispatchSchema), ctrl.dispatch);
router.get('/warehouse/sku-lookup/:barcode', rbac('warehouse.read'), ctrl.skuLookup);
router.post('/warehouse-operations/transfer', rbac('warehouse.update'), validate(ctrl.materialOpSchema), ctrl.transfer);
router.post('/warehouse-operations/pick', rbac('warehouse.update'), validate(ctrl.materialOpSchema), ctrl.pick);

router.post('/warehouses/:warehouseId/zones', rbac('warehouse.configure'), validate(ctrl.createZoneSchema), ctrl.createZone);
router.get('/warehouses/:warehouseId/zones', rbac('warehouse.read'), ctrl.listZones);
router.get('/warehouses/:warehouseId/layout', rbac('warehouse.read'), ctrl.warehouseLayout);
router.post('/zones/:zoneId/racks', rbac('warehouse.configure'), validate(ctrl.createRackSchema), ctrl.createRack);
router.get('/zones/:zoneId/racks', rbac('warehouse.read'), ctrl.listRacks);
router.post('/racks/:rackId/shelves', rbac('warehouse.configure'), validate(ctrl.createShelfSchema), ctrl.createShelf);
router.get('/racks/:rackId/shelves', rbac('warehouse.read'), ctrl.listShelves);
router.get('/warehouse/bins/lookup/:barcode', rbac('warehouse.read'), ctrl.binLookup);

router.post('/cycle-counts', rbac('warehouse.create'), validate(ctrl.createCycleCountSchema), ctrl.createCycleCount);
router.get('/cycle-counts', rbac('warehouse.read'), ctrl.listCycleCounts);
router.get('/cycle-counts/:id', rbac('warehouse.read'), ctrl.getCycleCount);
router.post('/cycle-counts/:id/start', rbac('warehouse.update'), ctrl.startCycleCount);
router.post('/cycle-counts/:id/complete', rbac('warehouse.update'), validate(ctrl.completeCycleCountSchema), ctrl.completeCycleCount);

export default router;
