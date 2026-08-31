import { Sample } from './sample.model.js';
import { Design } from '../design/design.model.js';
import { Factory } from '../organization/factory.model.js';
import { Material } from '../inventory/material.model.js';
import { PatternDevelopment } from '../pattern/pattern.model.js';
import * as inventoryService from '../inventory/inventory.service.js';
import { submitForApproval } from '../approval/approval.service.js';
import {
  syncApprovalApproved,
  syncApprovalRejected,
  syncApprovalRevisionRequested,
} from '../../shared/services/approvalSync.js';
import { nextDocumentNumber } from '../../shared/utils/numbering.js';
import { NotFoundError, ConflictError, ValidationError, ForbiddenError } from '../../shared/errors/AppError.js';
import { applySoftDeleteFilter } from '../../shared/utils/schema.js';
import { notify } from '../notification/notification.service.js';
import { reopenPatternForFit, getPatternTechPack } from '../pattern/pattern.service.js';
import { SAMPLE_TERMINAL_STATUSES, sampleNeedsFitTrial } from './sample.defaults.js';
import { UserRoleAssignment } from '../user/userRoleAssignment.model.js';
import { QualityInspection } from '../quality/qualityInspection.model.js';

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SAMPLE_POPULATE = [
  { path: 'designId', select: 'designCode title styleNumber status' },
  { path: 'materialRequirements.materialId', select: 'materialCode name unit unitCost' },
  { path: 'createdBy', select: 'firstName lastName email' },
  { path: 'approvedBy', select: 'firstName lastName email' },
  { path: 'qcInspectionId', select: 'inspectionNumber status result disposition' },
];

async function populateSample(doc) {
  if (!doc) return doc;
  return Sample.findById(doc._id).populate(SAMPLE_POPULATE);
}

function recordTimeline(sample, { action, fromStatus, toStatus, userId, note }) {
  if (!sample.timeline) sample.timeline = [];
  sample.timeline.push({
    at: new Date(),
    action,
    fromStatus: fromStatus ?? sample.status,
    toStatus: toStatus ?? sample.status,
    userId,
    note: note || '',
  });
}

function setSampleStatus(sample, nextStatus, userId, action, note) {
  const fromStatus = sample.status;
  sample.status = nextStatus;
  recordTimeline(sample, { action, fromStatus, toStatus: nextStatus, userId, note });
}

async function notifyUsersWithPermission({
  organizationId,
  factoryId,
  permission,
  excludeUserId,
  eventType,
  title,
  message,
  referenceType,
  referenceId,
}) {
  const assignments = await UserRoleAssignment.find({ factoryId, organizationId })
    .populate('roleId', 'permissions');
  const notified = new Set();
  for (const a of assignments) {
    const uid = String(a.userId);
    if (excludeUserId && uid === String(excludeUserId)) continue;
    if (notified.has(uid)) continue;
    const perms = a.roleId?.permissions || [];
    if (!perms.includes('*') && !perms.includes(permission)) continue;
    notified.add(uid);
    await notify({
      organizationId,
      factoryId,
      userId: a.userId,
      eventType,
      title,
      message,
      referenceType,
      referenceId,
    });
  }
}

async function syncSampleInspectionResult(sample, userId, passed) {
  const inspection = await QualityInspection.findOne(applySoftDeleteFilter({
    factoryId: sample.factoryId,
    referenceType: 'SAMPLE',
    referenceId: sample._id,
    status: { $in: ['PENDING', 'IN_PROGRESS'] },
  }));
  if (!inspection) return;
  inspection.status = 'COMPLETED';
  inspection.result = passed ? 'PASS' : 'FAIL';
  inspection.disposition = passed ? 'PASS' : 'REJECT';
  inspection.passedQuantity = passed ? 1 : 0;
  inspection.failedQuantity = passed ? 0 : 1;
  inspection.inspectedBy = userId;
  inspection.completedAt = new Date();
  inspection.updatedBy = userId;
  await inspection.save();
  if (!sample.qcInspectionId) sample.qcInspectionId = inspection._id;
}

async function designIdsForPatternMaster(factoryId, patternMasterId) {
  if (!patternMasterId) return null;
  const rows = await PatternDevelopment.find(applySoftDeleteFilter({
    factoryId,
    patternMasterId,
  })).select('designId');
  return rows.map((r) => r.designId);
}

