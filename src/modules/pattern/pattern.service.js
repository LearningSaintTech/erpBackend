import { PatternDevelopment } from './pattern.model.js';
import { Design } from '../design/design.model.js';
import { DesignAsset } from '../design/designAsset.model.js';
import { User } from '../user/user.model.js';
import { UserRoleAssignment } from '../user/userRoleAssignment.model.js';
import { Factory } from '../organization/factory.model.js';
import { Material } from '../inventory/material.model.js';
import { NotFoundError, ConflictError, ValidationError, ForbiddenError } from '../../shared/errors/AppError.js';
import { applySoftDeleteFilter } from '../../shared/utils/schema.js';
import { notify } from '../notification/notification.service.js';
import { nextDocumentNumber } from '../../shared/utils/numbering.js';
import { uploadFile } from '../../shared/services/s3.service.js';

const MAX_MARKER_BYTES = 10 * 1024 * 1024;
const CAD_ASSET_TYPES = ['CAD', 'DXF', 'AI', 'MEASUREMENT_SHEET', 'TECHNICAL_SKETCH', 'PATTERN_FILE'];

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function populatePattern(pd) {
  return PatternDevelopment.findById(pd._id)
    .populate('patternMasterId', 'firstName lastName email')
    .populate('designId', 'designCode title status styleNumber');
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

export async function getDesignVerificationEvidence(designId, factoryId) {
  const design = await Design.findOne(applySoftDeleteFilter({ _id: designId, factoryId }))
    .select('designCode title sizeChartData fabricConsumption bomLines status');
  if (!design) throw new NotFoundError('Design not found');

  const hasSizeChart = !!(
    design.sizeChartData?.sizeLabels?.length && design.sizeChartData?.rows?.length
  );
  const hasConsumption = !!(design.fabricConsumption?.length);
  const hasBom = !!(design.bomLines?.length);

  return {
    designId: design._id,
    designCode: design.designCode,
    title: design.title,
    designStatus: design.status,
    hasSizeChart,
    hasConsumption,
    hasBom,
    sizeChartRowCount: design.sizeChartData?.rows?.length ?? 0,
    consumptionLineCount: design.fabricConsumption?.length ?? 0,
    bomLineCount: design.bomLines?.length ?? 0,
    readyForSampling: false,
  };
}

function mapSizeChartRows(sizeChartData) {
  if (!sizeChartData?.rows?.length) return [];
  return sizeChartData.rows.map((row) => ({
    measurementName: row.measurementName,
    values: row.values instanceof Map ? Object.fromEntries(row.values) : (row.values || {}),
  }));
}

export async function getTechPackForPattern(designId, factoryId) {
  const design = await Design.findOne(applySoftDeleteFilter({ _id: designId, factoryId }))
    .select(
      'designCode title styleNumber status category subCategory gender ageGroup fit sleeveType neckType pattern occasion '
      + 'sizeChartData fabricConsumption bomLines qualityNotes productSpecs targetPrice currency releasedVersion currentVersion',
    )
    .lean();
  if (!design) throw new NotFoundError('Design not found');

  const materialIds = [
    ...(design.fabricConsumption || []).map((l) => l.materialId).filter(Boolean),
    ...(design.bomLines || []).map((l) => l.materialId).filter(Boolean),
  ];
  const materials = materialIds.length
    ? await Material.find({ _id: { $in: materialIds } }).select('materialCode name unit category').lean()
    : [];
  const materialMap = Object.fromEntries(materials.map((m) => [String(m._id), m]));

  const assets = await DesignAsset.find(applySoftDeleteFilter({ designId, factoryId }))
    .select('assetType fileName mimeType url createdAt')
    .sort({ createdAt: -1 })
    .lean();

  const evidence = await getDesignVerificationEvidence(designId, factoryId);

  const pd = await PatternDevelopment.findOne(applySoftDeleteFilter({ designId, factoryId }))
    .select('status sizeChartVerified consumptionVerified sampleBomVerified')
    .lean();
  evidence.readyForSampling = pd?.status === 'COMPLETED';

  return {
    design: {
      ...design,
      sizeChartData: design.sizeChartData
        ? { ...design.sizeChartData, rows: mapSizeChartRows(design.sizeChartData) }
        : undefined,
      fabricConsumption: (design.fabricConsumption || []).map((line) => ({
        ...line,
        material: line.materialId ? materialMap[String(line.materialId)] : undefined,
      })),
      bomLines: (design.bomLines || []).map((line) => ({
        ...line,
        material: line.materialId ? materialMap[String(line.materialId)] : undefined,
      })),
    },
    assets,
    cadAssets: assets.filter((a) => CAD_ASSET_TYPES.includes(a.assetType)),
    evidence,
  };
}

export function calculateConsumptionFromMarker(marker, wastagePercent = 0) {
  const length = Number(marker?.length);
  const pieces = Number(marker?.piecesPerMarker);
  if (!length || !pieces || pieces <= 0) return null;
  const base = length / pieces;
  const wastage = Number(wastagePercent) || 0;
  return Math.round(base * (1 + wastage / 100) * 1000) / 1000;
}

function assertAssignedPatternMaster(pd, userId, { isSuperAdmin = false } = {}) {
  if (isSuperAdmin) return;
  const masterId = pd.patternMasterId?.toString?.() || String(pd.patternMasterId || '');
  if (!masterId || masterId !== userId.toString()) {
    throw new ForbiddenError('Only the assigned pattern master can update this development');
  }
}

export async function uploadPatternMarker(
  designId,
  factoryId,
  { fileName, mimeType, contentBase64 },
  userId,
  { isSuperAdmin = false } = {},
) {
  const pd = await PatternDevelopment.findOne(applySoftDeleteFilter({ designId, factoryId }));
  if (!pd) throw new NotFoundError('Pattern development record not found');
  assertAssignedPatternMaster(pd, userId, { isSuperAdmin });
  if (pd.status === 'COMPLETED') throw new ConflictError('Pattern development is completed');

  if (!contentBase64) throw new ValidationError('contentBase64 is required');
  const buffer = Buffer.from(contentBase64, 'base64');
  if (buffer.length > MAX_MARKER_BYTES) {
    throw new ValidationError(`Marker file exceeds ${MAX_MARKER_BYTES / 1024 / 1024}MB limit`);
  }

  const key = `patterns/${factoryId}/${designId}/marker-${Date.now()}-${fileName}`;
  const uploaded = await uploadFile({ key, body: buffer, contentType: mimeType });
  const url = uploaded.mode === 'stub' && mimeType?.startsWith('image/')
    ? `data:${mimeType};base64,${contentBase64}`
    : uploaded.url;

  pd.marker = {
    ...(pd.marker?.toObject?.() ?? pd.marker ?? {}),
    fileName,
    mimeType,
    url,
    uploadedAt: new Date(),
  };
  if (pd.status === 'ASSIGNED') pd.status = 'IN_PROGRESS';
  pd.updatedBy = userId;
  await pd.save();
  return populatePattern(pd);
}

async function assertVerificationEvidence(designId, factoryId, data) {
  const evidence = await getDesignVerificationEvidence(designId, factoryId);
  if (data.sizeChartVerified && !evidence.hasSizeChart) {
    throw new ValidationError('Design has no size chart data — complete the Size Chart tab first');
  }
  if (data.consumptionVerified && !evidence.hasConsumption) {
    throw new ValidationError('Design has no fabric consumption — complete the Fabric tab first');
  }
  if (data.sampleBomVerified && !evidence.hasBom) {
    throw new ValidationError('Design has no BOM lines — complete the BOM tab first');
  }
  return evidence;
}

async function assertAssignee(patternMasterId) {
  const user = await User.findById(patternMasterId).select('firstName lastName email status');
  if (!user) throw new NotFoundError('Pattern master user not found');
  if (user.status !== 'ACTIVE') throw new ConflictError('Pattern master must be an active user');
  return user;
}

export async function assignPatternMaster({ designId, factoryId, patternMasterId }, userId) {
  const design = await Design.findOne(applySoftDeleteFilter({ _id: designId, factoryId }));
  if (!design) throw new NotFoundError('Design not found');
  if (design.status !== 'RELEASED') {
    throw new ConflictError('Design must be RELEASED before pattern assignment');
  }
  await assertAssignee(patternMasterId);

  let pd = await PatternDevelopment.findOne({ designId, factoryId, isDeleted: false });
  if (pd?.status === 'COMPLETED') {
    throw new ConflictError('Pattern development is complete — reopen before reassigning');
  }

  if (pd) {
    pd.patternMasterId = patternMasterId;
    pd.status = 'ASSIGNED';
    pd.assignedAt = new Date();
    pd.sizeChartVerified = false;
    pd.consumptionVerified = false;
    pd.sampleBomVerified = false;
    pd.updatedBy = userId;
    await pd.save();
  } else {
    const factory = await Factory.findById(factoryId);
    const patternDevelopmentCode = await nextDocumentNumber(
      factoryId,
      'PATTERN',
      `PAT-${factory?.code || 'F01'}-`,
    );
    pd = await PatternDevelopment.create({
      organizationId: design.organizationId,
      factoryId,
      patternDevelopmentCode,
      designId,
      patternMasterId,
      status: 'ASSIGNED',
      assignedAt: new Date(),
      createdBy: userId,
      updatedBy: userId,
    });
  }

  await notify({
    organizationId: design.organizationId,
    factoryId,
    userId: patternMasterId,
    eventType: 'pattern.assigned',
    title: 'Pattern assignment',
    message: `You are assigned as pattern master for ${design.designCode}`,
    referenceType: 'PATTERN',
    referenceId: designId,
  });
  return populatePattern(pd);
}

export async function getPatternDevelopment(designId, factoryId) {
  const pd = await PatternDevelopment.findOne(applySoftDeleteFilter({ designId, factoryId }))
    .populate('patternMasterId', 'firstName lastName email')
    .populate('designId', 'designCode title status styleNumber');
  if (!pd) throw new NotFoundError('Pattern development record not found');
  const evidence = await getDesignVerificationEvidence(designId, factoryId);
  return { ...pd.toObject(), evidence };
}

export async function listPatternDevelopments(factoryId, {
  status, patternMasterId, search, page, limit, skip,
}) {
  const filter = applySoftDeleteFilter({ factoryId });
  if (status) filter.status = status;
  if (patternMasterId) filter.patternMasterId = patternMasterId;

  if (search?.trim()) {
    const re = new RegExp(escapeRegex(search.trim()), 'i');
    const designs = await Design.find({
      factoryId,
      isDeleted: false,
      $or: [{ designCode: re }, { title: re }, { styleNumber: re }],
    }).select('_id');
    filter.designId = { $in: designs.map((d) => d._id) };
  }

  const [items, total] = await Promise.all([
    PatternDevelopment.find(filter)
      .populate('designId', 'designCode title styleNumber')
      .populate('patternMasterId', 'firstName lastName email')
      .skip(skip)
      .limit(limit)
      .sort({ updatedAt: -1 }),
    PatternDevelopment.countDocuments(filter),
  ]);
  return { items, total };
}

export async function getPatternStats(factoryId) {
  const base = applySoftDeleteFilter({ factoryId });
  const [total, assigned, inProgress, completed] = await Promise.all([
    PatternDevelopment.countDocuments(base),
    PatternDevelopment.countDocuments({ ...base, status: 'ASSIGNED' }),
    PatternDevelopment.countDocuments({ ...base, status: 'IN_PROGRESS' }),
    PatternDevelopment.countDocuments({ ...base, status: 'COMPLETED' }),
  ]);
  return { total, assigned, inProgress, completed };
}

export async function updatePatternDevelopment(designId, factoryId, data, userId, { isSuperAdmin = false } = {}) {
  const pd = await PatternDevelopment.findOne(applySoftDeleteFilter({ designId, factoryId }));
  if (!pd) throw new NotFoundError('Pattern development record not found');
  assertAssignedPatternMaster(pd, userId, { isSuperAdmin });
  if (pd.status === 'COMPLETED') throw new ConflictError('Pattern development is completed');

  const verificationPatch = {};
  if (data.sizeChartVerified !== undefined) verificationPatch.sizeChartVerified = data.sizeChartVerified;
  if (data.consumptionVerified !== undefined) verificationPatch.consumptionVerified = data.consumptionVerified;
  if (data.sampleBomVerified !== undefined) verificationPatch.sampleBomVerified = data.sampleBomVerified;
  if (Object.keys(verificationPatch).length) {
    await assertVerificationEvidence(designId, factoryId, verificationPatch);
  }

  const allowed = [
    'marker', 'patternNotes', 'grading', 'calculatedConsumption',
    'sizeChartVerified', 'consumptionVerified', 'sampleBomVerified',
  ];
  for (const key of allowed) {
    if (data[key] !== undefined) pd[key] = data[key];
  }

  if (data.marker && data.calculatedConsumption?.derivedFromMarker) {
    const meters = calculateConsumptionFromMarker(
      { ...pd.marker?.toObject?.(), ...data.marker },
      data.calculatedConsumption?.wastagePercent ?? pd.calculatedConsumption?.wastagePercent,
    );
    if (meters != null) {
      pd.calculatedConsumption = {
        ...(pd.calculatedConsumption?.toObject?.() ?? pd.calculatedConsumption ?? {}),
        ...data.calculatedConsumption,
        metersPerGarment: meters,
        derivedFromMarker: true,
      };
    }
  }
  if (pd.status === 'ASSIGNED') pd.status = 'IN_PROGRESS';
  pd.updatedBy = userId;
  await pd.save();
  return populatePattern(pd);
}

export async function completePatternDevelopment(designId, factoryId, userId, { isSuperAdmin = false } = {}) {
  const pd = await PatternDevelopment.findOne(applySoftDeleteFilter({ designId, factoryId }));
  if (!pd) throw new NotFoundError('Pattern development record not found');
  assertAssignedPatternMaster(pd, userId, { isSuperAdmin });
  if (pd.status === 'COMPLETED') throw new ConflictError('Already completed');

  const evidence = await getDesignVerificationEvidence(designId, factoryId);
  if (!evidence.hasSizeChart || !evidence.hasConsumption || !evidence.hasBom) {
    throw new ConflictError('Design must have size chart, fabric consumption, and BOM before completion');
  }
  if (!pd.sizeChartVerified || !pd.consumptionVerified || !pd.sampleBomVerified) {
    throw new ConflictError('Size chart, consumption, and sample BOM must be verified before completion');
  }
  if (!pd.marker?.length || !pd.calculatedConsumption?.metersPerGarment) {
    throw new ConflictError('Marker dimensions and calculated consumption must be saved before completion');
  }
  if (!pd.grading?.baseSize) {
    throw new ConflictError('Grading plan (base size) must be saved before completion');
  }

  pd.status = 'COMPLETED';
  pd.completedAt = new Date();
  pd.updatedBy = userId;
  await pd.save();

  const design = await Design.findOne(applySoftDeleteFilter({ _id: designId, factoryId }))
    .select('designCode title');
  if (design) {
    await notifyUsersWithPermission({
      organizationId: pd.organizationId,
      factoryId,
      permission: 'sampling.create',
      excludeUserId: userId,
      eventType: 'pattern.completed',
      title: 'Pattern ready for sampling',
      message: `${design.designCode} — pattern development is complete. Create a sample to continue the pipeline.`,
      referenceType: 'DESIGN',
      referenceId: designId,
    });
  }

  return populatePattern(pd);
}

export async function reopenPatternDevelopment(designId, factoryId, userId, { reason, fromFitSampleId } = {}) {
  const pd = await PatternDevelopment.findOne(applySoftDeleteFilter({ designId, factoryId }));
  if (!pd) throw new NotFoundError('Pattern development record not found');
  if (pd.status !== 'COMPLETED' && !fromFitSampleId) {
    throw new ConflictError('Only completed pattern development can be reopened');
  }

  pd.status = 'IN_PROGRESS';
  pd.completedAt = undefined;
  pd.sizeChartVerified = false;
  pd.consumptionVerified = false;
  pd.sampleBomVerified = false;
  if (reason) {
    const prefix = fromFitSampleId ? '[Fit revision] ' : '[Reopened] ';
    pd.patternNotes = `${prefix}${reason}${pd.patternNotes ? `\n${pd.patternNotes}` : ''}`;
  }
  pd.updatedBy = userId;
  await pd.save();

  if (fromFitSampleId && pd.patternMasterId) {
    await notify({
      organizationId: pd.organizationId,
      factoryId,
      userId: pd.patternMasterId,
      eventType: 'pattern.fit_revision',
      title: 'Pattern revision required',
      message: reason || 'Fit sample failed — pattern corrections needed',
      referenceType: 'PATTERN',
      referenceId: designId,
    });
  }

  return populatePattern(pd);
}

export async function reopenPatternForFit(designId, factoryId, userId, { sampleId, reason }) {
  if (!reason?.trim()) throw new ValidationError('Reason is required');
  return reopenPatternDevelopment(designId, factoryId, userId, {
    reason: reason.trim(),
    fromFitSampleId: sampleId,
  });
}
