import Joi from 'joi';
import * as productionService from './production.service.js';
import { success, paginate, buildMeta } from '../../shared/utils/response.js';
import { getBatchStages } from '../../shared/utils/productionStages.js';
import {
  ORDER_STATUS_LIST, BATCH_STATUS_LIST, SCHEDULE_STATUS_LIST,
  PRIORITY_LIST, MACHINE_TYPE_LIST,
} from './production.defaults.js';

export const createOrderSchema = Joi.object({
  body: Joi.object({
    skuId: Joi.string().required(),
    plannedQuantity: Joi.number().greater(0).required(),
    priority: Joi.string().valid(...PRIORITY_LIST),
    deliveryDate: Joi.date(),
    plannedStart: Joi.date(),
    plannedEnd: Joi.date(),
  }),
});

export const updateOrderSchema = Joi.object({
  body: Joi.object({
    plannedQuantity: Joi.number().greater(0),
    priority: Joi.string().valid(...PRIORITY_LIST),
    deliveryDate: Joi.date().allow(null),
    plannedStart: Joi.date().allow(null),
    plannedEnd: Joi.date().allow(null),
  }).min(1),
});

export const createBatchSchema = Joi.object({
  body: Joi.object({
    plannedQuantity: Joi.number().greater(0),
    workerIds: Joi.array().items(Joi.string()),
    shiftId: Joi.string(),
    machineId: Joi.string(),
  }),
});

export const assignResourcesSchema = Joi.object({
  body: Joi.object({
    workerIds: Joi.array().items(Joi.string()),
    shiftId: Joi.string().allow(null),
    machineId: Joi.string().allow(null),
  }).min(1),
});

export const completeStageSchema = Joi.object({
  body: Joi.object({
    machineHours: Joi.number().min(0),
    labourHours: Joi.number().min(0),
    scrapMaterialId: Joi.string(),
    scrapQuantity: Joi.number().min(0),
    scrapUnit: Joi.string(),
    wasteType: Joi.string(),
  }),
});

export const createScheduleSchema = Joi.object({
  body: Joi.object({
    productionOrderId: Joi.string().required(),
    batchId: Joi.string(),
    stage: Joi.string(),
    productionLineId: Joi.string(),
    machineId: Joi.string(),
    shiftId: Joi.string(),
    workerIds: Joi.array().items(Joi.string()),
    plannedStart: Joi.date().required(),
    plannedEnd: Joi.date().required(),
    status: Joi.string().valid(...SCHEDULE_STATUS_LIST),
    notes: Joi.string().allow(''),
  }),
});

export const updateScheduleSchema = Joi.object({
  body: Joi.object({
    stage: Joi.string(),
    productionLineId: Joi.string().allow(null),
    machineId: Joi.string().allow(null),
    shiftId: Joi.string().allow(null),
    workerIds: Joi.array().items(Joi.string()),
    plannedStart: Joi.date(),
    plannedEnd: Joi.date(),
    status: Joi.string().valid(...SCHEDULE_STATUS_LIST),
    notes: Joi.string().allow(''),
    batchId: Joi.string().allow(null),
  }).min(1),
});

export const commentSchema = Joi.object({
  body: Joi.object({
    comments: Joi.string().trim().min(3).required(),
  }),
});

export async function catalog(req, res, next) {
  try {
    const stages = await getBatchStages(req.factoryId);
    success(res, {
      orderStatuses: ORDER_STATUS_LIST,
      batchStatuses: BATCH_STATUS_LIST,
      scheduleStatuses: SCHEDULE_STATUS_LIST,
      priorities: PRIORITY_LIST,
      machineTypes: MACHINE_TYPE_LIST,
      stages,
    });
  } catch (e) { next(e); }
}

export async function stats(req, res, next) {
  try {
    success(res, await productionService.getProductionStats(req.factoryId));
  } catch (e) { next(e); }
}

export async function capacity(req, res, next) {
  try {
    success(res, await productionService.getCapacitySummary(req.factoryId));
  } catch (e) { next(e); }
}

export async function listStages(req, res, next) {
  try {
    success(res, await getBatchStages(req.factoryId));
  } catch (e) { next(e); }
}

export async function createOrder(req, res, next) {
  try {
    const order = await productionService.createProductionOrder({
      ...req.body,
      factoryId: req.factoryId,
      organizationId: req.user.organizationId,
    }, req.user._id);
    success(res, order, null, 201);
  } catch (e) { next(e); }
}

export async function listOrders(req, res, next) {
  try {
    const { page, limit, skip } = paginate(req.query);
    const { items, total } = await productionService.listProductionOrders(req.factoryId, {
      page, limit, skip,
      status: req.query.status,
      priority: req.query.priority,
      search: req.query.search,
    });
    success(res, items, buildMeta(page, limit, total));
  } catch (e) { next(e); }
}