function applyDesignScope(filter, designIds, explicitDesignId) {
  if (explicitDesignId) {
    if (!designIds) {
      filter.designId = explicitDesignId;
      return;
    }
    const allowed = designIds.some((id) => String(id) === String(explicitDesignId));
    filter.designId = allowed ? explicitDesignId : { $in: [] };
    return;
  }
  filter.designId = { $in: designIds };
}

async function attachPatternMasters(samples) {
  const list = Array.isArray(samples) ? samples : [samples];
  if (!list.length) return samples;
  const designIds = list.map((s) => {
    const d = s.designId;
    return d?._id ? d._id : d;
  });
  const pds = await PatternDevelopment.find(applySoftDeleteFilter({
    designId: { $in: designIds },
  }))
    .select('designId patternMasterId')
    .populate('patternMasterId', 'firstName lastName email');
  const masterByDesign = new Map(pds.map((pd) => [String(pd.designId), pd.patternMasterId]));
  return list.map((s) => {
    const obj = s.toObject ? s.toObject() : { ...s };
    const did = s.designId?._id ? String(s.designId._id) : String(s.designId);
    obj.patternMasterId = masterByDesign.get(did) || null;
    return obj;
  });
}

async function assertPatternDevelopmentComplete(designId, factoryId) {
  const pd = await PatternDevelopment.findOne({ designId, factoryId, isDeleted: false });
  if (!pd || pd.status !== 'COMPLETED') {
    throw new ConflictError('Pattern development must be completed before creating a sample');
  }
  return pd;
}

async function assertNoActiveSample(designId, factoryId) {
  const active = await Sample.findOne(applySoftDeleteFilter({
    factoryId,
    designId,
    status: { $nin: SAMPLE_TERMINAL_STATUSES },
  }));
  if (active) {
    throw new ConflictError(`Active sample ${active.sampleCode} already exists for this design`);
  }
}

function mergeRequirement(requirements, materialId, requiredQty, unit, unitCost = 0) {
  const existing = requirements.find((r) => r.materialId?.toString() === materialId?.toString());
  if (existing) {
    existing.requiredQty += requiredQty;
    return;
  }
  requirements.push({
    materialId,
    requiredQty,
    unit,
    reservedQty: 0,
    issuedQty: 0,
    unitCost,
    cost: 0,
  });
}

/** Sample materials come from the pattern master's signed-off tech pack, not design intent. */
export function generateMaterialRequirementsFromPattern(techPack) {
  const requirements = [];
  for (const fab of techPack?.fabricConsumption || []) {
    if (!fab.materialId) continue;
    const qty = fab.consumption ?? 1;
    const wastage = fab.wastagePercent || 0;
    mergeRequirement(
      requirements,
      fab.materialId,
      qty * (1 + wastage / 100),
      fab.unit || 'METERS',
      fab.fabricCost || 0,
    );
  }
  for (const line of techPack?.bomLines || []) {
    if (!line.materialId) continue;
    mergeRequirement(
      requirements,
      line.materialId,
      line.quantity || 0,
      line.unit || 'PIECES',
      0,
    );
  }
  return requirements;
}

async function buildMaterialRequirements(designId, factoryId) {
  const techPack = await getPatternTechPack(designId, factoryId);
  const requirements = generateMaterialRequirementsFromPattern(techPack);
  for (const req of requirements) {
    const mat = await Material.findById(req.materialId);
    if (mat) req.unitCost = mat.unitCost;
  }
  return requirements;
}

export async function listMaterialOptions(factoryId) {
  return Material.find(applySoftDeleteFilter({ factoryId }))
    .select('materialCode name unit unitCost category')
    .sort({ materialCode: 1 })
    .limit(500)
    .lean();
}

