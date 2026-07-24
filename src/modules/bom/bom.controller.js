import Joi from 'joi';
import * as bomService from './bom.service.js';
import { success, paginate, buildMeta } from '../../shared/utils/response.js';
import { BOM_STATUS_LIST } from './bom.defaults.js';
import * as mrpService from '../mrp/mrp.service.js';

const lineSchema = Joi.object({
  materialId: Joi.string().required(),
  quantityPerPiece: Joi.number().min(0).required(),
  unit: Joi.string(),
  wastagePercent: Joi.number().min(0).max(100),
  unitCost: Joi.number().min(0),
  materialCategory: Joi.string().allow(''),
  isOptional: Joi.boolean(),
});

export const createSchema = Joi.object({
  body: Joi.object({
    skuId: Joi.string().required(),
    lines: Joi.array().items(lineSchema),
    fromDesign: Joi.boolean(),
  }),
});

export const updateSchema = Joi.object({
  body: Joi.object({
    lines: Joi.array().items(lineSchema).min(1).required(),
  }),
});

export async function catalog(req, res, next) {
  try {
    success(res, {
      statuses: BOM_STATUS_LIST,
      workflow: ['DRAFT', 'APPROVED', 'ACTIVE', 'OBSOLETE'],
    });
  } catch (e) { next(e); }
}

export async function stats(req, res, next) {
  try {
    success(res, await bomService.getBomStats(req.factoryId));
  } catch (e) { next(e); }
}

export async function suggestLines(req, res, next) {
  try {
    success(res, await bomService.suggestBomLines(req.query.skuId, req.factoryId));
  } catch (e) { next(e); }
}

export async function create(req, res, next) {
  try {
    const bom = await bomService.createBom({
      ...req.body,
      factoryId: req.factoryId,
      organizationId: req.user.organizationId,
    }, req.user._id);
    success(res, bom, null, 201);
  } catch (e) { next(e); }
}

export async function list(req, res, next) {
  try {
    const { page, limit, skip } = paginate(req.query);
    const { items, total } = await bomService.listBoms(req.factoryId, {
      status: req.query.status,
      skuId: req.query.skuId,
      search: req.query.search || req.query.q,
      page, limit, skip,
    });
    success(res, items, buildMeta(page, limit, total));
  } catch (e) { next(e); }
}

export async function get(req, res, next) {
  try {
    success(res, await bomService.getBom(req.params.id, req.factoryId));
  } catch (e) { next(e); }
}

export async function update(req, res, next) {
  try {
    success(res, await bomService.updateBom(req.params.id, req.factoryId, req.body, req.user._id));
  } catch (e) { next(e); }
}

export async function approve(req, res, next) {
  try {
    success(res, await bomService.approveBom(req.params.id, req.factoryId, req.user._id));
  } catch (e) { next(e); }
}

export async function finalize(req, res, next) {
  try {
    success(res, await bomService.finalizeBom(req.params.id, req.factoryId, req.user._id));
  } catch (e) { next(e); }
}

export async function mrpPreview(req, res, next) {
  try {
    const bom = await bomService.getBom(req.params.id, req.factoryId);
    const mrp = await mrpService.getMrpForBom(bom._id);
    success(res, mrp);
  } catch (e) { next(e); }
}

export async function activeForSku(req, res, next) {
  try {
    success(res, await bomService.getActiveBomForSku(req.params.skuId, req.factoryId));
  } catch (e) { next(e); }
}
