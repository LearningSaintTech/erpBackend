import Joi from 'joi';
import mongoose from 'mongoose';
import * as inventoryService from './inventory.service.js';
import * as materialMasterRequestService from './materialMasterRequest.service.js';
import { success, paginate, buildMeta } from '../../shared/utils/response.js';
import { pickFields, queryString } from '../../shared/utils/schema.js';
import {
  MATERIAL_CATEGORIES, MATERIAL_UNITS, INVENTORY_TYPES, TRANSACTION_TYPES,
} from './inventory.defaults.js';

const imageItemSchema = Joi.object({
  url: Joi.string().allow(''),
  fileName: Joi.string().allow(''),
  contentType: Joi.string().allow(''),
  data: Joi.string().allow(''),
  dataUrl: Joi.string().allow(''),
});

export const createMaterialSchema = Joi.object({
  body: Joi.object({
    materialCode: Joi.string().trim().min(2).required(),
    name: Joi.string().trim().min(2).required(),
    category: Joi.string().valid(...MATERIAL_CATEGORIES),
    unit: Joi.string().valid(...MATERIAL_UNITS),
    unitCost: Joi.number().min(0),
    reorderLevel: Joi.number().min(0),
    supplierId: Joi.string().allow('', null),
    images: Joi.array().items(imageItemSchema).max(12),
  }),
});

export const bulkImportMaterialsSchema = Joi.object({
  body: Joi.object({
    postOpeningStock: Joi.boolean().default(true),
    items: Joi.array().items(Joi.object({
      materialCode: Joi.string().trim().min(2),
      name: Joi.string().trim().min(2).required(),
      category: Joi.string().valid(...MATERIAL_CATEGORIES),
      unit: Joi.string().valid(...MATERIAL_UNITS),
      unitCost: Joi.number().min(0),
      reorderLevel: Joi.number().min(0),
      openingQty: Joi.number().min(0),
      vendorName: Joi.string().allow(''),
      supplierId: Joi.string().allow('', null),
    })).min(1).max(2000).required(),
  }),
});

export const updateMaterialSchema = Joi.object({
  body: Joi.object({
    materialCode: Joi.string().trim().min(2),
    name: Joi.string().trim().min(2),
    category: Joi.string().valid(...MATERIAL_CATEGORIES),
    unit: Joi.string().valid(...MATERIAL_UNITS),
    unitCost: Joi.number().min(0),
    reorderLevel: Joi.number().min(0),
    supplierId: Joi.string().allow('', null),
    images: Joi.array().items(imageItemSchema).max(12),
  }).min(1),
});

export const receiptSchema = Joi.object({
  body: Joi.object({
    materialId: Joi.string().required(),
    quantity: Joi.number().greater(0).required(),
    unit: Joi.string().valid(...MATERIAL_UNITS),
    storageBinId: Joi.string().hex().length(24),
    unitCost: Joi.number().min(0),
  }),
});

export const reserveSchema = Joi.object({
  body: Joi.object({
    materialId: Joi.string().required(),
    quantity: Joi.number().greater(0).required(),
    unit: Joi.string().valid(...MATERIAL_UNITS),
    // Manual endpoint: SAMPLE / PRODUCTION_ORDER holds must go through their own modules
    referenceType: Joi.string().valid('MANUAL').default('MANUAL'),
    // Optional: a hold to top up / group under; generated when omitted
    referenceId: Joi.string().hex().length(24).allow('', null),
    note: Joi.string().trim().max(300).allow(''),
  }),
});

export const issueSchema = Joi.object({
  body: Joi.object({
    materialId: Joi.string().required(),
    quantity: Joi.number().greater(0).required(),
    unit: Joi.string().valid(...MATERIAL_UNITS),
    referenceType: Joi.string().required(),
    referenceId: Joi.string().required(),
    // Only MANUAL holds can be drawn down from this endpoint
    reservationReferenceType: Joi.string().valid('MANUAL'),
    reservationReferenceId: Joi.string(),
  }),
});

export const releaseSchema = Joi.object({
  body: Joi.object({
    referenceType: Joi.string().valid('MANUAL').default('MANUAL'),
    referenceId: Joi.string().hex().length(24).required(),
  }),
});