export async function getSampleStats(factoryId, { patternMasterId } = {}) {
  const base = applySoftDeleteFilter({ factoryId });
  if (patternMasterId) {
    const scopedDesignIds = await designIdsForPatternMaster(factoryId, patternMasterId);
    applyDesignScope(base, scopedDesignIds);
  }
  const [
    total,
    active,
    materialPending,
    inCutting,
    inProduction,
    qcPending,
    fitTrial,
    pendingApproval,
    approved,
    rejected,
    revisionRequested,
  ] = await Promise.all([
    Sample.countDocuments(base),
    Sample.countDocuments({ ...base, status: { $nin: SAMPLE_TERMINAL_STATUSES } }),
    Sample.countDocuments({ ...base, status: 'MATERIAL_REQUEST_PENDING' }),
    Sample.countDocuments({ ...base, status: 'CUTTING' }),
    Sample.countDocuments({ ...base, status: 'IN_PROGRESS' }),
    Sample.countDocuments({ ...base, status: 'QC_PENDING' }),
    Sample.countDocuments({ ...base, status: 'FIT_TRIAL' }),
    Sample.countDocuments({ ...base, status: 'PENDING_APPROVAL' }),
    Sample.countDocuments({ ...base, status: 'APPROVED' }),
    Sample.countDocuments({ ...base, status: 'REJECTED' }),
    Sample.countDocuments({ ...base, status: 'REVISION_REQUESTED' }),
  ]);
  return {
    total,
    active,
    materialPending,
    inCutting,
    inProduction,
    qcPending,
    fitTrial,
    pendingApproval,
    approved,
    rejected,
    revisionRequested,
  };
}

export async function listEligibleDesigns(factoryId) {
  const releasedDesigns = await Design.find(applySoftDeleteFilter({ factoryId, status: 'RELEASED' }))
    .select('designCode title styleNumber status')
    .sort({ designCode: 1 });

  const completedPatterns = await PatternDevelopment.find({
    factoryId,
    isDeleted: false,
    status: 'COMPLETED',
    designId: { $in: releasedDesigns.map((d) => d._id) },
  }).select('designId');

  const completedDesignIds = new Set(completedPatterns.map((p) => p.designId.toString()));

  const activeSamples = await Sample.find(applySoftDeleteFilter({
    factoryId,
    status: { $nin: SAMPLE_TERMINAL_STATUSES },
  })).select('designId');

  const blockedDesignIds = new Set(activeSamples.map((s) => s.designId.toString()));

  return releasedDesigns
    .filter((d) => completedDesignIds.has(d._id.toString()) && !blockedDesignIds.has(d._id.toString()))
    .map((d) => ({
      _id: d._id,
      designCode: d.designCode,
      title: d.title,
      styleNumber: d.styleNumber,
    }));
}

export async function createSample(
  { designId, factoryId, organizationId, laborHours, laborRate, sampleType, comments },
  userId,
) {
  const design = await Design.findOne(applySoftDeleteFilter({ _id: designId, factoryId }));
  if (!design) throw new NotFoundError('Design not found');
  if (design.status !== 'RELEASED') {
    throw new ConflictError('Design must be RELEASED before creating a sample');
  }
  await assertPatternDevelopmentComplete(designId, factoryId);
  await assertNoActiveSample(designId, factoryId);

  const pd = await PatternDevelopment.findOne(applySoftDeleteFilter({ designId, factoryId }))
    .select('patternMasterId');

  const lastSample = await Sample.findOne(applySoftDeleteFilter({ designId, factoryId }))
    .sort({ iteration: -1 })
    .select('iteration');
  const iteration = (lastSample?.iteration || 0) + 1;

  const factory = await Factory.findById(factoryId);
  const prefix = `SMP-${factory.code}-`;
  const sampleCode = await nextDocumentNumber(factoryId, 'SAMPLE', prefix);

  const materialRequirements = await buildMaterialRequirements(designId, factoryId);

  const sample = await Sample.create({
    organizationId,
    factoryId,
    sampleCode,
    designId,
    designVersion: design.releasedVersion || design.currentVersion,
    iteration,
    status: 'CREATED',
    sampleType: sampleType || 'PROTOTYPE',
    comments: comments || '',
    materialRequirements,
    laborHours: laborHours ?? 0,
    laborRate: laborRate ?? 0,
    createdBy: userId,
    updatedBy: userId,
    timeline: [{
      at: new Date(),
      action: 'created',
      fromStatus: '',
      toStatus: 'CREATED',
      userId,
      note: `${sampleType || 'PROTOTYPE'} sample created`,
    }],
  });

  if (pd?.patternMasterId) {
    await notify({
      organizationId,
      factoryId,
      userId: pd.patternMasterId,
      eventType: 'sample.created',
      title: 'New sample assignment',
      message: `${sampleCode} (${sampleType || 'PROTOTYPE'}) — review materials and start development`,
      referenceType: 'SAMPLE',
      referenceId: sample._id,
    });
  }

  const populated = await populateSample(sample);
  const [enriched] = await attachPatternMasters([populated]);
  return enriched;
}

