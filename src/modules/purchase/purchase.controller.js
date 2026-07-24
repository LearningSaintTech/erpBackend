import Joi from 'joi';
import * as purchaseService from './purchase.service.js';
import * as rfqService from './rfq.service.js';
import { success, paginate, buildMeta } from '../../shared/utils/response.js';
import {
  PR_STATUS_LIST, PO_STATUS_LIST, GRN_STATUS_LIST, RFQ_STATUS_LIST, SUPPLIER_STATUS_LIST,
} from './purchase.defaults.js';

const lineSchema = Joi.object({
  materialId: Joi.string().required(),
  requiredQty: Joi.number().greater(0),
  quantity: Joi.number().greater(0),
  orderedQty: Joi.number().greater(0),
  receivedQty: Joi.number().greater(0),
  unit: Joi.string(),
  estimatedUnitCost: Joi.number().min(0),
  unitPrice: Joi.number().min(0),
}).or('requiredQty', 'quantity', 'orderedQty', 'receivedQty');

export const createSupplierSchema = Joi.object({
  body: Joi.object({
    supplierCode: Joi.string().trim().min(2).required(),
    name: Joi.string().trim().min(2).required(),
    contactEmail: Joi.string().email().allow(''),
    phone: Joi.string().allow(''),
    leadTimeDays: Joi.number().integer().min(0),
    paymentTerms: Joi.string().allow(''),
  }),
});

export const updateSupplierSchema = Joi.object({
  body: Joi.object({
    name: Joi.string().trim().min(2),
    contactEmail: Joi.string().email().allow(''),
    phone: Joi.string().allow(''),
    leadTimeDays: Joi.number().integer().min(0),
    paymentTerms: Joi.string().allow(''),
    status: Joi.string().valid(...SUPPLIER_STATUS_LIST),
  }).min(1),
});

export const createPrSchema = Joi.object({
  body: Joi.object({
    lines: Joi.array().items(lineSchema).min(1).required(),
    sourceType: Joi.string().valid('MRP', 'MANUAL'),
    mrpId: Joi.string(),
  }),
});

export const createPoSchema = Joi.object({
  body: Joi.object({
    supplierId: Joi.string().required(),
    prId: Joi.string(),
    lines: Joi.array().items(lineSchema),
  }),
});

export const createGrnSchema = Joi.object({
  body: Joi.object({
    poId: Joi.string().required(),
    lines: Joi.array().items(
      Joi.object({
        materialId: Joi.string().required(),
        receivedQty: Joi.number().greater(0).required(),
        unit: Joi.string(),
      }),
    ).min(1).required(),
  }),
});

export const commentSchema = Joi.object({
  body: Joi.object({
    comments: Joi.string().trim().min(3).required(),
  }),
});

export const fromMrpSchema = Joi.object({
  body: Joi.object({ mrpId: Joi.string().required() }),
});

export const rfqFromPrSchema = Joi.object({
  body: Joi.object({
    prId: Joi.string().required(),
    supplierIds: Joi.array().items(Joi.string()).min(1),
  }),
});

export const quotationSchema = Joi.object({
  body: Joi.object({
    supplierId: Joi.string().required(),
    lines: Joi.array().items(Joi.object({
      materialId: Joi.string().required(),
      quantity: Joi.number().greater(0).required(),
      unit: Joi.string(),
      unitPrice: Joi.number().min(0).required(),
    })).min(1).required(),
    validUntil: Joi.date(),
  }),
});

export async function catalog(req, res, next) {
  try {
    success(res, {
      prStatuses: PR_STATUS_LIST,
      poStatuses: PO_STATUS_LIST,
      grnStatuses: GRN_STATUS_LIST,
      rfqStatuses: RFQ_STATUS_LIST,
    });
  } catch (e) { next(e); }
}

export async function stats(req, res, next) {
  try {
    success(res, await purchaseService.getPurchaseStats(req.factoryId));
  } catch (e) { next(e); }
}

export async function createSupplier(req, res, next) {
  try {
    const supplier = await purchaseService.createSupplier({
      ...req.body,
      factoryId: req.factoryId,
      organizationId: req.user.organizationId,
    }, req.user._id);
    success(res, supplier, null, 201);
  } catch (e) { next(e); }
}

export async function listSuppliers(req, res, next) {
  try {
    const { page, limit, skip } = paginate(req.query);
    const { items, total } = await purchaseService.listSuppliers(req.factoryId, {
      page, limit, skip,
      search: req.query.search || req.query.q,
      status: req.query.status,
    });
    success(res, items, buildMeta(page, limit, total));
  } catch (e) { next(e); }
}

export async function updateSupplier(req, res, next) {
  try {
    success(res, await purchaseService.updateSupplier(req.params.id, req.factoryId, req.body, req.user._id));
  } catch (e) { next(e); }
}

export async function createPr(req, res, next) {
  try {
    const pr = await purchaseService.createPurchaseRequisition({
      ...req.body,
      factoryId: req.factoryId,
      organizationId: req.user.organizationId,
    }, req.user._id);
    success(res, pr, null, 201);
  } catch (e) { next(e); }
}

export async function createPrFromMrp(req, res, next) {
  try {
    success(res, await purchaseService.createPrFromMrp(req.body.mrpId, req.factoryId, req.user._id), null, 201);
  } catch (e) { next(e); }
}

export async function listPrs(req, res, next) {
  try {
    const { page, limit, skip } = paginate(req.query);
    const { items, total } = await purchaseService.listPurchaseRequisitions(req.factoryId, {
      page, limit, skip,
      status: req.query.status,
      excludeStatus: req.query.excludeStatus,
      search: req.query.search || req.query.q,
      sourceType: req.query.sourceType,
    });
    success(res, items, buildMeta(page, limit, total));
  } catch (e) { next(e); }
}

