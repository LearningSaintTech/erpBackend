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
  cancelPendingApproval,
} from '../../shared/services/approvalSync.js';
import { nextDocumentNumber } from '../../shared/utils/numbering.js';
import { NotFoundError, ConflictError, ValidationError, ForbiddenError } from '../../shared/errors/AppError.js';
import { applySoftDeleteFilter, queryString, escapeRegex } from '../../shared/utils/schema.js';
import { notify } from '../notification/notification.service.js';
import { findUserIdsWithFactoryPermission } from '../user/user.service.js';
import { reopenPatternForFit, getPatternTechPack } from '../pattern/pattern.service.js';
import { SAMPLE_TERMINAL_STATUSES, sampleNeedsFitTrial } from './sample.defaults.js';
import { QualityInspection } from '../quality/qualityInspection.model.js';

/** 'FIT' → 'Fit', 'PRE_PRODUCTION' → 'Pre-production' — for human-readable timeline notes. */
const humanSampleType = (t) => { const s = String(t).toLowerCase().replace(/_/g, '-'); return s.charAt(0).toUpperCase() + s.slice(1); };

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

/** Active factory users holding the permission (roles + delegations), like design.submitted. */
async function notifyUsersWithPermission({
  organizationId,
  factoryId,
  permission,
  excludeUserId,
  alsoNotify = [],
  eventType,
  title,
  message,
  referenceType,
  referenceId,
}) {
  const ids = await findUserIdsWithFactoryPermission(factoryId, permission, { excludeUserId });
  const recipients = new Set(ids.map(String));
  for (const extra of alsoNotify) {
    if (extra && String(extra) !== String(excludeUserId || '')) recipients.add(String(extra));
  }
  await Promise.all([...recipients].map((userId) => notify({
    organizationId,
    factoryId,
    userId,
    eventType,
    title,
    message,
    referenceType,
    referenceId,
  })));
}

async function patternMasterIdForSample(sample) {
  const pd = await PatternDevelopment.findOne(applySoftDeleteFilter({
    designId: sample.designId?._id || sample.designId,
    factoryId: sample.factoryId,
  })).select('patternMasterId');
  return pd?.patternMasterId || null;
}

/** Assigned pattern master and/or sample creator — the people who own the sample's next move. */
async function notifySampleOwners(sample, {
  eventType, title, message, excludeUserId, includeCreator = true, includePatternMaster = true,
}) {
  const recipients = new Set();
  if (includePatternMaster) {
    const pm = await patternMasterIdForSample(sample);
    if (pm) recipients.add(String(pm));
  }
  if (includeCreator && sample.createdBy) recipients.add(String(sample.createdBy));
  if (excludeUserId) recipients.delete(String(excludeUserId));
  await Promise.all([...recipients].map((userId) => notify({
    organizationId: sample.organizationId,
    factoryId: sample.factoryId,
    userId,
    eventType,
    title,
    message,
    referenceType: 'SAMPLE',
    referenceId: sample._id,
  })));
}

