import { Machine } from './machine.model.js';
import { ProductionLine } from './productionLine.model.js';
import { Shift } from './shift.model.js';
import { ProductionBatch } from './productionBatch.model.js';
import { NotFoundError, ConflictError } from '../../shared/errors/AppError.js';
import { applySoftDeleteFilter } from '../../shared/utils/schema.js';

export async function createMachine(data, userId) {
  const existing = await Machine.findOne(applySoftDeleteFilter({
    factoryId: data.factoryId,
    machineCode: data.machineCode,
  }));
  if (existing) throw new ConflictError('Machine code already exists');
  return Machine.create({ ...data, createdBy: userId, updatedBy: userId });
}

export async function listMachines(factoryId, { page, limit, skip, search, status, machineType }) {
  const filter = applySoftDeleteFilter({ factoryId });
  if (status) filter.status = status;
  if (machineType) filter.machineType = machineType;
  if (search) {
    const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
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
  const allowed = ['name', 'machineType', 'productionLineId', 'capacityPerHour', 'status'];
  for (const key of allowed) {
    if (data[key] !== undefined) machine[key] = data[key];
  }
  machine.updatedBy = userId;
  await machine.save();
  return machine;
}

export async function createProductionLine(data, userId) {
  const existing = await ProductionLine.findOne(applySoftDeleteFilter({
    factoryId: data.factoryId,
    lineCode: data.lineCode,
  }));
  if (existing) throw new ConflictError('Line code already exists');
  return ProductionLine.create({ ...data, createdBy: userId, updatedBy: userId });
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
  return Shift.create({ ...data, createdBy: userId, updatedBy: userId });
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
  await getMachine(machineId, factoryId);
  batch.machineId = machineId;
  batch.updatedBy = userId;
  await batch.save();
  return batch;
}