export async function listSamples(factoryId, {
  page, limit, skip, status, sampleType, designId, search, excludeTerminal, patternMasterId,
}) {
  const filter = applySoftDeleteFilter({ factoryId });
  if (status) filter.status = status;
  else if (excludeTerminal) filter.status = { $nin: SAMPLE_TERMINAL_STATUSES };
  if (sampleType) filter.sampleType = sampleType;

  const scopedDesignIds = patternMasterId
    ? await designIdsForPatternMaster(factoryId, patternMasterId)
    : null;

  if (designId) {
    applyDesignScope(filter, scopedDesignIds, designId);
  } else if (scopedDesignIds !== null) {
    applyDesignScope(filter, scopedDesignIds);
  }

  if (search?.trim()) {
    const regex = new RegExp(escapeRegex(search.trim()), 'i');
    const matchingDesigns = await Design.find(applySoftDeleteFilter({
      factoryId,
      $or: [{ designCode: regex }, { title: regex }, { styleNumber: regex }],
    })).select('_id');
    const designIds = matchingDesigns.map((d) => d._id);
    filter.$or = [
      { sampleCode: regex },
      ...(designIds.length ? [{ designId: { $in: designIds } }] : []),
    ];
  }

  const [items, total] = await Promise.all([
    Sample.find(filter)
      .populate(SAMPLE_POPULATE)
      .skip(skip)
      .limit(limit)
      .sort({ updatedAt: -1 }),
    Sample.countDocuments(filter),
  ]);
  const enriched = await attachPatternMasters(items);
  return { items: enriched, total };
}

export async function getSample(id, factoryId) {
  const filter = applySoftDeleteFilter({ _id: id, factoryId });
  const sample = await Sample.findOne(filter).populate(SAMPLE_POPULATE);
  if (!sample) throw new NotFoundError('Sample not found');
  const [enriched] = await attachPatternMasters([sample]);
  return enriched;
}

async function loadSampleDoc(id, factoryId) {
  const sample = await Sample.findOne(applySoftDeleteFilter({ _id: id, factoryId }));
  if (!sample) throw new NotFoundError('Sample not found');
  return sample;
}

async function assertSamplePatternMaster(sample, userId, { isSuperAdmin = false } = {}) {
  if (isSuperAdmin) return;
  const designId = sample.designId?._id?.toString?.() || sample.designId?.toString?.();
  const pd = await PatternDevelopment.findOne(applySoftDeleteFilter({
    designId,
    factoryId: sample.factoryId,
  }));
  if (!pd?.patternMasterId) {
    throw new ForbiddenError('No pattern master assigned for this design');
  }
  const masterId = pd.patternMasterId.toString();
  if (masterId !== userId.toString()) {
    throw new ForbiddenError('Only the assigned pattern master can update this sample');
  }
}

async function loadSampleForUpdate(id, factoryId) {
  return loadSampleDoc(id, factoryId);
}

async function loadSampleForPatternMasterOps(id, factoryId, userId, opts = {}) {
  const sample = await loadSampleDoc(id, factoryId);
  await assertSamplePatternMaster(sample, userId, opts);
  return sample;
}

/** After store issue: assigned pattern master, or sampling team (create, not approve). */
async function assertSampleFloorAccess(sample, userId, opts = {}) {
  const { isSuperAdmin = false, permissions = [] } = opts;
  if (isSuperAdmin || permissions.includes('*')) return;
  const samplingTeam = permissions.includes('sampling.create') && !permissions.includes('sampling.approve');
  if (samplingTeam) return;
  await assertSamplePatternMaster(sample, userId, opts);
}

async function loadSampleForFloorOps(id, factoryId, userId, opts = {}) {
  const sample = await loadSampleDoc(id, factoryId);
  await assertSampleFloorAccess(sample, userId, opts);
  return sample;
}

