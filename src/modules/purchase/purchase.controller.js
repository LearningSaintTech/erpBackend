import Joi from 'joi';
import * as purchaseService from './purchase.service.js';
import { queryString } from '../../shared/utils/schema.js';
import { success, paginate, buildMeta } from '../../shared/utils/response.js';
import {
  PR_STATUS_LIST, PO_STATUS_LIST, GRN_STATUS_LIST, SUPPLIER_STATUS_LIST,
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
    contactPerson: Joi.string().allow(''),
    contactEmail: Joi.string().email().allow(''),
    phone: Joi.string().allow(''),
    gstNumber: Joi.string().allow(''),
    materialsSupplied: Joi.string().allow(''),
    leadTimeDays: Joi.number().integer().min(0),
    paymentTerms: Joi.string().allow(''),
  }),
});

export const updateSupplierSchema = Joi.object({
  body: Joi.object({
    name: Joi.string().trim().min(2),
    contactPerson: Joi.string().allow(''),
    contactEmail: Joi.string().email().allow(''),
    phone: Joi.string().allow(''),
    gstNumber: Joi.string().allow(''),
    materialsSupplied: Joi.string().allow(''),
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

/** Requester edits a DRAFT / REJECTED PR (e.g. after "Request changes"). Lines replace the old ones. */
export const updatePrSchema = Joi.object({
  body: Joi.object({
    lines: Joi.array().items(lineSchema).min(1).required(),
  }),
});

const receiptItemSchema = Joi.object({
  url: Joi.string().allow(''),
  fileName: Joi.string().allow(''),
  contentType: Joi.string().allow(''),
  data: Joi.string().allow(''),
  dataUrl: Joi.string().allow(''),
});

// With prId, a line may only override unitPrice (qty defaults to the PR line qty)
const poLineSchema = Joi.object({
  materialId: Joi.string().required(),
  orderedQty: Joi.number().greater(0),
  quantity: Joi.number().greater(0),
  unit: Joi.string(),
  unitPrice: Joi.number().min(0),
});

export const createPoSchema = Joi.object({
  body: Joi.object({
    supplierId: Joi.string().required(),
    prId: Joi.string(),
    lines: Joi.array().items(poLineSchema),
    receipts: Joi.array().items(receiptItemSchema).max(12),
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
    receipts: Joi.array().items(receiptItemSchema).max(12),
  }),
});

export const setReceiptsSchema = Joi.object({
  body: Joi.object({
    receipts: Joi.array().items(receiptItemSchema).max(12).required(),
  }),
});

export const commentSchema = Joi.object({
  body: Joi.object({
    comments: Joi.string().trim().min(3).required(),
  }),
});

export const reasonSchema = Joi.object({
  body: Joi.object({
    reason: Joi.string().trim().allow('').max(500),
  }).default({}),
});

export const fromMrpSchema = Joi.object({
  body: Joi.object({ mrpId: Joi.string().required() }),
});


export async function catalog(req, res, next) {
  try {
    success(res, {
      prStatuses: PR_STATUS_LIST,
      poStatuses: PO_STATUS_LIST,
      grnStatuses: GRN_STATUS_LIST,
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
      search: queryString(req.query.search) || queryString(req.query.q),
      status: queryString(req.query.status),
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
      status: queryString(req.query.status),
      excludeStatus: queryString(req.query.excludeStatus),
      search: queryString(req.query.search) || queryString(req.query.q),
      sourceType: queryString(req.query.sourceType),
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

export async function requestPrChanges(req, res, next) {
  try {
    success(res, await purchaseService.requestPurchaseRequisitionChanges(
      req.params.id, req.factoryId, req.user._id, req.body.comments,
    ));
  } catch (e) { next(e); }
}

export async function updatePr(req, res, next) {
  try {
    success(res, await purchaseService.updatePurchaseRequisition(req.params.id, req.factoryId, req.body, req.user._id));
  } catch (e) { next(e); }
}

export async function cancelPr(req, res, next) {
  try {
    success(res, await purchaseService.cancelPurchaseRequisition(req.params.id, req.factoryId, req.user._id));
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
      status: queryString(req.query.status),
      excludeStatus: queryString(req.query.excludeStatus),
      search: queryString(req.query.search) || queryString(req.query.q),
      supplierId: queryString(req.query.supplierId),
      paymentStatus: queryString(req.query.paymentStatus),
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

export async function downloadPoReceipt(req, res, next) {
  try {
    await purchaseService.downloadDocumentReceipt('po', req.params.id, req.params.index, req.factoryId, res);
  } catch (e) { next(e); }
}

export async function downloadGrnReceipt(req, res, next) {
  try {
    await purchaseService.downloadDocumentReceipt('grn', req.params.id, req.params.index, req.factoryId, res);
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

export async function cancelPo(req, res, next) {
  try {
    success(res, await purchaseService.cancelPurchaseOrder(
      req.params.id, req.factoryId, req.user._id, req.body?.reason,
    ));
  } catch (e) { next(e); }
}

export async function closePo(req, res, next) {
  try {
    success(res, await purchaseService.closePurchaseOrder(
      req.params.id, req.factoryId, req.user._id, req.body?.reason,
    ));
  } catch (e) { next(e); }
}

export async function markPoPaid(req, res, next) {
  try {
    success(res, await purchaseService.markPurchaseOrderPaid(req.params.id, req.factoryId, req.user._id));
  } catch (e) { next(e); }
}

export async function setPoReceipts(req, res, next) {
  try {
    success(res, await purchaseService.setPurchaseOrderReceipts(
      req.params.id, req.factoryId, req.body.receipts, req.user._id,
    ));
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
      status: queryString(req.query.status),
      excludeStatus: queryString(req.query.excludeStatus),
      search: queryString(req.query.search) || queryString(req.query.q),
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

export async function cancelGrn(req, res, next) {
  try {
    success(res, await purchaseService.cancelGoodsReceipt(req.params.id, req.factoryId, req.user._id));
  } catch (e) { next(e); }
}

export async function setGrnReceipts(req, res, next) {
  try {
    success(res, await purchaseService.setGoodsReceiptReceipts(
      req.params.id, req.factoryId, req.body.receipts, req.user._id,
    ));
  } catch (e) { next(e); }
}

