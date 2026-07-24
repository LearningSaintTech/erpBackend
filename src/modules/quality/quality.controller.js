import Joi from 'joi';
import * as qualityService from './quality.service.js';
import * as qualityExtended from './qualityExtended.service.js';
import { success, paginate, buildMeta } from '../../shared/utils/response.js';
import {
  INSPECTION_TYPES, TEMPLATE_TYPES, DISPOSITION_LIST, CAPA_TYPES,
  DEFECT_SEVERITY_LIST,
} from './quality.defaults.js';

export const completeInspectionSchema = Joi.object({
  body: Joi.object({
    passedQuantity: Joi.number().min(0),
    failedQuantity: Joi.number().min(0),
    result: Joi.string().valid('PASS', 'FAIL', 'PARTIAL', 'REWORK', 'REJECT'),
    disposition: Joi.string().valid(...DISPOSITION_LIST),
    storageBinId: Joi.string(),
    autoDispatchReady: Joi.boolean(),
    notes: Joi.string().allow(''),
  }),
});

export const createFinalSchema = Joi.object({
  body: Joi.object({
    storageBinId: Joi.string(),
    autoDispatchReady: Joi.boolean(),
  }),
});

export const recordDefectSchema = Joi.object({
  body: Joi.object({
    categoryId: Joi.string(),
    description: Joi.string().allow(''),
    quantity: Joi.number().greater(0).required(),
    severity: Joi.string().valid(...DEFECT_SEVERITY_LIST),
  }),
});

export const createCategorySchema = Joi.object({
  body: Joi.object({
    code: Joi.string().trim().min(2).required(),
    name: Joi.string().trim().min(2).required(),
    severity: Joi.string().valid(...DEFECT_SEVERITY_LIST),
  }),
});

export const createTemplateSchema = Joi.object({
  body: Joi.object({
    name: Joi.string().trim().min(2).required(),
    inspectionType: Joi.string().valid(...TEMPLATE_TYPES).required(),
    checklist: Joi.array().items(Joi.object({
      item: Joi.string().required(),
      required: Joi.boolean(),
    })),
    isActive: Joi.boolean(),
  }),
});

export const createCapaSchema = Joi.object({
  body: Joi.object({
    type: Joi.string().valid(...CAPA_TYPES).required(),
    description: Joi.string().trim().min(3).required(),
    inspectionId: Joi.string(),
    defectId: Joi.string(),
    rootCause: Joi.string().allow(''),
    actionPlan: Joi.string().allow(''),
    dueDate: Joi.date(),
  }),
});

export const updateCapaSchema = Joi.object({
  body: Joi.object({
    description: Joi.string().trim().min(3),
    rootCause: Joi.string().allow(''),
    actionPlan: Joi.string().allow(''),
    dueDate: Joi.date().allow(null),
    status: Joi.string().valid('OPEN', 'IN_PROGRESS', 'CLOSED'),
  }).min(1),
});

export async function catalog(req, res, next) {
  try {
    success(res, {
      inspectionTypes: INSPECTION_TYPES,
      templateTypes: TEMPLATE_TYPES,
      dispositions: DISPOSITION_LIST,
      capaTypes: CAPA_TYPES,
      defectSeverities: DEFECT_SEVERITY_LIST,
    });
  } catch (e) { next(e); }
}

export async function stats(req, res, next) {
  try {
    success(res, await qualityService.getQualityStats(req.factoryId));
  } catch (e) { next(e); }
}

export async function queue(req, res, next) {
  try {
    success(res, await qualityService.getInspectionQueue(req.factoryId));
  } catch (e) { next(e); }
}

export async function listInspections(req, res, next) {
  try {
    const { page, limit, skip } = paginate(req.query);
    const { items, total } = await qualityService.listInspections(req.factoryId, {
      page, limit, skip,
      status: req.query.status,
      inspectionType: req.query.inspectionType,
      search: req.query.search,
    });
    success(res, items, buildMeta(page, limit, total));
  } catch (e) { next(e); }
}