export const createMaterialMasterRequestSchema = Joi.object({
  body: Joi.object({
    name: Joi.string().trim().min(2).required(),
    proposedCode: Joi.string().trim().allow('', null),
    category: Joi.string().valid(...MATERIAL_CATEGORIES),
    unit: Joi.string().valid(...MATERIAL_UNITS),
    unitCost: Joi.number().min(0),
    notes: Joi.string().allow('', null),
    designId: Joi.string().hex().length(24).required(),
  }),
});

export const approveMaterialMasterRequestSchema = Joi.object({
  body: Joi.object({
    name: Joi.string().trim().min(2),
    materialCode: Joi.string().trim().min(2),
    category: Joi.string().valid(...MATERIAL_CATEGORIES),
    unit: Joi.string().valid(...MATERIAL_UNITS),
    unitCost: Joi.number().min(0),
    reviewNotes: Joi.string().allow('', null),
  }),
});

export const rejectMaterialMasterRequestSchema = Joi.object({
  body: Joi.object({
    reviewNotes: Joi.string().allow('', null),
  }),
});

export async function catalog(req, res, next) {
  try {
    success(res, {
      categories: MATERIAL_CATEGORIES,
      units: MATERIAL_UNITS,
      inventoryTypes: INVENTORY_TYPES,
      transactionTypes: TRANSACTION_TYPES,
    });
  } catch (e) { next(e); }
}

export async function stats(req, res, next) {
  try {
    success(res, await inventoryService.getInventoryStats(req.factoryId));
  } catch (e) { next(e); }
}

export async function createMaterial(req, res, next) {
  try {
    const material = await inventoryService.createMaterial({
      ...req.body,
      factoryId: req.factoryId,
      organizationId: req.user.organizationId,
    }, req.user._id);
    success(res, material, null, 201);
  } catch (e) { next(e); }
}

export async function bulkImportMaterials(req, res, next) {
  try {
    const result = await inventoryService.bulkImportMaterials({
      factoryId: req.factoryId,
      organizationId: req.user.organizationId,
      items: req.body.items,
      postOpeningStock: req.body.postOpeningStock !== false,
    }, req.user._id);
    success(res, result, null, 201);
  } catch (e) { next(e); }
}

export async function listMaterials(req, res, next) {
  try {
    const { page, limit, skip } = paginate(req.query);
    const { items, total } = await inventoryService.listMaterials(req.factoryId, {
      page, limit, skip,
      search: queryString(req.query.search) || queryString(req.query.q),
      category: queryString(req.query.category),
    });
    success(res, items, buildMeta(page, limit, total));
  } catch (e) { next(e); }
}

export async function getMaterial(req, res, next) {
  try {
    success(res, await inventoryService.getMaterial(req.params.id, req.factoryId));
  } catch (e) { next(e); }
}

export async function updateMaterial(req, res, next) {
  try {
    success(res, await inventoryService.updateMaterial(
      req.params.id,
      req.factoryId,
      req.body,
      req.user._id,
    ));
  } catch (e) { next(e); }
}

export async function receipt(req, res, next) {
  try {
    const balance = await inventoryService.receiptMaterial({
      factoryId: req.factoryId,
      organizationId: req.user.organizationId,
      materialId: req.body.materialId,
      quantity: req.body.quantity,
      unit: req.body.unit,
      storageBinId: req.body.storageBinId,
      unitCost: req.body.unitCost,
      userId: req.user._id,
      strictUnit: true,
    });
    success(res, balance, null, 201);
  } catch (e) { next(e); }
}

export async function balances(req, res, next) {
  try {
    const { page, limit, skip } = paginate(req.query);
    const { items, total } = await inventoryService.listBalances(req.factoryId, {
      page: req.query.page ? page : undefined,
      limit: req.query.page ? limit : undefined,
      skip: req.query.page ? skip : undefined,
      search: queryString(req.query.search) || queryString(req.query.q),
      lowStockOnly: req.query.lowStockOnly === 'true',
      inventoryType: queryString(req.query.inventoryType),
      includeEmpty: req.query.includeEmpty === 'true',
    });
    if (req.query.page) {
      success(res, items, buildMeta(page, limit, total));
    } else {
      success(res, items);
    }
  } catch (e) { next(e); }
}

