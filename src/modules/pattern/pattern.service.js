import { PatternDevelopment } from './pattern.model.js';
import { Design } from '../design/design.model.js';
import { DesignAsset } from '../design/designAsset.model.js';
import { User } from '../user/user.model.js';
import { UserRoleAssignment } from '../user/userRoleAssignment.model.js';
import { Role } from '../user/role.model.js';
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

function plainSizeChart(sizeChartData) {
  if (!sizeChartData) return undefined;
  const obj = sizeChartData.toObject?.() ?? sizeChartData;
  return { ...obj, rows: mapSizeChartRows(obj) };
}

function plainLines(lines) {
  return (lines || []).map((l) => l.toObject?.() ?? l);
}

/**
 * Production tech pack owned by the pattern master. Legacy designs that still carry
 * the fields inline fall back to the design copy until a pattern master saves their own.
 */
const TECH_PACK_SECTIONS = 'sizeChartData fabricConsumption bomLines accessories '
  + 'fabricSpecs qualityNotes manufacturingNotes costing productionInfo';

function plainSection(section) {
  return section?.toObject?.() ?? section ?? undefined;
}

export async function getPatternTechPack(designId, factoryId) {
  const pd = await PatternDevelopment.findOne(applySoftDeleteFilter({ designId, factoryId }))
    .select(`${TECH_PACK_SECTIONS} status`);
  if (pd && (pd.sizeChartData?.rows?.length || pd.fabricConsumption?.length || pd.bomLines?.length)) {
    return {
      source: 'pattern',
      patternStatus: pd.status,
      sizeChartData: plainSizeChart(pd.sizeChartData),
      fabricConsumption: plainLines(pd.fabricConsumption),
      bomLines: plainLines(pd.bomLines),
      accessories: plainLines(pd.accessories),
      fabricSpecs: plainSection(pd.fabricSpecs),
      qualityNotes: plainSection(pd.qualityNotes),
      manufacturingNotes: plainSection(pd.manufacturingNotes),
      costing: plainSection(pd.costing),
      productionInfo: plainSection(pd.productionInfo),
    };
  }
  const design = await Design.findOne(applySoftDeleteFilter({ _id: designId, factoryId }))
    .select(`${TECH_PACK_SECTIONS} productSpecs`);
  const specs = plainSection(design?.productSpecs);
  return {
    source: design ? 'design_legacy' : 'none',
    patternStatus: pd?.status,
    sizeChartData: plainSizeChart(design?.sizeChartData),
    fabricConsumption: plainLines(design?.fabricConsumption),
    bomLines: plainLines(design?.bomLines),
    accessories: plainLines(design?.accessories),
    fabricSpecs: specs && {
      fabricGsm: specs.fabricGsm,
      fabricWidth: specs.fabricWidth,
      fabricFinish: specs.fabricFinish,
      shrinkagePercent: specs.shrinkagePercent,
    },
    qualityNotes: plainSection(design?.qualityNotes),
    manufacturingNotes: plainSection(design?.manufacturingNotes),
    costing: plainSection(design?.costing),
    productionInfo: plainSection(design?.productionInfo),
  };
}