export async function updateSampleMaterials(id, factoryId, body, userId, opts = {}) {
  const sample = await loadSampleForPatternMasterOps(id, factoryId, userId, opts);
  if (!['CREATED', 'REVISION_REQUESTED'].includes(sample.status)) {
    throw new ConflictError('Cannot update materials in current status');
  }

  const materialIds = [...new Set(body.materialRequirements.map((r) => r.materialId))];
  const materials = await Material.find({ _id: { $in: materialIds }, factoryId, isDeleted: false });
  if (materials.length !== materialIds.length) {
    throw new ValidationError('One or more materials are invalid for this factory');
  }
  const matMap = new Map(materials.map((m) => [m._id.toString(), m]));

  sample.materialRequirements = body.materialRequirements.map((r) => {
    const mat = matMap.get(r.materialId.toString());
    return {
      materialId: r.materialId,
      requiredQty: r.requiredQty,
      unit: r.unit || mat?.unit || 'PIECES',
      reservedQty: 0,
      issuedQty: 0,
      unitCost: r.unitCost ?? mat?.unitCost ?? 0,
      cost: 0,
    };
  });

  if (body.laborHours != null) sample.laborHours = body.laborHours;
  if (body.laborRate != null) sample.laborRate = body.laborRate;
  if (body.comments != null) sample.comments = body.comments;
  sample.updatedBy = userId;
  await sample.save();
  return populateSample(sample);
}

export async function refreshMaterialsFromPattern(id, factoryId, userId, opts = {}) {
  const sample = await loadSampleForPatternMasterOps(id, factoryId, userId, opts);
  if (!['CREATED', 'REVISION_REQUESTED'].includes(sample.status)) {
    throw new ConflictError('Can only refresh materials before material request is submitted');
  }
  const designId = sample.designId?._id || sample.designId;
  const materialRequirements = await buildMaterialRequirements(designId, factoryId);
  if (!materialRequirements.length) {
    throw new ValidationError('Pattern tech pack has no materials — add fabric or BOM lines on the pattern first');
  }
  sample.materialRequirements = materialRequirements;
  sample.updatedBy = userId;
  await sample.save();
  return populateSample(sample);
}

export async function submitMaterialRequest(id, factoryId, userId, opts = {}) {
  const sample = await loadSampleForPatternMasterOps(id, factoryId, userId, opts);
  if (!['CREATED', 'REVISION_REQUESTED'].includes(sample.status)) {
    throw new ConflictError('Sample must be CREATED or REVISION_REQUESTED to submit material request');
  }
  if (!sample.materialRequirements?.length) {
    throw new ConflictError('Material requirements are empty — add materials from the design BOM first');
  }

  setSampleStatus(sample, 'MATERIAL_REQUEST_PENDING', userId, 'submit_material_request', 'Submitted for RM approval');
  sample.updatedBy = userId;
  await sample.save();

  await submitForApproval({
    organizationId: sample.organizationId,
    factoryId: sample.factoryId,
    documentType: 'SAMPLE_MATERIAL',
    documentId: sample._id,
    submittedBy: userId,
  });
  return populateSample(sample);
}

export async function approveMaterialRequest(id, factoryId, userId, { syncApproval = true } = {}) {
  const sample = await loadSampleForUpdate(id, factoryId);
  if (sample.status !== 'MATERIAL_REQUEST_PENDING') {
    throw new ConflictError('No pending material request');
  }
  if (syncApproval) {
    await syncApprovalApproved('SAMPLE_MATERIAL', sample._id, userId);
  }
  setSampleStatus(sample, 'MATERIAL_REQUEST_APPROVED', userId, 'approve_material_request');
  sample.updatedBy = userId;
  await sample.save();
  return populateSample(sample);
}

export async function rejectMaterialRequest(id, factoryId, userId, comments, { syncApproval = true } = {}) {
  const sample = await loadSampleForUpdate(id, factoryId);
  if (sample.status !== 'MATERIAL_REQUEST_PENDING') {
    throw new ConflictError('No pending material request');
  }
  if (syncApproval) {
    await syncApprovalRejected('SAMPLE_MATERIAL', sample._id, userId, comments);
  }
  setSampleStatus(sample, 'CREATED', userId, 'reject_material_request', comments);
  sample.rejectionComments = comments;
  sample.updatedBy = userId;
  await sample.save();
  return populateSample(sample);
}