export async function getPr(req, res, next) {
  try {
    success(res, await purchaseService.getPurchaseRequisition(req.params.id, req.factoryId));
  } catch (e) { next(e); }
}

export async function submitPr(req, res, next) {
  try {
    success(res, await purchaseService.submitPurchaseRequisition(req.params.id, req.factoryId, req.user._id));
  } catch (e) { next(e); }
}

export async function approvePr(req, res, next) {
  try {
    success(res, await purchaseService.approvePurchaseRequisition(
      req.params.id,
      req.factoryId,
      req.user._id,
      { permissions: req.permissions },
    ));
  } catch (e) { next(e); }
}

export async function rejectPr(req, res, next) {
  try {
    success(res, await purchaseService.rejectPurchaseRequisition(
      req.params.id, req.factoryId, req.user._id, req.body.comments,
      { permissions: req.permissions },
    ));
  } catch (e) { next(e); }
}

export async function createPo(req, res, next) {
  try {
    const po = await purchaseService.createPurchaseOrder({
      ...req.body,
      factoryId: req.factoryId,
      organizationId: req.user.organizationId,
    }, req.user._id);
    success(res, po, null, 201);
  } catch (e) { next(e); }
}

export async function listPos(req, res, next) {
  try {
    const { page, limit, skip } = paginate(req.query);
    const { items, total } = await purchaseService.listPurchaseOrders(req.factoryId, {
      page, limit, skip,
      status: req.query.status,
      excludeStatus: req.query.excludeStatus,
      search: req.query.search || req.query.q,
      supplierId: req.query.supplierId,
    });
    success(res, items, buildMeta(page, limit, total));
  } catch (e) { next(e); }
}

export async function getPo(req, res, next) {
  try {
    success(res, await purchaseService.getPurchaseOrder(req.params.id, req.factoryId));
  } catch (e) { next(e); }
}

export async function poReceiptPreview(req, res, next) {
  try {
    success(res, await purchaseService.getPoReceiptPreview(req.params.id, req.factoryId));
  } catch (e) { next(e); }
}

export async function approvePo(req, res, next) {
  try {
    success(res, await purchaseService.approvePurchaseOrder(req.params.id, req.factoryId, req.user._id));
  } catch (e) { next(e); }
}

export async function sendPo(req, res, next) {
  try {
    success(res, await purchaseService.sendPurchaseOrder(req.params.id, req.factoryId, req.user._id));
  } catch (e) { next(e); }
}

export async function createGrn(req, res, next) {
  try {
    const grn = await purchaseService.createGoodsReceipt({
      ...req.body,
      factoryId: req.factoryId,
      organizationId: req.user.organizationId,
    }, req.user._id);
    success(res, grn, null, 201);
  } catch (e) { next(e); }
}

export async function listGrns(req, res, next) {
  try {
    const { page, limit, skip } = paginate(req.query);
    const { items, total } = await purchaseService.listGoodsReceipts(req.factoryId, {
      page, limit, skip,
      status: req.query.status,
      excludeStatus: req.query.excludeStatus,
      search: req.query.search || req.query.q,
    });
    success(res, items, buildMeta(page, limit, total));
  } catch (e) { next(e); }
}

export async function getGrn(req, res, next) {
  try {
    success(res, await purchaseService.getGoodsReceipt(req.params.id, req.factoryId));
  } catch (e) { next(e); }
}

export async function submitGrnQc(req, res, next) {
  try {
    success(res, await purchaseService.submitGrnForQc(req.params.id, req.factoryId, req.user._id));
  } catch (e) { next(e); }
}

export async function createRfqFromPr(req, res, next) {
  try {
    const rfq = await rfqService.createRfqFromPr({
      factoryId: req.factoryId,
      organizationId: req.user.organizationId,
      prId: req.body.prId,
      supplierIds: req.body.supplierIds,
    }, req.user._id);
    success(res, rfq, null, 201);
  } catch (e) { next(e); }
}

export async function listRfqs(req, res, next) {
  try {
    const { page, limit, skip } = paginate(req.query);
    const { items, total } = await rfqService.listRfqs(req.factoryId, {
      page, limit, skip,
      status: req.query.status,
      search: req.query.search || req.query.q,
    });
    success(res, items, buildMeta(page, limit, total));
  } catch (e) { next(e); }
}

export async function getRfq(req, res, next) {
  try {
    success(res, await rfqService.getRfq(req.params.id, req.factoryId));
  } catch (e) { next(e); }
}

export async function sendRfq(req, res, next) {
  try {
    success(res, await rfqService.sendRfq(req.params.id, req.factoryId, req.user._id));
  } catch (e) { next(e); }
}

export async function addQuotation(req, res, next) {
  try {
    const quote = await rfqService.addQuotation({
      rfqId: req.params.id,
      factoryId: req.factoryId,
      supplierId: req.body.supplierId,
      lines: req.body.lines,
      validUntil: req.body.validUntil,
    }, req.user._id);
    success(res, quote, null, 201);
  } catch (e) { next(e); }
}

export async function compareQuotations(req, res, next) {
  try {
    success(res, await rfqService.compareQuotations(req.params.id, req.factoryId));
  } catch (e) { next(e); }
}

export async function selectQuotation(req, res, next) {
  try {
    success(res, await rfqService.selectQuotation(req.params.id, req.factoryId, req.user._id));
  } catch (e) { next(e); }
}