export async function getOrder(req, res, next) {
  try {
    success(res, await productionService.getProductionOrder(req.params.id, req.factoryId));
  } catch (e) { next(e); }
}

export async function updateOrder(req, res, next) {
  try {
    success(res, await productionService.updateProductionOrder(req.params.id, req.body, req.user._id, req.factoryId));
  } catch (e) { next(e); }
}

export async function cancelOrder(req, res, next) {
  try {
    success(res, await productionService.cancelProductionOrder(req.params.id, req.user._id, req.factoryId));
  } catch (e) { next(e); }
}

export async function runMrp(req, res, next) {
  try {
    success(res, await productionService.runProductionMrp(req.params.id, req.user._id, req.factoryId));
  } catch (e) { next(e); }
}

export async function reserveMaterials(req, res, next) {
  try {
    success(res, await productionService.reserveProductionMaterials(req.params.id, req.user._id, req.factoryId));
  } catch (e) { next(e); }
}

export async function submitApproval(req, res, next) {
  try {
    success(res, await productionService.submitProductionOrderForApproval(req.params.id, req.user._id, req.factoryId));
  } catch (e) { next(e); }
}

export async function approveOrder(req, res, next) {
  try {
    success(res, await productionService.approveProductionOrder(req.params.id, req.user._id, { syncApproval: true, factoryId: req.factoryId }));
  } catch (e) { next(e); }
}

export async function rejectOrder(req, res, next) {
  try {
    success(res, await productionService.rejectProductionOrder(req.params.id, req.user._id, req.body.comments, { syncApproval: true, factoryId: req.factoryId }));
  } catch (e) { next(e); }
}

export async function createBatch(req, res, next) {
  try {
    const batch = await productionService.createBatch({
      productionOrderId: req.params.id,
      ...req.body,
    }, req.user._id, req.factoryId);
    success(res, batch, null, 201);
  } catch (e) { next(e); }
}

export async function listBatches(req, res, next) {
  try {
    const { page, limit, skip } = paginate(req.query);
    const { items, total } = await productionService.listBatches(req.factoryId, {
      page, limit, skip,
      status: req.query.status,
      stage: req.query.stage,
      search: req.query.search,
      productionOrderId: req.query.productionOrderId,
    });
    success(res, items, buildMeta(page, limit, total));
  } catch (e) { next(e); }
}

export async function batchBoard(req, res, next) {
  try {
    success(res, await productionService.getBatchBoard(req.factoryId));
  } catch (e) { next(e); }
}

export async function getBatch(req, res, next) {
  try {
    success(res, await productionService.getBatch(req.params.id, req.factoryId));
  } catch (e) { next(e); }
}

export async function assignResources(req, res, next) {
  try {
    success(res, await productionService.assignBatchResources(req.params.id, req.body, req.user._id, req.factoryId));
  } catch (e) { next(e); }
}

export async function startBatch(req, res, next) {
  try {
    success(res, await productionService.startBatch(req.params.id, req.user._id, req.factoryId));
  } catch (e) { next(e); }
}

export async function completeStage(req, res, next) {
  try {
    success(res, await productionService.completeBatchStage(req.params.id, req.user._id, {
      machineHours: req.body.machineHours,
      labourHours: req.body.labourHours,
      scrapMaterialId: req.body.scrapMaterialId,
      scrapQuantity: req.body.scrapQuantity,
      scrapUnit: req.body.scrapUnit,
      wasteType: req.body.wasteType,
    }, req.factoryId));
  } catch (e) { next(e); }
}

export async function rollbackStage(req, res, next) {
  try {
    success(res, await productionService.rollbackBatchStage(req.params.id, req.user._id, req.factoryId));
  } catch (e) { next(e); }
}

export async function createSchedule(req, res, next) {
  try {
    success(res, await productionService.createSchedule(req.body, req.user._id), null, 201);
  } catch (e) { next(e); }
}

export async function listSchedules(req, res, next) {
  try {
    const { page, limit, skip } = paginate(req.query);
    const { items, total } = await productionService.listSchedules(req.factoryId, {
      page, limit, skip,
      from: req.query.from,
      to: req.query.to,
      productionOrderId: req.query.productionOrderId,
      status: req.query.status,
    });
    success(res, items, buildMeta(page, limit, total));
  } catch (e) { next(e); }
}

export async function updateSchedule(req, res, next) {
  try {
    success(res, await productionService.updateSchedule(req.params.id, req.body, req.user._id, req.factoryId));
  } catch (e) { next(e); }
}