export async function reserveMaterials(id, factoryId, userId) {
  const sample = await loadSampleForUpdate(id, factoryId);
  if (sample.status === 'MATERIAL_RESERVED') {
    const allReserved = sample.materialRequirements.every(
      (r) => (r.reservedQty || 0) >= (r.requiredQty || 0),
    );
    if (allReserved) return populateSample(sample);
    throw new ConflictError('Sample already reserved — issue materials or release reservations first');
  }
  if (sample.status !== 'MATERIAL_REQUEST_APPROVED') {
    throw new ConflictError('Material request must be approved before reserve');
  }

  for (const req of sample.materialRequirements) {
    if ((req.reservedQty || 0) >= (req.requiredQty || 0)) continue;
    const mat = await Material.findById(req.materialId);
    if (!mat) throw new NotFoundError(`Material ${req.materialId} not found`);

    await inventoryService.reserveMaterial({
      factoryId: sample.factoryId,
      organizationId: sample.organizationId,
      materialId: req.materialId,
      quantity: req.requiredQty,
      unit: req.unit || mat.unit,
      referenceType: 'SAMPLE',
      referenceId: sample._id,
      userId,
    });
    req.reservedQty = req.requiredQty;
    req.unitCost = mat.unitCost;
  }

  setSampleStatus(sample, 'MATERIAL_RESERVED', userId, 'reserve_materials');
  sample.updatedBy = userId;
  await sample.save();
  return populateSample(sample);
}

export async function issueMaterials(id, factoryId, userId) {
  const sample = await loadSampleForUpdate(id, factoryId);
  if (sample.status !== 'MATERIAL_RESERVED') {
    throw new ConflictError('Materials must be reserved before issue');
  }
  const needsReserve = sample.materialRequirements.some((r) => !r.reservedQty);
  if (needsReserve) {
    throw new ConflictError('Run reserve-materials before issue');
  }

  let materialCost = 0;
  for (const req of sample.materialRequirements) {
    const mat = await Material.findById(req.materialId);
    await inventoryService.issueMaterial({
      factoryId: sample.factoryId,
      organizationId: sample.organizationId,
      materialId: req.materialId,
      quantity: req.reservedQty || req.requiredQty,
      unit: req.unit || mat?.unit,
      referenceType: 'SAMPLE',
      referenceId: sample._id,
      userId,
    });
    req.issuedQty = req.reservedQty || req.requiredQty;
    req.cost = req.issuedQty * (req.unitCost || mat?.unitCost || 0);
    materialCost += req.cost;
  }

  setSampleStatus(sample, 'CUTTING', userId, 'issue_materials', 'Fabric & trims issued — cutting department');
  sample.totalCost = materialCost + (sample.laborHours || 0) * (sample.laborRate || 0);
  sample.updatedBy = userId;
  await sample.save();
  return populateSample(sample);
}

export async function completeCutting(id, factoryId, userId, opts = {}) {
  const sample = await loadSampleForFloorOps(id, factoryId, userId, opts);
  if (sample.status !== 'CUTTING') throw new ConflictError('Sample must be in CUTTING');
  setSampleStatus(sample, 'IN_PROGRESS', userId, 'complete_cutting', 'Bundles handed to sample tailor');
  sample.updatedBy = userId;
  await sample.save();
  return populateSample(sample);
}

export async function completeSample(id, factoryId, userId, opts = {}) {
  const sample = await loadSampleForFloorOps(id, factoryId, userId, opts);
  if (sample.status !== 'IN_PROGRESS') throw new ConflictError('Sample must be stitching (IN_PROGRESS)');
  setSampleStatus(sample, 'QC_PENDING', userId, 'complete_stitching', 'Sent to quality inspection');
  sample.updatedBy = userId;
  await sample.save();

  const { ensureSampleQcInspection } = await import('../quality/quality.service.js');
  const inspection = await ensureSampleQcInspection(sample, userId);

  await notifyUsersWithPermission({
    organizationId: sample.organizationId,
    factoryId: sample.factoryId,
    permission: 'quality.update',
    excludeUserId: userId,
    eventType: 'sample.qc_pending',
    title: 'Sample ready for QC',
    message: `${sample.sampleCode} — inspect measurements, stitch, and appearance`,
    referenceType: 'QUALITY_INSPECTION',
    referenceId: inspection?._id || sample._id,
  });

  return populateSample(sample);
}

function designIdOfSample(sample) {
  const d = sample.designId;
  return d?._id ? String(d._id) : String(d);
}

function applyFitAnalysis(sample, fitAnalysis, userId) {
  if (!fitAnalysis) return;
  sample.fitAnalysis = {
    evaluatedOn: fitAnalysis.evaluatedOn,
    overallResult: fitAnalysis.overallResult,
    issues: fitAnalysis.issues || [],
    patternRevisionRequired: !!fitAnalysis.patternRevisionRequired,
    notes: fitAnalysis.notes || '',
    evaluatedAt: new Date(),
    evaluatedBy: userId,
  };
}

