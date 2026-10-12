import { Machine } from './machine.model.js';
import { ProductionLine } from './productionLine.model.js';
import { Shift } from './shift.model.js';
import { ProductionBatch } from './productionBatch.model.js';
import { NotFoundError, ConflictError, ValidationError } from '../../shared/errors/AppError.js';
import { applySoftDeleteFilter, escapeRegex, queryString } from '../../shared/utils/schema.js';

/** Server-owned fields a client must never set on create. */
const SERVER_FIELDS = ['_id', 'isDeleted', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'organizationId', 'factoryId', '__v'];

function stripServerFields(data = {}) {
  const out = { ...data };
  for (const key of SERVER_FIELDS) delete out[key];
  return out;
}

async function assertLineInFactory(productionLineId, factoryId) {
  if (!productionLineId) return;
  const exists = await ProductionLine.exists({ _id: productionLineId, factoryId, isDeleted: false });
  if (!exists) throw new NotFoundError('Production line not found');
}

export async function createMachine(data, userId) {
  const { factoryId, organizationId } = data;
  const body = stripServerFields(data);
  const existing = await Machine.findOne(applySoftDeleteFilter({
    factoryId,
    machineCode: body.machineCode,
  }));
  if (existing) throw new ConflictError('Machine code already exists');
  await assertLineInFactory(body.productionLineId, factoryId);
  return Machine.create({ ...body, factoryId, organizationId, createdBy: userId, updatedBy: userId });
}

export async function listMachines(factoryId, { page, limit, skip, search, status, machineType }) {
  const filter = applySoftDeleteFilter({ factoryId });
  const statusQ = queryString(status);
  const typeQ = queryString(machineType);
  const searchQ = queryString(search)?.trim();
  if (statusQ) filter.status = statusQ;
  if (typeQ) filter.machineType = typeQ;
  if (searchQ) {
    const re = new RegExp(escapeRegex(searchQ), 'i');
    filter.$or = [{ machineCode: re }, { name: re }];
  }
  const [items, total] = await Promise.all([
    Machine.find(filter).populate('productionLineId', 'name lineCode').skip(skip).limit(limit).sort({ machineCode: 1 }),
    Machine.countDocuments(filter),
  ]);
  return { items, total };
}

export async function getMachine(id, factoryId) {
  const filter = applySoftDeleteFilter({ _id: id });
  if (factoryId) filter.factoryId = factoryId;
  const m = await Machine.findOne(filter).populate('productionLineId', 'name lineCode');
  if (!m) throw new NotFoundError('Machine not found');
  return m;
}

export async function updateMachine(id, data, userId, factoryId) {
  const machine = await getMachine(id, factoryId);
  if (data.productionLineId) await assertLineInFactory(data.productionLineId, machine.factoryId);
  const allowed = ['name', 'machineType', 'productionLineId', 'capacityPerHour', 'status'];
  for (const key of allowed) {
    if (data[key] !== undefined) machine[key] = data[key];
  }
  machine.updatedBy = userId;
  await machine.save();
  return machine;
}

export async function createProductionLine(data, userId) {
  const { factoryId, organizationId } = data;
  const body = stripServerFields(data);
  const existing = await ProductionLine.findOne(applySoftDeleteFilter({
    factoryId,
    lineCode: body.lineCode,
  }));
  if (existing) throw new ConflictError('Line code already exists');
  return ProductionLine.create({ ...body, factoryId, organizationId, createdBy: userId, updatedBy: userId });
}

export async function updateProductionLine(id, data, userId, factoryId) {
  const line = await ProductionLine.findOne(applySoftDeleteFilter({ _id: id, factoryId }));
  if (!line) throw new NotFoundError('Production line not found');
  for (const key of ['name', 'stages', 'capacityPerDay', 'status']) {
    if (data[key] !== undefined) line[key] = data[key];
  }
  line.updatedBy = userId;
  await line.save();
  return line;
}

export async function listProductionLines(factoryId, { page, limit, skip } = {}) {
  const filter = applySoftDeleteFilter({ factoryId });
  if (page && limit !== undefined && skip !== undefined) {
    const [items, total] = await Promise.all([
      ProductionLine.find(filter).skip(skip).limit(limit).sort({ lineCode: 1 }),
      ProductionLine.countDocuments(filter),
    ]);
    return { items, total };
  }
  return ProductionLine.find(filter).sort({ lineCode: 1 });
}

export async function createShift(data, userId) {
  const { factoryId, organizationId } = data;
  const body = stripServerFields(data);
  return Shift.create({ ...body, factoryId, organizationId, createdBy: userId, updatedBy: userId });
}

export async function updateShift(id, data, userId, factoryId) {
  const shift = await Shift.findOne(applySoftDeleteFilter({ _id: id, factoryId }));
  if (!shift) throw new NotFoundError('Shift not found');
  for (const key of ['name', 'startTime', 'endTime', 'isActive']) {
    if (data[key] !== undefined) shift[key] = data[key];
  }
  shift.updatedBy = userId;
  await shift.save();
  return shift;
}

export async function listShifts(factoryId) {
  return Shift.find(applySoftDeleteFilter({ factoryId })).sort({ startTime: 1 });
}

export async function getCapacitySummary(factoryId) {
  const machines = await Machine.find({ factoryId, status: 'ACTIVE', isDeleted: false });
  const lines = await ProductionLine.find({ factoryId, status: 'ACTIVE', isDeleted: false });
  const totalCapacity = machines.reduce((s, m) => s + (m.capacityPerHour || 0), 0);
  const batchesInProgress = await ProductionBatch.countDocuments({ factoryId, status: 'IN_PROGRESS', isDeleted: false });
  return { machineCount: machines.length, lineCount: lines.length, totalCapacityPerHour: totalCapacity, batchesInProgress };
}

export async function assignMachineToBatch(batchId, machineId, userId, factoryId) {
  const filter = applySoftDeleteFilter({ _id: batchId });
  if (factoryId) filter.factoryId = factoryId;
  const batch = await ProductionBatch.findOne(filter);
  if (!batch) throw new NotFoundError('Batch not found');
  if (['COMPLETED', 'CANCELLED'].includes(batch.status)) {
    throw new ConflictError(`Cannot assign a machine to a ${batch.status.toLowerCase()} batch`);
  }
  if (!machineId) throw new ValidationError('machineId is required');
  await getMachine(machineId, batch.factoryId);
  batch.machineId = machineId;
  batch.updatedBy = userId;
  await batch.save();
  return batch;
}
