import Joi from 'joi';
import * as skuService from './sku.service.js';
import { success, paginate, buildMeta } from '../../shared/utils/response.js';
import { SKU_STATUS_LIST } from './sku.defaults.js';

export const createSchema = Joi.object({
  body: Joi.object({
    sampleId: Joi.string().required(),
    size: Joi.string(),
    color: Joi.object({ name: Joi.string(), hexCode: Joi.string() }),
    basePrice: Joi.number().min(0),
    name: Joi.string().trim(),
    status: Joi.string().valid(...SKU_STATUS_LIST),
  }),
});

export const bulkSchema = Joi.object({
  body: Joi.object({
    designId: Joi.string().required(),
    sampleId: Joi.string().required(),
    basePrice: Joi.number().min(0),
  }),
});

export const updateSchema = Joi.object({
  body: Joi.object({
    name: Joi.string().trim().min(2),
    basePrice: Joi.number().min(0),
    barcode: Joi.string().allow(''),
    status: Joi.string().valid(...SKU_STATUS_LIST),
  }).min(1),
});

export async function catalog(req, res, next) {
  try {
    success(res, { statuses: SKU_STATUS_LIST, sampleTypes: ['PROTOTYPE', 'FIT', 'PP', 'TOP'] });
  } catch (e) { next(e); }
}

export async function stats(req, res, next) {
  try {
    success(res, await skuService.getSkuStats(req.factoryId));
  } catch (e) { next(e); }
}

export async function eligibleSamples(req, res, next) {
  try {
    success(res, await skuService.listEligibleSamples(req.factoryId));
  } catch (e) { next(e); }
}

export async function preview(req, res, next) {
  try {
    success(res, await skuService.previewSkusFromSample(req.query.sampleId, req.factoryId));
  } catch (e) { next(e); }
}

export async function create(req, res, next) {
  try {
    const sku = await skuService.createSkuFromSample(
      { ...req.body, factoryId: req.factoryId },
      req.user._id,
    );
    success(res, sku, null, 201);
  } catch (e) { next(e); }
}

export async function bulkCreate(req, res, next) {
  try {
    const result = await skuService.createSkusFromDesign(
      { ...req.body, factoryId: req.factoryId },
      req.user._id,
    );
    success(res, result, null, 201);
  } catch (e) { next(e); }
}

export async function list(req, res, next) {
  try {
    const { page, limit, skip } = paginate(req.query);
    const { items, total } = await skuService.listSkus(req.factoryId, {
      status: req.query.status,
      designId: req.query.designId,
      sampleId: req.query.sampleId,
      search: req.query.search || req.query.q,
      page, limit, skip,
    });
    success(res, items, buildMeta(page, limit, total));
  } catch (e) { next(e); }
}

export async function get(req, res, next) {
  try {
    success(res, await skuService.getSku(req.params.id, req.factoryId));
  } catch (e) { next(e); }
}

export async function update(req, res, next) {
  try {
    success(res, await skuService.updateSku(req.params.id, req.factoryId, req.body, req.user._id));
  } catch (e) { next(e); }
}