function applyQcMeasurements(sample, measurements) {
  if (!measurements?.length) return;
  sample.qcMeasurements = measurements.map((m) => ({
    point: m.point,
    required: m.required,
    actual: m.actual,
    tolerance: m.tolerance || '',
    pass: m.pass !== false,
  }));
}

async function handleFitPatternRevision(sample, factoryId, userId, reason) {
  if (!sample.fitAnalysis?.patternRevisionRequired) return;
  const designId = designIdOfSample(sample);
  try {
    await reopenPatternForFit(designId, factoryId, userId, {
      sampleId: String(sample._id),
      reason: reason || sample.fitAnalysis.notes || 'Fit sample requires pattern revision',
    });
  } catch (err) {
    if (err?.code !== 'NOT_FOUND') throw err;
  }
}

export async function passSampleQc(id, factoryId, userId, comments, fitAnalysis, qcMeasurements) {
  const sample = await loadSampleForUpdate(id, factoryId);
  if (sample.status !== 'QC_PENDING') throw new ConflictError('Sample must be QC_PENDING');
  applyQcMeasurements(sample, qcMeasurements);
  sample.qcComments = comments || '';
  sample.updatedBy = userId;

  const nextStatus = sampleNeedsFitTrial(sample.sampleType) ? 'FIT_TRIAL' : 'PENDING_APPROVAL';
  setSampleStatus(sample, nextStatus, userId, 'qc_pass', comments || 'Measurements within tolerance');

  if (nextStatus === 'PENDING_APPROVAL') {
    await submitForApproval({
      organizationId: sample.organizationId,
      factoryId: sample.factoryId,
      documentType: 'SAMPLE',
      documentId: sample._id,
      submittedBy: userId,
    });
  }
  await syncSampleInspectionResult(sample, userId, true);
  await sample.save();
  return populateSample(sample);
}

export async function completeFitTrial(id, factoryId, userId, comments, fitAnalysis, opts = {}) {
  const sample = await loadSampleForFloorOps(id, factoryId, userId, opts);
  if (sample.status !== 'FIT_TRIAL') throw new ConflictError('Sample must be in FIT_TRIAL');
  applyFitAnalysis(sample, fitAnalysis, userId);
  setSampleStatus(sample, 'PENDING_APPROVAL', userId, 'fit_trial_complete', comments || 'Fit session recorded');
  if (comments) sample.qcComments = [sample.qcComments, comments].filter(Boolean).join(' · ');
  sample.updatedBy = userId;
  await sample.save();
  await handleFitPatternRevision(sample, factoryId, userId, comments);

  await submitForApproval({
    organizationId: sample.organizationId,
    factoryId: sample.factoryId,
    documentType: 'SAMPLE',
    documentId: sample._id,
    submittedBy: userId,
  });
  return populateSample(sample);
}

export async function submitSampleForApproval(id, factoryId, userId, opts = {}) {
  const sample = await loadSampleForFloorOps(id, factoryId, userId, opts);
  if (!['QC_PASSED', 'PENDING_APPROVAL'].includes(sample.status)) {
    throw new ConflictError('Sample must pass QC before final approval submission');
  }
  if (sample.status === 'QC_PASSED') {
    sample.status = 'PENDING_APPROVAL';
    sample.updatedBy = userId;
    await sample.save();
    await submitForApproval({
      organizationId: sample.organizationId,
      factoryId: sample.factoryId,
      documentType: 'SAMPLE',
      documentId: sample._id,
      submittedBy: userId,
    });
  }
  return populateSample(sample);
}

export async function failSampleQc(id, factoryId, userId, comments, fitAnalysis, qcMeasurements) {
  const sample = await loadSampleForUpdate(id, factoryId);
  if (sample.status !== 'QC_PENDING') throw new ConflictError('Sample must be QC_PENDING');
  applyQcMeasurements(sample, qcMeasurements);
  applyFitAnalysis(sample, fitAnalysis, userId);
  setSampleStatus(sample, 'QC_FAILED', userId, 'qc_fail', comments);
  sample.qcComments = comments;
  sample.updatedBy = userId;
  await syncSampleInspectionResult(sample, userId, false);
  await sample.save();
  await handleFitPatternRevision(sample, factoryId, userId, comments);
  return populateSample(sample);
}

