import Joi from 'joi';
import * as inventoryService from './inventory.service.js';
import { success, paginate, buildMeta } from '../../shared/utils/response.js';
import {
  MATERIAL_CATEGORIES, MATERIAL_UNITS, INVENTORY_TYPES, TRANSACTION_TYPES,
} from './inventory.defaults.js';

export const createMaterialSchema = Joi.object({
  body: Joi.object({
    materialCode: Joi.string().trim().min(2).required(),
    name: Joi.string().trim().min(2).required(),
    category: Joi.string().valid(...MATERIAL_CATEGORIES),
    unit: Joi.string().valid(...MATERIAL_UNITS),
    unitCost: Joi.number().min(0),
    reorderLevel: Joi.number().min(0),
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
  }).min(1),
});

export const receiptSchema = Joi.object({
  body: Joi.object({
    materialId: Joi.string().required(),
    quantity: Joi.number().greater(0).required(),
    unit: Joi.string().valid(...MATERIAL_UNITS),
    storageBinId: Joi.string(),
  }),
});

export const reserveSchema = Joi.object({
  body: Joi.object({
    materialId: Joi.string().required(),
    quantity: Joi.number().greater(0).required(),
    unit: Joi.string().valid(...MATERIAL_UNITS),
    referenceType: Joi.string().required(),
    referenceId: Joi.string().required(),
  }),
});

export const issueSchema = Joi.object({
  body: Joi.object({
    materialId: Joi.string().required(),
    quantity: Joi.number().greater(0).required(),
    unit: Joi.string().valid(...MATERIAL_UNITS),
    referenceType: Joi.string().required(),
    referenceId: Joi.string().required(),
    reservationReferenceType: Joi.string(),
    reservationReferenceId: Joi.string(),
  }),
});

export const releaseSchema = Joi.object({
  body: Joi.object({
    referenceType: Joi.string().required(),
    referenceId: Joi.string().required(),
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

export async function listMaterials(req, res, next) {
  try {
    const { page, limit, skip } = paginate(req.query);
    const { items, total } = await inventoryService.listMaterials(req.factoryId, {
      page, limit, skip,
      search: req.query.search || req.query.q,
      category: req.query.category,
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
      userId: req.user._id,
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
      search: req.query.search || req.query.q,
      lowStockOnly: req.query.lowStockOnly === 'true',
      inventoryType: req.query.inventoryType,
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
      materialId: req.query.materialId,
      type: req.query.type,
    });
    success(res, items, buildMeta(page, limit, total));
  } catch (e) { next(e); }
}

export async function availability(req, res, next) {
  try {
    const materialId = req.query.materialId;
    if (!materialId) {
      return res.status(400).json({ success: false, message: 'materialId required' });
    }
    success(res, await inventoryService.getAvailability(req.factoryId, materialId));
  } catch (e) { next(e); }
}

export async function reserve(req, res, next) {
  try {
    const reservation = await inventoryService.reserveMaterial({
      factoryId: req.factoryId,
      organizationId: req.user.organizationId,
      ...req.body,
      userId: req.user._id,
    });
    success(res, reservation, null, 201);
  } catch (e) { next(e); }
}

export async function issue(req, res, next) {
  try {
    const balance = await inventoryService.issueMaterial({
      factoryId: req.factoryId,
      organizationId: req.user.organizationId,
      ...req.body,
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
      referenceType: req.body.referenceType,
      referenceId: req.body.referenceId,
      userId: req.user._id,
    });
    success(res, { released: count });
  } catch (e) { next(e); }
}