export async function transactions(req, res, next) {
  try {
    const { page, limit, skip } = paginate(req.query);
    const { items, total } = await inventoryService.listTransactions(req.factoryId, {
      page, limit, skip,
      materialId: queryString(req.query.materialId),
      type: queryString(req.query.type),
    });
    success(res, items, buildMeta(page, limit, total));
  } catch (e) { next(e); }
}

export async function availability(req, res, next) {
  try {
    const materialId = queryString(req.query.materialId);
    if (!materialId) {
      return res.status(400).json({ success: false, message: 'materialId required' });
    }
    success(res, await inventoryService.getAvailability(req.factoryId, materialId));
  } catch (e) { next(e); }
}

export async function reserve(req, res, next) {
  try {
    const reservation = await inventoryService.reserveMaterial({
      ...pickFields(req.body, ['materialId', 'quantity', 'unit']),
      referenceType: 'MANUAL',
      // MANUAL holds have no source document — generate an id; the purpose goes in `note`
      referenceId: req.body.referenceId || new mongoose.Types.ObjectId(),
      note: req.body.note || undefined,
      factoryId: req.factoryId,
      organizationId: req.user.organizationId,
      userId: req.user._id,
    });
    success(res, reservation, null, 201);
  } catch (e) { next(e); }
}

export async function issue(req, res, next) {
  try {
    const balance = await inventoryService.issueMaterial({
      ...pickFields(req.body, [
        'materialId', 'quantity', 'unit', 'referenceType', 'referenceId',
        'reservationReferenceType', 'reservationReferenceId',
      ]),
      factoryId: req.factoryId,
      organizationId: req.user.organizationId,
      userId: req.user._id,
    });
    success(res, balance);
  } catch (e) { next(e); }
}

export async function releaseReservations(req, res, next) {
  try {
    const count = await inventoryService.releaseReservations({
      factoryId: req.factoryId,
      organizationId: req.user.organizationId,
      referenceType: 'MANUAL',
      referenceId: req.body.referenceId,
      userId: req.user._id,
    });
    success(res, { released: count });
  } catch (e) { next(e); }
}

export async function manualReservations(req, res, next) {
  try {
    success(res, await inventoryService.listManualReservations(req.factoryId, {
      materialId: queryString(req.query.materialId),
    }));
  } catch (e) { next(e); }
}

function canSeeAllMasterRequests(req) {
  const perms = req.permissions || [];
  return req.user?.isSuperAdmin || perms.includes('*') || perms.includes('inventory.read');
}

export async function listMaterialMasterRequests(req, res, next) {
  try {
    const { page, limit, skip } = paginate(req.query);
    const { items, total } = await materialMasterRequestService.listMaterialMasterRequests(req.factoryId, {
      page, limit, skip,
      status: queryString(req.query.status),
      designId: queryString(req.query.designId),
      canSeeAll: canSeeAllMasterRequests(req),
      userId: req.user._id,
    });
    success(res, items, buildMeta(page, limit, total));
  } catch (e) { next(e); }
}

export async function createMaterialMasterRequest(req, res, next) {
  try {
    const request = await materialMasterRequestService.createMaterialMasterRequest({
      ...req.body,
      factoryId: req.factoryId,
      organizationId: req.user.organizationId,
    }, req.user._id);
    success(res, request, null, 201);
  } catch (e) { next(e); }
}

export async function approveMaterialMasterRequest(req, res, next) {
  try {
    const request = await materialMasterRequestService.approveMaterialMasterRequest(
      req.params.id,
      req.factoryId,
      req.body || {},
      req.user._id,
    );
    success(res, request);
  } catch (e) { next(e); }
}

export async function rejectMaterialMasterRequest(req, res, next) {
  try {
    const request = await materialMasterRequestService.rejectMaterialMasterRequest(
      req.params.id,
      req.factoryId,
      req.body || {},
      req.user._id,
    );
    success(res, request);
  } catch (e) { next(e); }
}
