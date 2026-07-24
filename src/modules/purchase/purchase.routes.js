import { Router } from 'express';
import { validate } from '../../middleware/errorHandler.js';
import { authMiddleware } from '../../middleware/auth.js';
import { tenantMiddleware, requireFactory } from '../../middleware/tenant.js';
import { rbac } from '../../middleware/rbac.js';
import * as ctrl from './purchase.controller.js';

const router = Router();
router.use(authMiddleware, tenantMiddleware, requireFactory);

router.get('/purchase/catalog', rbac('purchase.read'), ctrl.catalog);
router.get('/purchase/stats', rbac('purchase.read'), ctrl.stats);

router.post('/suppliers', rbac('purchase.create', 'purchase.approve'), validate(ctrl.createSupplierSchema), ctrl.createSupplier);
router.get('/suppliers', rbac('purchase.read'), ctrl.listSuppliers);
router.patch('/suppliers/:id', rbac('purchase.update', 'purchase.approve'), validate(ctrl.updateSupplierSchema), ctrl.updateSupplier);

router.post('/purchase-requisitions', rbac('purchase.create'), validate(ctrl.createPrSchema), ctrl.createPr);
router.post('/purchase-requisitions/from-mrp', rbac('purchase.create', 'purchase.approve'), validate(ctrl.fromMrpSchema), ctrl.createPrFromMrp);
router.get('/purchase-requisitions', rbac('purchase.read'), ctrl.listPrs);
router.get('/purchase-requisitions/:id', rbac('purchase.read'), ctrl.getPr);
router.post('/purchase-requisitions/:id/submit', rbac('purchase.update'), ctrl.submitPr);
router.post('/purchase-requisitions/:id/approve', rbac('purchase.approve'), ctrl.approvePr);
router.post('/purchase-requisitions/:id/reject', rbac('purchase.approve'), validate(ctrl.commentSchema), ctrl.rejectPr);

router.post('/purchase-orders', rbac('purchase.create', 'purchase.approve'), validate(ctrl.createPoSchema), ctrl.createPo);
router.get('/purchase-orders', rbac('purchase.read'), ctrl.listPos);
router.get('/purchase-orders/:id/receipt-preview', rbac('purchase.read'), ctrl.poReceiptPreview);
router.get('/purchase-orders/:id', rbac('purchase.read'), ctrl.getPo);
router.post('/purchase-orders/:id/approve', rbac('purchase.approve'), ctrl.approvePo);
router.post('/purchase-orders/:id/send', rbac('purchase.update', 'purchase.approve'), ctrl.sendPo);

router.post('/goods-receipts', rbac('purchase.create'), validate(ctrl.createGrnSchema), ctrl.createGrn);
router.get('/goods-receipts', rbac('purchase.read'), ctrl.listGrns);
router.get('/goods-receipts/:id', rbac('purchase.read'), ctrl.getGrn);
router.post('/goods-receipts/:id/submit-qc', rbac('purchase.update'), ctrl.submitGrnQc);

router.post('/rfqs/from-pr', rbac('purchase.create', 'purchase.approve'), validate(ctrl.rfqFromPrSchema), ctrl.createRfqFromPr);
router.get('/rfqs', rbac('purchase.read'), ctrl.listRfqs);
router.get('/rfqs/:id', rbac('purchase.read'), ctrl.getRfq);
router.post('/rfqs/:id/send', rbac('purchase.update', 'purchase.approve'), ctrl.sendRfq);
router.post('/rfqs/:id/quotations', rbac('purchase.create', 'purchase.approve'), validate(ctrl.quotationSchema), ctrl.addQuotation);
router.get('/rfqs/:id/quotations/compare', rbac('purchase.read'), ctrl.compareQuotations);

router.post('/quotations/:id/select', rbac('purchase.approve'), ctrl.selectQuotation);

export default router;