export async function getInspection(req, res, next) {
  try {
    success(res, await qualityService.getInspection(req.params.id, req.factoryId));
  } catch (e) { next(e); }
}

export async function incomingQcContext(req, res, next) {
  try {
    success(res, await qualityService.getIncomingQcContext(req.params.id, req.factoryId));
  } catch (e) { next(e); }
}

export async function createIncoming(req, res, next) {
  try {
    success(res, await qualityService.createIncomingInspection(req.params.id, req.user._id), null, 201);
  } catch (e) { next(e); }
}

export async function createFinal(req, res, next) {
  try {
    success(res, await qualityService.createFinalInspection(req.params.id, req.user._id, req.body), null, 201);
  } catch (e) { next(e); }
}

export async function createInProcess(req, res, next) {
  try {
    success(res, await qualityExtended.createInProcessInspection(req.params.id, req.user._id), null, 201);
  } catch (e) { next(e); }
}

export async function startInspection(req, res, next) {
  try {
    success(res, await qualityService.startInspection(req.params.id, req.user._id, req.factoryId));
  } catch (e) { next(e); }
}

export async function completeInspection(req, res, next) {
  try {
    success(res, await qualityService.completeInspection(req.params.id, req.body, req.user._id, req.factoryId));
  } catch (e) { next(e); }
}

export async function listDefectCategories(req, res, next) {
  try {
    success(res, await qualityExtended.listDefectCategories(req.factoryId));
  } catch (e) { next(e); }
}

export async function createDefectCategory(req, res, next) {
  try {
    success(res, await qualityExtended.createDefectCategory({
      ...req.body,
      factoryId: req.factoryId,
      organizationId: req.user.organizationId,
    }, req.user._id), null, 201);
  } catch (e) { next(e); }
}

export async function listTemplates(req, res, next) {
  try {
    success(res, await qualityExtended.listInspectionTemplates(req.factoryId, req.query.type));
  } catch (e) { next(e); }
}

export async function createTemplate(req, res, next) {
  try {
    success(res, await qualityExtended.createInspectionTemplate({
      ...req.body,
      factoryId: req.factoryId,
      organizationId: req.user.organizationId,
    }, req.user._id), null, 201);
  } catch (e) { next(e); }
}

export async function recordDefect(req, res, next) {
  try {
    success(res, await qualityExtended.recordDefect({
      inspectionId: req.params.id,
      ...req.body,
    }, req.user._id, req.factoryId), null, 201);
  } catch (e) { next(e); }
}

export async function listDefects(req, res, next) {
  try {
    success(res, await qualityExtended.listDefectsForInspection(req.params.id, req.factoryId));
  } catch (e) { next(e); }
}

export async function listCapa(req, res, next) {
  try {
    const { page, limit, skip } = paginate(req.query);
    const { items, total } = await qualityExtended.listCapaRecords(req.factoryId, {
      page, limit, skip,
      status: req.query.status,
    });
    success(res, items, buildMeta(page, limit, total));
  } catch (e) { next(e); }
}

export async function getCapa(req, res, next) {
  try {
    success(res, await qualityExtended.getCapa(req.params.id, req.factoryId));
  } catch (e) { next(e); }
}

export async function createCapa(req, res, next) {
  try {
    success(res, await qualityExtended.createCapa({
      ...req.body,
      factoryId: req.factoryId,
      organizationId: req.user.organizationId,
    }, req.user._id), null, 201);
  } catch (e) { next(e); }
}

export async function updateCapa(req, res, next) {
  try {
    success(res, await qualityExtended.updateCapa(req.params.id, req.body, req.user._id, req.factoryId));
  } catch (e) { next(e); }
}

export async function closeCapa(req, res, next) {
  try {
    success(res, await qualityExtended.closeCapa(req.params.id, req.user._id, req.factoryId));
  } catch (e) { next(e); }
}

export async function pendingWork(req, res, next) {
  try {
    success(res, await qualityService.getPendingWork(req.factoryId));
  } catch (e) { next(e); }
}
