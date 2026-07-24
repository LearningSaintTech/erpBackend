import Joi from 'joi';
import * as inventoryCodeService from './inventoryCode.service.js';
import { success, paginate, buildMeta } from '../../shared/utils/response.js';
import { INVENTORY_CODE_TYPE_LIST } from './inventoryCode.model.js';
import { SKU_SEGMENT_CATALOG, SKU_SEGMENT_KEYS } from './inventoryCode.defaults.js';

const segmentSchema = Joi.object({
  key: Joi.string().valid(...SKU_SEGMENT_KEYS).required(),
  optional: Joi.boolean().default(false),
});

export const createCodeSchema = Joi.object({
  body: Joi.object({
    type: Joi.string().valid(...INVENTORY_CODE_TYPE_LIST).required(),
    code: Joi.string().trim().required(),
    name: Joi.string().trim().required(),
    sortOrder: Joi.number().integer().min(0),
    isActive: Joi.boolean(),
    remarks: Joi.string().allow(''),
  }),
});

export const patchCodeSchema = Joi.object({
  body: Joi.object({
    type: Joi.string().valid(...INVENTORY_CODE_TYPE_LIST),
    code: Joi.string().trim(),
    name: Joi.string().trim(),
    sortOrder: Joi.number().integer().min(0),
    isActive: Joi.boolean(),
    remarks: Joi.string().allow(''),
  }).min(1),
});

export const skuFormulaSchema = Joi.object({
  body: Joi.object({
    name: Joi.string().trim(),
    skuSegmentOrder: Joi.array().items(segmentSchema).min(1),
  }).min(1),
});

export async function listInventoryCodes(req, res, next) {
  try {
    const { page, limit, skip } = paginate(req.query);
    const activeOnly = req.query.active !== 'false' && req.query.active !== '0' && req.query.inactiveOnly !== 'true';
    const inactiveOnly = req.query.inactiveOnly === 'true';
    const { items, total } = await inventoryCodeService.listInventoryCodes({
      type: req.query.type,
      activeOnly,
      inactiveOnly,
      search: req.query.search,
      skip,
      limit,
    });
    success(res, items, buildMeta(page, limit, total));
  } catch (e) { next(e); }
}

export async function getInventoryCode(req, res, next) {
  try {
    success(res, await inventoryCodeService.getInventoryCode(req.params.id));
  } catch (e) { next(e); }
}

export async function createInventoryCode(req, res, next) {
  try {
    success(res, await inventoryCodeService.createInventoryCode(req.body), null, 201);
  } catch (e) { next(e); }
}

export async function updateInventoryCode(req, res, next) {
  try {
    success(res, await inventoryCodeService.updateInventoryCode(req.params.id, req.body));
  } catch (e) { next(e); }
}

export async function deleteInventoryCode(req, res, next) {
  try {
    success(res, await inventoryCodeService.deleteInventoryCode(req.params.id));
  } catch (e) { next(e); }
}

export async function getSkuFormulaConfig(req, res, next) {
  try {
    success(res, await inventoryCodeService.getActiveSkuFormulaConfig());
  } catch (e) { next(e); }
}

export async function updateSkuFormulaConfig(req, res, next) {
  try {
    success(res, await inventoryCodeService.updateSkuFormulaConfig(req.body));
  } catch (e) { next(e); }
}

export function getSkuSegmentCatalog(_req, res) {
  success(res, SKU_SEGMENT_CATALOG);
}