async function notifySampleApprovers(sample, userId, { eventType, title, message }) {
  await notifyUsersWithPermission({
    organizationId: sample.organizationId,
    factoryId: sample.factoryId,
    permission: 'sampling.approve',
    excludeUserId: userId,
    eventType,
    title,
    message,
    referenceType: 'SAMPLE',
    referenceId: sample._id,
  });
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

async function assertPatternDevelopmentComplete(designId, factoryId, action = 'creating a sample') {
  const pd = await PatternDevelopment.findOne({ designId, factoryId, isDeleted: false });
  if (!pd || pd.status !== 'COMPLETED') {
    const state = pd ? `is ${pd.status.replace(/_/g, ' ').toLowerCase()}` : 'has not started';
    throw new ConflictError(
      `Pattern development ${state} — the pattern master must complete (re-sign) the pattern before ${action}`,
    );
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

/** Lines without a colour are shared by every variant; with no target colour every line applies. */
function lineAppliesToColor(lineColor, color) {
  if (!color || !lineColor?.trim()) return true;
  return lineColor.trim().toLowerCase() === String(color).trim().toLowerCase();
}

/**
 * Sample materials come from the pattern master's signed-off tech pack, not design intent.
 * Same rule as the BOM suggestion: fabric comes from fabricConsumption (consumption + wastage);
 * a bomLines entry for a material already taken from fabric is a legacy mirror and is skipped,
 * so fabric is never counted twice.
 */
export function generateMaterialRequirementsFromPattern(techPack, { color } = {}) {
  const requirements = [];
  const fabricIds = new Set();
  for (const fab of techPack?.fabricConsumption || []) {
    if (!fab.materialId || !lineAppliesToColor(fab.color, color)) continue;
    fabricIds.add(String(fab.materialId));
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
    if (!line.materialId || fabricIds.has(String(line.materialId))) continue;
    if (!lineAppliesToColor(line.color, color)) continue;
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

async function buildMaterialRequirements(designId, factoryId, { color } = {}) {
  const techPack = await getPatternTechPack(designId, factoryId);
  const requirements = generateMaterialRequirementsFromPattern(techPack, { color });
  for (const req of requirements) {
    const mat = await Material.findById(req.materialId);
    if (mat) {
      req.unitCost = mat.unitCost;
      // Store reserves/issues in the material's own unit — pattern unit codes (M, PC…) are display only.
      req.unit = mat.unit;
    }
    req.requiredQty = Math.round(req.requiredQty * 1000) / 1000;
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
  patternMasterId = queryString(patternMasterId);
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

/**
 * Released designs whose pattern is complete and that have no sample in progress.
 * `onlyNew`: also skip designs that already have an approved sample (the "ready to sample" queue).
 */
export async function listEligibleDesigns(factoryId, { onlyNew = false } = {}) {
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
    status: onlyNew ? { $nin: ['REJECTED', 'CANCELLED'] } : { $nin: SAMPLE_TERMINAL_STATUSES },
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
      note: `${humanSampleType(sampleType || 'PROTOTYPE')} sample created`,
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
  status = queryString(status);
  sampleType = queryString(sampleType);
  designId = queryString(designId);
  search = queryString(search);
  patternMasterId = queryString(patternMasterId);
  // Comma-separated statuses ("A,B") so role queues can page on the server.
  if (status) filter.status = status.includes(',') ? { $in: status.split(',').map((v) => v.trim()).filter(Boolean) } : status;
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

/**
 * REVISION_REQUESTED still holds the previous iteration's reservations and issued quantities;
 * only Reopen releases them, so material edits and the RM submit wait for CREATED.
 */
function assertMaterialsEditable(sample, action) {
  if (sample.status === 'REVISION_REQUESTED') {
    throw new ConflictError(
      `Reopen the sample for rework before you ${action} — reopening releases the previous iteration's stock`,
    );
  }
  if (sample.status !== 'CREATED') {
    throw new ConflictError(`Cannot ${action} while the sample is ${sample.status.replace(/_/g, ' ')}`);
  }
}

export async function updateSampleMaterials(id, factoryId, body, userId, opts = {}) {
  const sample = await loadSampleForPatternMasterOps(id, factoryId, userId, opts);
  assertMaterialsEditable(sample, 'update materials');

  const materialIds = [...new Set(body.materialRequirements.map((r) => r.materialId))];
  const materials = await Material.find({ _id: { $in: materialIds }, factoryId, isDeleted: false });
  if (materials.length !== materialIds.length) {
    throw new ValidationError('One or more materials are invalid for this factory');
  }
  const matMap = new Map(materials.map((m) => [m._id.toString(), m]));

  for (const r of body.materialRequirements) {
    const mat = matMap.get(r.materialId.toString());
    if (r.unit && mat?.unit && r.unit !== mat.unit) {
      throw new ValidationError(
        `${mat.materialCode} is stocked in ${mat.unit} — the sample line must use ${mat.unit}, not ${r.unit}`,
      );
    }
  }

  sample.materialRequirements = body.materialRequirements.map((r) => {
    const mat = matMap.get(r.materialId.toString());
    return {
      materialId: r.materialId,
      requiredQty: r.requiredQty,
      unit: mat?.unit || r.unit || 'PIECES',
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
  assertMaterialsEditable(sample, 'refresh materials');
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
  assertMaterialsEditable(sample, 'submit the material request');
  if (!sample.materialRequirements?.length) {
    throw new ConflictError('Material requirements are empty — add materials from the design BOM first');
  }
  await assertPatternDevelopmentComplete(
    sample.designId?._id || sample.designId,
    factoryId,
    'requesting sample materials',
  );

  setSampleStatus(sample, 'MATERIAL_REQUEST_PENDING', userId, 'submit_material_request', 'Submitted for material approval');
  sample.updatedBy = userId;
  await sample.save();

  await submitForApproval({
    organizationId: sample.organizationId,
    factoryId: sample.factoryId,
    documentType: 'SAMPLE_MATERIAL',
    documentId: sample._id,
    submittedBy: userId,
  });

  await notifySampleApprovers(sample, userId, {
    eventType: 'sample.material_pending',
    title: 'Sample materials awaiting approval',
    message: `${sample.sampleCode} — fabric & trims request needs approval`,
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

  // Store keepers reserve and issue next; the pattern master learns the cut can be planned.
  const pm = await patternMasterIdForSample(sample);
  await notifyUsersWithPermission({
    organizationId: sample.organizationId,
    factoryId: sample.factoryId,
    permission: 'inventory.update',
    excludeUserId: userId,
    alsoNotify: [pm],
    eventType: 'sample.material_approved',
    title: 'Sample materials approved',
    message: `${sample.sampleCode} — reserve and issue fabric & trims to cutting`,
    referenceType: 'SAMPLE',
    referenceId: sample._id,
  });
  return populateSample(sample);
}

/** Approver sends the RM request back to the pattern master for edits (not a rejection). */
export async function requestMaterialRequestChanges(id, factoryId, userId, comments, { syncApproval = true } = {}) {
  const sample = await loadSampleForUpdate(id, factoryId);
  if (sample.status !== 'MATERIAL_REQUEST_PENDING') {
    throw new ConflictError('No pending material request');
  }
  if (syncApproval) {
    await syncApprovalRevisionRequested('SAMPLE_MATERIAL', sample._id, userId, comments);
  }
  // CREATED is the editable state the pattern master submits the RM request from.
  setSampleStatus(sample, 'CREATED', userId, 'material_changes_requested', comments);
  sample.revisionComments = comments;
  sample.updatedBy = userId;
  await sample.save();

  await notifySampleOwners(sample, {
    eventType: 'sample.revision_requested',
    title: 'Sample material changes requested',
    message: comments?.trim()
      ? `${sample.sampleCode} — update fabric & trims: ${comments.trim()}`
      : `${sample.sampleCode} — update fabric & trims and resubmit`,
    excludeUserId: userId,
    includeCreator: false,
  });
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
    const qtyToIssue = req.reservedQty || req.requiredQty;
    const mat = await Material.findById(req.materialId);
    // Idempotent retry: a line already issued by an earlier (partially failed) call is not issued again.
    if ((req.issuedQty || 0) >= qtyToIssue) {
      materialCost += req.cost || req.issuedQty * (req.unitCost || mat?.unitCost || 0);
      continue;
    }
    await inventoryService.issueMaterial({
      factoryId: sample.factoryId,
      organizationId: sample.organizationId,
      materialId: req.materialId,
      quantity: qtyToIssue,
      unit: req.unit || mat?.unit,
      referenceType: 'SAMPLE',
      referenceId: sample._id,
      userId,
    });
    req.issuedQty = qtyToIssue;
    req.cost = req.issuedQty * (req.unitCost || mat?.unitCost || 0);
    materialCost += req.cost;
    await sample.save();
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

  await syncSampleInspectionResult(sample, userId, true);
  // Persist the status first so an approval instance never points at a sample still in QC_PENDING.
  await sample.save();
  if (nextStatus === 'PENDING_APPROVAL') {
    await submitSampleApprovalAndNotify(sample, userId);
  }
  return populateSample(sample);
}

async function submitSampleApprovalAndNotify(sample, userId) {
  await submitForApproval({
    organizationId: sample.organizationId,
    factoryId: sample.factoryId,
    documentType: 'SAMPLE',
    documentId: sample._id,
    submittedBy: userId,
  });
  await notifySampleApprovers(sample, userId, {
    eventType: 'approval.pending',
    title: 'Sample awaiting approval',
    message: `${sample.sampleCode} passed QC${sample.fitAnalysis?.overallResult ? ' and fit' : ''} — approve, request revision, or reject`,
  });
}

export async function completeFitTrial(id, factoryId, userId, comments, fitAnalysis, opts = {}) {
  const sample = await loadSampleForFloorOps(id, factoryId, userId, opts);
  if (sample.status !== 'FIT_TRIAL') throw new ConflictError('Sample must be in FIT_TRIAL');
  applyFitAnalysis(sample, fitAnalysis, userId);
  if (comments) sample.qcComments = [sample.qcComments, comments].filter(Boolean).join(' · ');
  sample.updatedBy = userId;

  if (sample.fitAnalysis?.patternRevisionRequired) {
    // The pattern goes back to the master; buyer approval would sign off a garment that will change.
    const note = comments || sample.fitAnalysis.notes || 'Fit trial requires pattern revision';
    setSampleStatus(sample, 'REVISION_REQUESTED', userId, 'fit_trial_pattern_revision', note);
    sample.revisionComments = note;
    sample.iteration = (sample.iteration || 1) + 1;
    await sample.save();
    await handleFitPatternRevision(sample, factoryId, userId, comments);
    await notifySampleOwners(sample, {
      eventType: 'sample.revision_requested',
      title: 'Fit trial needs a pattern revision',
      message: `${sample.sampleCode} — correct the pattern, re-complete it, then reopen the sample (iteration ${sample.iteration})`,
      excludeUserId: userId,
    });
    return populateSample(sample);
  }

  setSampleStatus(sample, 'PENDING_APPROVAL', userId, 'fit_trial_complete', comments || 'Fit session recorded');
  await sample.save();
  await submitSampleApprovalAndNotify(sample, userId);
  return populateSample(sample);
}

export async function submitSampleForApproval(id, factoryId, userId, opts = {}) {
  const sample = await loadSampleForFloorOps(id, factoryId, userId, opts);
  if (!['QC_PASSED', 'PENDING_APPROVAL'].includes(sample.status)) {
    throw new ConflictError('Sample must pass QC before final approval submission');
  }
  if (sample.status === 'QC_PASSED') {
    setSampleStatus(sample, 'PENDING_APPROVAL', userId, 'submit_for_approval');
    sample.updatedBy = userId;
    await sample.save();
    await submitSampleApprovalAndNotify(sample, userId);
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
  await notifySampleOwners(sample, {
    eventType: 'sample.qc_failed',
    title: 'Sample failed QC',
    message: comments?.trim()
      ? `${sample.sampleCode} failed quality inspection: ${comments.trim()}`
      : `${sample.sampleCode} failed quality inspection`,
    excludeUserId: userId,
  });
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
  await assertPatternDevelopmentComplete(
    sample.designId?._id || sample.designId,
    factoryId,
    'approving the sample',
  );
  if (syncApproval) {
    await syncApprovalApproved('SAMPLE', sample._id, userId);
  }
  setSampleStatus(sample, 'APPROVED', userId, 'approve', 'Approved for bulk / SKU');
  sample.approvedBy = userId;
  sample.approvedAt = new Date();
  sample.updatedBy = userId;
  await sample.save();
  await notifySampleOwners(sample, {
    eventType: 'sample.approved',
    title: 'Sample approved',
    message: `${sample.sampleCode} approved — ready for SKU creation`,
    excludeUserId: userId,
  });
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
  await notifySampleOwners(sample, {
    eventType: 'sample.rejected',
    title: 'Sample rejected',
    message: comments?.trim()
      ? `${sample.sampleCode} was rejected: ${comments.trim()}`
      : `${sample.sampleCode} was rejected`,
    excludeUserId: userId,
  });
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

  // The assigned pattern master reworks the sample; the creator tracks it.
  await notifySampleOwners(sample, {
    eventType: 'sample.revision_requested',
    title: 'Sample revision requested',
    message: comments?.trim()
      ? `${sample.sampleCode} needs revision (iteration ${sample.iteration}): ${comments.trim()}`
      : `${sample.sampleCode} needs revision (iteration ${sample.iteration})`,
    excludeUserId: userId,
  });
  return populateSample(sample);
}

/** Release ACTIVE reservations and zero the iteration's reserve/issue/cost bookkeeping. */
async function releaseSampleStock(sample, userId, { keepIssued = false } = {}) {
  await inventoryService.releaseReservations({
    factoryId: sample.factoryId,
    organizationId: sample.organizationId,
    referenceType: 'SAMPLE',
    referenceId: sample._id,
    userId,
  });
  for (const req of sample.materialRequirements || []) {
    if (keepIssued) {
      // Issued stock is consumed — keep it (and its cost) on the record; only the hold is gone.
      req.reservedQty = req.issuedQty || 0;
      continue;
    }
    req.reservedQty = 0;
    req.issuedQty = 0;
    req.cost = 0;
  }
}

export async function reopenSampleForRevision(id, factoryId, userId, opts = {}) {
  const sample = await loadSampleForPatternMasterOps(id, factoryId, userId, opts);
  if (sample.status !== 'REVISION_REQUESTED') {
    throw new ConflictError('Sample must be in REVISION_REQUESTED status');
  }
  // Next iteration reserves and issues fresh stock — the previous iteration's quantities are history.
  await releaseSampleStock(sample, userId);
  setSampleStatus(sample, 'CREATED', userId, 'reopen_revision', 'Ready to update materials and resubmit RM');
  sample.updatedBy = userId;
  await sample.save();
  return populateSample(sample);
}

/**
 * Abandon a sample from any non-terminal status: free reserved stock, close open approval
 * instances, and park it as REJECTED (terminal) with the reason so the design can start a new one.
 */
export async function cancelSample(id, factoryId, userId, reason) {
  const sample = await loadSampleForUpdate(id, factoryId);
  if ([...SAMPLE_TERMINAL_STATUSES, 'COMPLETED'].includes(sample.status)) {
    throw new ConflictError(`Sample is already ${sample.status.replace(/_/g, ' ').toLowerCase()}`);
  }
  const note = reason?.trim() || 'Sample cancelled';
  await releaseSampleStock(sample, userId, { keepIssued: true });
  await cancelPendingApproval('SAMPLE', sample._id, userId, note);
  await cancelPendingApproval('SAMPLE_MATERIAL', sample._id, userId, note);
  // Drop any open sample QC inspection so it doesn't linger in the quality queue.
  await QualityInspection.updateMany(
    {
      factoryId: sample.factoryId,
      referenceType: 'SAMPLE',
      referenceId: sample._id,
      status: { $ne: 'COMPLETED' },
      isDeleted: false,
    },
    { $set: { isDeleted: true, updatedBy: userId } },
  );
  setSampleStatus(sample, 'REJECTED', userId, 'cancel', note);
  sample.rejectionComments = `Cancelled: ${note}`;
  sample.updatedBy = userId;
  await sample.save();
  await notifySampleOwners(sample, {
    eventType: 'sample.cancelled',
    title: 'Sample cancelled',
    message: `${sample.sampleCode} was cancelled: ${note}`,
    excludeUserId: userId,
  });
  return populateSample(sample);
}
