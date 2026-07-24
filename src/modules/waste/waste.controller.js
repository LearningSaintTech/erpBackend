import Joi from 'joi';
import * as wasteService from './waste.service.js';
import { success, paginate, buildMeta } from '../../shared/utils/response.js';
import {
  WASTE_TYPES, RECOVERY_ACTIONS, WASTE_STATUS_LIST, REASON_CODES, WASTE_TYPE_LABELS,
} from './waste.defaults.js';

export const createSchema = Joi.object({
  body: Joi.object({
    wasteType: Joi.string().valid(...WASTE_TYPES).required(),
    quantity: Joi.number().greater(0).required(),
    unit: Joi.string().trim(),
    batchId: Joi.string(),
    materialId: Joi.string(),
    skuId: Joi.string(),
    stage: Joi.string().allow(''),
    reasonCode: Joi.string().valid(...REASON_CODES),
    unitCost: Joi.number().min(0),
  }),
});

export const recoverySchema = Joi.object({
  body: Joi.object({
    recoveryAction: Joi.string().valid(...RECOVERY_ACTIONS.filter((a) => a !== 'NONE')).required(),
  }),
});

export async function catalog(req, res, next) {
  try {
    success(res, {
      wasteTypes: WASTE_TYPES,
      wasteTypeLabels: WASTE_TYPE_LABELS,
      recoveryActions: RECOVERY_ACTIONS,
      statuses: WASTE_STATUS_LIST,
      reasonCodes: REASON_CODES,
    });
  } catch (e) { next(e); }
}

export async function stats(req, res, next) {
  try {
    success(res, await wasteService.getWasteStats(req.factoryId));
  } catch (e) { next(e); }
}

export async function summary(req, res, next) {
  try {
    success(res, await wasteService.getWasteSummary(req.factoryId));
  } catch (e) { next(e); }
}

export async function create(req, res, next) {
  try {
    success(res, await wasteService.createWasteRecord({
      ...req.body,
      factoryId: req.factoryId,
      organizationId: req.user.organizationId,
    }, req.user._id), null, 201);
  } catch (e) { next(e); }
}

export async function list(req, res, next) {
  try {
    const { page, limit, skip } = paginate(req.query);
    const { items, total } = await wasteService.listWasteRecords(req.factoryId, {
      page, limit, skip,
      search: req.query.search,
      wasteType: req.query.wasteType,
      status: req.query.status,
      from: req.query.from,
      to: req.query.to,
    });
    success(res, items, buildMeta(page, limit, total));
  } catch (e) { next(e); }
}

export async function get(req, res, next) {
  try {
    success(res, await wasteService.getWasteRecord(req.params.id, req.factoryId));
  } catch (e) { next(e); }
}

export async function recovery(req, res, next) {
  try {
    success(res, await wasteService.recordRecovery(req.params.id, req.body, req.user._id, req.factoryId));
  } catch (e) { next(e); }
}

export async function exportCsv(req, res, next) {
  try {
    const csv = await wasteService.exportWasteCsv(req.factoryId, {
      search: req.query.search,
      wasteType: req.query.wasteType,
      status: req.query.status,
      from: req.query.from,
      to: req.query.to,
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="waste-records.csv"');
    res.send(csv);
  } catch (e) { next(e); }
}
