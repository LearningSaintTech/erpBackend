import Joi from 'joi';
import * as machineService from './machine.service.js';
import { success, paginate, buildMeta } from '../../shared/utils/response.js';
import { MACHINE_STATUS_LIST, MACHINE_TYPE_LIST, LINE_STATUS_LIST } from './production.defaults.js';

export const createMachineSchema = Joi.object({
  body: Joi.object({
    machineCode: Joi.string().trim().min(2).required(),
    name: Joi.string().trim().min(2).required(),
    machineType: Joi.string().valid(...MACHINE_TYPE_LIST),
    productionLineId: Joi.string(),
    capacityPerHour: Joi.number().min(0),
    status: Joi.string().valid(...MACHINE_STATUS_LIST),
  }),
});

export const updateMachineSchema = Joi.object({
  body: Joi.object({
    name: Joi.string().trim().min(2),
    machineType: Joi.string().valid(...MACHINE_TYPE_LIST),
    productionLineId: Joi.string().allow(null),
    capacityPerHour: Joi.number().min(0),
    status: Joi.string().valid(...MACHINE_STATUS_LIST),
  }).min(1),
});

export const createLineSchema = Joi.object({
  body: Joi.object({
    lineCode: Joi.string().trim().min(2).required(),
    name: Joi.string().trim().min(2).required(),
    stages: Joi.array().items(Joi.string()),
    capacityPerDay: Joi.number().min(0),
    status: Joi.string().valid(...LINE_STATUS_LIST),
  }),
});

export const createShiftSchema = Joi.object({
  body: Joi.object({
    name: Joi.string().trim().min(2).required(),
    startTime: Joi.string().required(),
    endTime: Joi.string().required(),
    isActive: Joi.boolean(),
  }),
});

export async function createMachine(req, res, next) {
  try {
    const m = await machineService.createMachine({
      ...req.body,
      factoryId: req.factoryId,
      organizationId: req.user.organizationId,
    }, req.user._id);
    success(res, m, null, 201);
  } catch (e) { next(e); }
}

export async function listMachines(req, res, next) {
  try {
    const { page, limit, skip } = paginate(req.query);
    const { items, total } = await machineService.listMachines(req.factoryId, {
      page, limit, skip,
      search: req.query.search,
      status: req.query.status,
      machineType: req.query.machineType,
    });
    success(res, items, buildMeta(page, limit, total));
  } catch (e) { next(e); }
}

export async function getMachine(req, res, next) {
  try {
    success(res, await machineService.getMachine(req.params.id, req.factoryId));
  } catch (e) { next(e); }
}

export async function updateMachine(req, res, next) {
  try {
    success(res, await machineService.updateMachine(req.params.id, req.body, req.user._id, req.factoryId));
  } catch (e) { next(e); }
}

export async function createLine(req, res, next) {
  try {
    const line = await machineService.createProductionLine({
      ...req.body,
      factoryId: req.factoryId,
      organizationId: req.user.organizationId,
    }, req.user._id);
    success(res, line, null, 201);
  } catch (e) { next(e); }
}

export async function listLines(req, res, next) {
  try {
    const { page, limit, skip } = paginate(req.query);
    const { items, total } = await machineService.listProductionLines(req.factoryId, { page, limit, skip });
    success(res, items, buildMeta(page, limit, total));
  } catch (e) { next(e); }
}

export async function createShift(req, res, next) {
  try {
    const shift = await machineService.createShift({
      ...req.body,
      factoryId: req.factoryId,
      organizationId: req.user.organizationId,
    }, req.user._id);
    success(res, shift, null, 201);
  } catch (e) { next(e); }
}

export async function listShifts(req, res, next) {
  try {
    success(res, await machineService.listShifts(req.factoryId));
  } catch (e) { next(e); }
}

export async function assignMachineToBatch(req, res, next) {
  try {
    success(res, await machineService.assignMachineToBatch(req.params.id, req.body.machineId, req.user._id, req.factoryId));
  } catch (e) { next(e); }
}