export async function getDesignVerificationEvidence(designId, factoryId) {
  const design = await Design.findOne(applySoftDeleteFilter({ _id: designId, factoryId }))
    .select('designCode title status');
  if (!design) throw new NotFoundError('Design not found');

  const techPack = await getPatternTechPack(designId, factoryId);
  const hasSizeChart = !!(
    techPack.sizeChartData?.sizeLabels?.length && techPack.sizeChartData?.rows?.length
  );
  const hasConsumption = !!(techPack.fabricConsumption?.length);
  const hasBom = !!(techPack.bomLines?.length);

  return {
    designId: design._id,
    designCode: design.designCode,
    title: design.title,
    designStatus: design.status,
    source: techPack.source,
    hasSizeChart,
    hasConsumption,
    hasBom,
    sizeChartRowCount: techPack.sizeChartData?.rows?.length ?? 0,
    consumptionLineCount: techPack.fabricConsumption?.length ?? 0,
    bomLineCount: techPack.bomLines?.length ?? 0,
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
      + 'sizeChartData accessories colorVariants qualityNotes productSpecs targetPrice currency releasedVersion currentVersion',
    )
    .lean();
  if (!design) throw new NotFoundError('Design not found');

  const techPack = await getPatternTechPack(designId, factoryId);

  const materialIds = [
    ...techPack.fabricConsumption.map((l) => l.materialId).filter(Boolean),
    ...techPack.bomLines.map((l) => l.materialId).filter(Boolean),
    ...(techPack.accessories || []).map((l) => l.materialId).filter(Boolean),
  ];
  const materials = materialIds.length
    ? await Material.find({ _id: { $in: materialIds } }).select('materialCode name unit category').lean()
    : [];
  const materialMap = Object.fromEntries(materials.map((m) => [String(m._id), m]));
  const withMaterial = (line) => ({
    ...line,
    material: line.materialId ? materialMap[String(line.materialId)] : undefined,
  });

  const assets = await DesignAsset.find(applySoftDeleteFilter({ designId, factoryId }))
    .select('assetType fileName mimeType url createdAt')
    .sort({ createdAt: -1 })
    .lean();

  const evidence = await getDesignVerificationEvidence(designId, factoryId);
  evidence.readyForSampling = techPack.patternStatus === 'COMPLETED';

  return {
    design: {
      ...design,
      // Designer size range only — the graded chart below belongs to the pattern master.
      sizeChartData: design.sizeChartData
        ? { ...design.sizeChartData, rows: mapSizeChartRows(design.sizeChartData) }
        : undefined,
      // Kept for older UI reads; authoritative copies live on `techPack`.
      accessories: (techPack.accessories || []).map(withMaterial),
      fabricConsumption: techPack.fabricConsumption.map(withMaterial),
      bomLines: techPack.bomLines.map(withMaterial),
    },
    techPack: {
      source: techPack.source,
      sizeChartData: techPack.sizeChartData,
      fabricConsumption: techPack.fabricConsumption.map(withMaterial),
      bomLines: techPack.bomLines.map(withMaterial),
      accessories: (techPack.accessories || []).map(withMaterial),
      fabricSpecs: techPack.fabricSpecs,
      qualityNotes: techPack.qualityNotes,
      manufacturingNotes: techPack.manufacturingNotes,
      costing: techPack.costing,
      productionInfo: techPack.productionInfo,
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
    throw new ValidationError('No graded size chart yet — fill the Size chart step first');
  }
  if (data.consumptionVerified && !evidence.hasConsumption) {
    throw new ValidationError('No fabric consumption yet — fill the Fabric step first');
  }
  if (data.sampleBomVerified && !evidence.hasBom) {
    throw new ValidationError('No BOM lines yet — fill the BOM step first');
  }
  return evidence;
}

/**
 * A new pattern record starts from the designer's size range plus anything a legacy
 * design still carries inline, so the pattern master edits instead of retyping.
 */
function seedTechPackFromDesign(design) {
  const seed = {};
  const labels = design.sizeChartData?.sizeLabels || [];
  const rows = design.sizeChartData?.rows || [];
  if (labels.length || rows.length) {
    seed.sizeChartData = {
      unit: design.sizeChartData?.unit || 'INCHES',
      sizeLabels: [...labels],
      rows: mapSizeChartRows(design.sizeChartData),
    };
  }
  if (design.fabricConsumption?.length) {
    seed.fabricConsumption = design.fabricConsumption.map((l) => l.toObject?.() ?? l);
  }
  if (design.bomLines?.length) {
    seed.bomLines = design.bomLines.map((l) => l.toObject?.() ?? l);
  }
  if (design.accessories?.length) {
    seed.accessories = design.accessories.map((l) => l.toObject?.() ?? l);
  }

  // Fabric technicals started life on the designer's product specs.
  const specs = design.productSpecs?.toObject?.() ?? design.productSpecs;
  if (specs) {
    const fabricSpecs = {
      fabricGsm: specs.fabricGsm,
      fabricWidth: specs.fabricWidth,
      fabricFinish: specs.fabricFinish,
      shrinkagePercent: specs.shrinkagePercent,
    };
    if (Object.values(fabricSpecs).some((v) => v != null && v !== '')) {
      seed.fabricSpecs = fabricSpecs;
    }
  }

  for (const key of ['qualityNotes', 'manufacturingNotes', 'costing', 'productionInfo']) {
    const val = design[key]?.toObject?.() ?? design[key];
    if (val && Object.values(val).some((v) => v != null && v !== '' && v !== 0 && v !== false)) {
      seed[key] = val;
    }
  }
  return seed;
}

/** Fabric + trim costs follow the pattern master's consumption figures. */
function recomputePatternCosting(pd) {
  const costing = pd.costing?.toObject?.() ?? pd.costing ?? {};

  costing.fabricCost = (pd.fabricConsumption || []).reduce((sum, f) => {
    const qty = (f.consumption || 0) * (1 + (f.wastagePercent || 0) / 100);
    return sum + qty * (f.fabricCost || 0);
  }, 0);
  costing.accessoriesCost = (pd.accessories || []).reduce(
    (sum, a) => sum + (a.consumption || 0) * (a.unitCost || 0),
    0,
  );

  const total = (costing.fabricCost || 0) + (costing.accessoriesCost || 0)
    + (costing.printingCost || 0) + (costing.embroideryCost || 0)
    + (costing.laborCost || 0) + (costing.packingCost || 0) + (costing.overhead || 0);
  costing.actualCost = Math.round(total * 100) / 100;

  pd.costing = costing;
}

async function assertAssignee(patternMasterId) {
  const user = await User.findById(patternMasterId).select('firstName lastName email status');
  if (!user) throw new NotFoundError('Pattern master user not found');
  if (user.status !== 'ACTIVE') throw new ConflictError('Pattern master must be an active user');
  return user;
}

/** Active users with PATTERN_MASTER on this factory — used by release modal and assign form. */
export async function listPatternMasters({ factoryId, organizationId }) {
  const role = await Role.findOne({ organizationId, code: 'PATTERN_MASTER' })
    || await Role.findOne({ code: 'PATTERN_MASTER', organizationId: null, isSystem: true });
  if (!role) return [];

  const now = new Date();
  const assignments = await UserRoleAssignment.find({
    roleId: role._id,
    factoryId,
    organizationId,
    $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }, { expiresAt: { $gt: now } }],
  })
    .populate('userId', 'firstName lastName email status')
    .sort({ assignedAt: -1 });

  const seen = new Set();
  const users = [];
  for (const a of assignments) {
    const u = a.userId;
    if (!u || typeof u === 'string' || u.status === 'INACTIVE') continue;
    const id = String(u._id);
    if (seen.has(id)) continue;
    seen.add(id);
    users.push(u);
  }
  return users;
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
      ...seedTechPackFromDesign(design),
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
    'sizeChartData', 'fabricConsumption', 'bomLines', 'accessories',
    'fabricSpecs', 'qualityNotes', 'manufacturingNotes', 'costing', 'productionInfo',
    'sizeChartVerified', 'consumptionVerified', 'sampleBomVerified',
  ];
  for (const key of allowed) {
    if (data[key] !== undefined) pd[key] = data[key];
  }

  if (data.costing !== undefined || data.accessories !== undefined || data.fabricConsumption !== undefined) {
    recomputePatternCosting(pd);
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
      const fabrics = (pd.fabricConsumption || []).map((l) => l.toObject?.() ?? l);
      if (fabrics.length) {
        fabrics[0].consumption = meters;
        if (!fabrics[0].unit) fabrics[0].unit = 'm';
        pd.fabricConsumption = fabrics;
        recomputePatternCosting(pd);
      }
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
    const missing = [
      !evidence.hasSizeChart && 'graded size chart',
      !evidence.hasConsumption && 'fabric consumption',
      !evidence.hasBom && 'BOM',
    ].filter(Boolean);
    throw new ConflictError(`Pattern tech pack incomplete — fill ${missing.join(', ')} before completion`);
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
