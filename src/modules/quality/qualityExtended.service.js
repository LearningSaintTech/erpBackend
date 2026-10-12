import { DefectCategory } from './defectCategory.model.js';
import { Defect } from './defect.model.js';
import { InspectionTemplate } from './inspectionTemplate.model.js';
import { CapaRecord } from './capaRecord.model.js';
import { QualityInspection } from './qualityInspection.model.js';
import { ProductionBatch } from '../production/productionBatch.model.js';
import { Factory } from '../organization/factory.model.js';
import { nextDocumentNumber } from '../../shared/utils/numbering.js';
import { NotFoundError, ConflictError } from '../../shared/errors/AppError.js';
import { applySoftDeleteFilter } from '../../shared/utils/schema.js';
import * as qualityService from './quality.service.js';

/** Server-owned fields a client must never set on create. */
const SERVER_FIELDS = ['_id', 'isDeleted', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'organizationId', 'factoryId', '__v'];

function stripServerFields(data = {}) {
  const out = { ...data };
  for (const key of SERVER_FIELDS) delete out[key];
  return out;
}

async function assertInFactory(Model, id, factoryId, label) {
  if (!id) return;
  const exists = await Model.exists({ _id: id, factoryId, isDeleted: false });
  if (!exists) throw new NotFoundError(`${label} not found`);
}

export async function createDefectCategory(data, userId) {
  const { factoryId, organizationId } = data;
  const body = stripServerFields(data);
  const existing = await DefectCategory.findOne(applySoftDeleteFilter({
    factoryId,
    code: body.code,
  }));
  if (existing) throw new ConflictError('Defect category code already exists');
  return DefectCategory.create({ ...body, factoryId, organizationId, createdBy: userId, updatedBy: userId });
}

export async function listDefectCategories(factoryId) {
  return DefectCategory.find(applySoftDeleteFilter({ factoryId })).sort({ code: 1 });
}

export async function createInspectionTemplate(data, userId) {
  const { factoryId, organizationId } = data;
  const body = stripServerFields(data);
  return InspectionTemplate.create({ ...body, factoryId, organizationId, createdBy: userId, updatedBy: userId });
}

export async function listInspectionTemplates(factoryId, inspectionType) {
  const filter = applySoftDeleteFilter({ factoryId, isActive: true });
  if (inspectionType) filter.inspectionType = inspectionType;
  return InspectionTemplate.find(filter).sort({ name: 1 });
}

export async function createInProcessInspection(batchId, userId, factoryId) {
  const batchFilter = applySoftDeleteFilter({ _id: batchId });
  if (factoryId) batchFilter.factoryId = factoryId;
  const batch = await ProductionBatch.findOne(batchFilter);
  if (!batch) throw new NotFoundError('Batch not found');
  if (!['IN_PROGRESS', 'REWORK'].includes(batch.status)) {
    throw new ConflictError('Batch must be in progress');
  }

  // One open in-process inspection per batch + stage: reuse it instead of stacking duplicates.
  const openFilter = applySoftDeleteFilter({
    factoryId: batch.factoryId,
    inspectionType: 'IN_PROCESS',
    referenceType: 'PRODUCTION_BATCH',
    referenceId: batch._id,
    stageAtInspection: batch.currentStage,
    status: { $in: ['PENDING', 'IN_PROGRESS'] },
  });
  const existing = await QualityInspection.findOne(openFilter).sort({ createdAt: 1, _id: 1 });
  if (existing) return existing;

  const factory = await Factory.findById(batch.factoryId);
  const inspectionNumber = await nextDocumentNumber(batch.factoryId, 'QC', `QC-${factory.code}-`);

  const created = await qualityService.createInspectionRecord({
    organizationId: batch.organizationId,
    factoryId: batch.factoryId,
    inspectionNumber,
    inspectionType: 'IN_PROCESS',
    referenceType: 'PRODUCTION_BATCH',
    referenceId: batch._id,
    stageAtInspection: batch.currentStage,
    userId,
  });

  // Concurrent requests may each have created one — the oldest wins, later PENDING ones are dropped.
  const open = await QualityInspection.find(openFilter).sort({ createdAt: 1, _id: 1 });
  const winner = open[0] || created;
  const losers = open.slice(1).map((i) => i._id);
  if (losers.length) {
    await QualityInspection.updateMany(
      { _id: { $in: losers }, status: 'PENDING' },
      { $set: { isDeleted: true, updatedBy: userId } },
    );
  }
  return winner;
}

export async function recordDefect({ inspectionId, categoryId, description, quantity, severity }, userId, factoryId) {
  const inspection = await qualityService.getInspection(inspectionId, factoryId);
  if (inspection.status === 'COMPLETED') throw new ConflictError('Cannot add defects to completed inspection');
  await assertInFactory(DefectCategory, categoryId, inspection.factoryId, 'Defect category');
  return Defect.create({
    organizationId: inspection.organizationId,
    factoryId: inspection.factoryId,
    inspectionId,
    categoryId,
    description,
    quantity,
    severity,
    createdBy: userId,
    updatedBy: userId,
  });
}

export async function listDefectsForInspection(inspectionId, factoryId) {
  await qualityService.getInspection(inspectionId, factoryId);
  return Defect.find({ inspectionId, isDeleted: false })
    .populate('categoryId', 'code name severity')
    .sort({ createdAt: -1 });
}

export async function createCapa({ factoryId, organizationId, inspectionId, defectId, type, description, rootCause, actionPlan, dueDate }, userId) {
  await assertInFactory(QualityInspection, inspectionId, factoryId, 'Inspection');
  await assertInFactory(Defect, defectId, factoryId, 'Defect');
  const factory = await Factory.findById(factoryId);
  const capaNumber = await nextDocumentNumber(factoryId, 'CAPA', `CAPA-${factory.code}-`);
  return CapaRecord.create({
    organizationId,
    factoryId,
    capaNumber,
    inspectionId,
    defectId,
    type,
    description,
    rootCause,
    actionPlan,
    dueDate,
    createdBy: userId,
    updatedBy: userId,
  });
}

export async function getCapa(id, factoryId) {
  const filter = applySoftDeleteFilter({ _id: id });
  if (factoryId) filter.factoryId = factoryId;
  const capa = await CapaRecord.findOne(filter)
    .populate('inspectionId', 'inspectionNumber inspectionType');
  if (!capa) throw new NotFoundError('CAPA not found');
  return capa;
}

export async function updateCapa(id, data, userId, factoryId) {
  const capa = await getCapa(id, factoryId);
  if (capa.status === 'CLOSED') throw new ConflictError('CAPA is closed');
  const allowed = ['description', 'rootCause', 'actionPlan', 'dueDate', 'status'];
  for (const key of allowed) {
    if (data[key] !== undefined) capa[key] = data[key];
  }
  capa.updatedBy = userId;
  await capa.save();
  return capa;
}

export async function listCapaRecords(factoryId, { page, limit, skip, status }) {
  const filter = applySoftDeleteFilter({ factoryId });
  if (status) filter.status = status;
  const [items, total] = await Promise.all([
    CapaRecord.find(filter)
      .populate('inspectionId', 'inspectionNumber')
      .skip(skip)
      .limit(limit)
      .sort({ createdAt: -1 }),
    CapaRecord.countDocuments(filter),
  ]);
  return { items, total };
}

export async function closeCapa(id, userId, factoryId) {
  const capa = await getCapa(id, factoryId);
  capa.status = 'CLOSED';
  capa.updatedBy = userId;
  await capa.save();
  return capa;
}