/** Quality module completing a SAMPLE inspection advances the sample (no second inspection write). */
export async function applySampleQcFromInspection(sampleId, factoryId, userId, {
  result, disposition, passed = 0, failed = 0, notes = '',
} = {}) {
  const sample = await loadSampleForUpdate(sampleId, factoryId);
  if (sample.status !== 'QC_PENDING') return populateSample(sample);
  const isFail = disposition === 'REJECT' || disposition === 'REWORK'
    || result === 'FAIL' || (Number(failed) > 0 && Number(passed) === 0);
  if (isFail) {
    return failSampleQc(
      sampleId,
      factoryId,
      userId,
      notes || 'Failed quality inspection',
    );
  }
  return passSampleQc(
    sampleId,
    factoryId,
    userId,
    notes || 'Passed quality inspection',
  );
}

export async function approveSample(id, factoryId, userId, { syncApproval = true } = {}) {
  const sample = await loadSampleForUpdate(id, factoryId);
  if (!['PENDING_APPROVAL', 'QC_PASSED'].includes(sample.status)) {
    throw new ConflictError('Sample must pass QC and be pending approval');
  }
  if (syncApproval) {
    await syncApprovalApproved('SAMPLE', sample._id, userId);
  }
  setSampleStatus(sample, 'APPROVED', userId, 'approve', 'Approved for bulk / SKU');
  sample.approvedBy = userId;
  sample.approvedAt = new Date();
  sample.updatedBy = userId;
  await sample.save();
  return populateSample(sample);
}

export async function rejectSample(id, factoryId, userId, comments, { syncApproval = true } = {}) {
  const sample = await loadSampleForUpdate(id, factoryId);
  if (!['PENDING_APPROVAL', 'QC_PASSED'].includes(sample.status)) {
    throw new ConflictError('Sample not pending approval');
  }
  if (syncApproval) {
    await syncApprovalRejected('SAMPLE', sample._id, userId, comments);
  }
  setSampleStatus(sample, 'REJECTED', userId, 'reject', comments);
  sample.rejectionComments = comments;
  sample.updatedBy = userId;
  await sample.save();
  return populateSample(sample);
}

export async function requestSampleRevision(id, factoryId, userId, comments, { syncApproval = true } = {}) {
  const sample = await loadSampleForUpdate(id, factoryId);
  if (!['PENDING_APPROVAL', 'QC_FAILED', 'QC_PASSED', 'FIT_TRIAL'].includes(sample.status)) {
    throw new ConflictError('Cannot request revision in current status');
  }
  if (syncApproval && ['PENDING_APPROVAL', 'QC_PASSED'].includes(sample.status)) {
    await syncApprovalRevisionRequested('SAMPLE', sample._id, userId, comments);
  }
  setSampleStatus(sample, 'REVISION_REQUESTED', userId, 'revision_requested', comments);
  sample.revisionComments = comments;
  sample.iteration = (sample.iteration || 1) + 1;
  sample.updatedBy = userId;
  await sample.save();

  if (sample.createdBy) {
    await notify({
      organizationId: sample.organizationId,
      factoryId: sample.factoryId,
      userId: sample.createdBy,
      eventType: 'sample.revision_requested',
      title: 'Sample revision requested',
      message: `${sample.sampleCode} needs revision (iteration ${sample.iteration})`,
      referenceType: 'SAMPLE',
      referenceId: sample._id,
    });
  }
  return populateSample(sample);
}

export async function reopenSampleForRevision(id, factoryId, userId, opts = {}) {
  const sample = await loadSampleForPatternMasterOps(id, factoryId, userId, opts);
  if (sample.status !== 'REVISION_REQUESTED') {
    throw new ConflictError('Sample must be in REVISION_REQUESTED status');
  }
  const hasReservations = sample.materialRequirements.some((r) => (r.reservedQty || 0) > 0 && !(r.issuedQty || 0));
  if (hasReservations) {
    await inventoryService.releaseReservations({
      factoryId: sample.factoryId,
      organizationId: sample.organizationId,
      referenceType: 'SAMPLE',
      referenceId: sample._id,
      userId,
    });
    for (const req of sample.materialRequirements) {
      if (!(req.issuedQty || 0)) req.reservedQty = 0;
    }
  }
  setSampleStatus(sample, 'CREATED', userId, 'reopen_revision', 'Ready to update materials and resubmit RM');
  sample.updatedBy = userId;
  await sample.save();
  return populateSample(sample);
}
