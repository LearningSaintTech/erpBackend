import { Design, DesignCollection } from './design.model.js';
import { DesignAsset } from './designAsset.model.js';
import { DesignVersion } from './designVersion.model.js';
import { ApprovalInstance } from '../approval/approvalInstance.model.js';
import { Season } from './season.model.js';
import { SizeChart } from './sizeChart.model.js';
import { Factory } from '../organization/factory.model.js';
import { nextDocumentNumber } from '../../shared/utils/numbering.js';
import { NotFoundError, ConflictError, ValidationError, ForbiddenError } from '../../shared/errors/AppError.js';
import { applySoftDeleteFilter } from '../../shared/utils/schema.js';
import { submitForApproval } from '../approval/approval.service.js';
import {
  syncApprovalApproved,
  syncApprovalRejected,
  syncApprovalRevisionRequested,
} from '../../shared/services/approvalSync.js';
import { notify } from '../notification/notification.service.js';
import { findUserIdsWithFactoryPermission } from '../user/user.service.js';
import { User } from '../user/user.model.js';
import { emitDesignUpdated } from '../../shared/services/realtime.js';
import { uploadFile } from '../../shared/services/s3.service.js';
import {
  getDesignLookups,
  normalizeAssetType,
  SINGLE_SLOT_ASSET_TYPES,
} from '../../config/designLookups.js';
import {
  autoFillSkusForDesign,
  validateGeneratedSkus,
} from '../sku/skuGeneration.service.js';


async function applySkuPipeline(design, { overwriteExisting = false, excludeDesignId } = {}) {
  if (!design.collectionId || !design.styleNumber?.trim()) return;
  if (!design.colorVariants?.length) return;
  await autoFillSkusForDesign(design, { overwriteExisting });
  await validateGeneratedSkus(design, { excludeDesignId });
}

async function assertStyleNumberUnique(design) {
  if (!design.styleNumber?.trim() || !design.collectionId) return;
  const existing = await Design.findOne({
    factoryId: design.factoryId,
    collectionId: design.collectionId,
    styleNumber: design.styleNumber.trim(),
    _id: { $ne: design._id },
    isDeleted: false,
  }).select('_id designCode');
  if (existing) {
    throw new ConflictError('Style number already exists in this collection');
  }
}

async function nextCloneStyleNumber(source) {
  const base = source.styleNumber?.trim();
  if (!base) return undefined;
  let candidate = `${base}-COPY`;
  let n = 2;
  while (await Design.findOne({
    factoryId: source.factoryId,
    collectionId: source.collectionId,
    styleNumber: candidate,
    isDeleted: false,
  })) {
    candidate = `${base}-COPY-${n++}`;
  }
  return candidate;
}

async function cloneDesignAssets(sourceId, clonedId, userId, organizationId, factoryId) {
  const assets = await DesignAsset.find(applySoftDeleteFilter({ designId: sourceId }));
  if (!assets.length) return;
  await DesignAsset.insertMany(assets.map((a) => ({
    organizationId,
    factoryId,
    designId: clonedId,
    assetType: a.assetType,
    fileName: a.fileName,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
    url: a.url,
    createdBy: userId,
    updatedBy: userId,
  })));
}

const MAX_ASSET_BYTES = 10 * 1024 * 1024;

const IMAGE_ASSET_TYPES = [
  'FRONT_IMAGE', 'BACK_IMAGE', 'SIDE_IMAGE', 'ZOOM_IMAGE',
  'TECHNICAL_SKETCH', 'IMAGE', 'SKETCH',
];

const VERSION_TRACKED_FIELDS = [
  'title', 'description', 'skuPrefix', 'styleNumber', 'skuCodeInputs', 'category', 'subCategory', 'gender', 'ageGroup',
  'fit', 'sleeveType', 'neckType', 'pattern', 'occasion', 'tags',
  'collectionId', 'seasonId', 'sizeChartId', 'sizeChartData', 'targetPrice', 'currency',
  'productSpecs', 'colorVariants', 'fabricConsumption', 'fabricSuggestions',
  'accessories', 'bomLines', 'costing', 'productionInfo', 'qualityNotes', 'manufacturingNotes',
];

const FIELD_LABELS = {
  colorVariants: 'Color Changed',
  fabricConsumption: 'Fabric Changed',
  fabricSuggestions: 'Fabric Changed',
  accessories: 'Accessories Changed',
  bomLines: 'BOM Changed',
  sizeChartData: 'Size Chart Changed',
  productSpecs: 'Specifications Changed',
  costing: 'Costing Changed',
  productionInfo: 'Production Info Changed',
  qualityNotes: 'Quality Notes Changed',
  manufacturingNotes: 'Manufacturing Notes Changed',
  tags: 'Tags Changed',
};

/** Factory admin, super admin, and design managers see every designer's work */
export function canViewAllDesigns(permissions = [], isSuperAdmin = false) {
  if (isSuperAdmin) return true;
  if (permissions.includes('*')) return true;
  return permissions.includes('user.read') || permissions.includes('design.approve');
}

function mapToObject(val) {
  if (!val) return val;
  if (val instanceof Map) return Object.fromEntries(val);
  if (Array.isArray(val)) return val.map(mapToObject);
  if (typeof val === 'object' && val._id) return val._id.toString();
  if (typeof val === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(val)) out[k] = mapToObject(v);
    return out;
  }
  return val;
}

function stableStringify(obj) {
  return JSON.stringify(mapToObject(obj));
}

function migrateFabricOnRead(design) {
  const obj = design.toObject ? design.toObject() : { ...design };
  if ((!obj.fabricConsumption || obj.fabricConsumption.length === 0) && obj.fabricSuggestions?.length) {
    obj.fabricConsumption = obj.fabricSuggestions.map((f) => ({
      materialId: f.materialId,
      consumption: f.quantityPerPiece ?? 1,
      unit: f.unit || 'METERS',
      wastagePercent: 0,
      fabricCost: 0,
      approvedVendor: false,
    }));
  }
  if (obj.sizeChartData?.rows) {
    obj.sizeChartData.rows = obj.sizeChartData.rows.map((row) => ({
      measurementName: row.measurementName,
      values: row.values instanceof Map ? Object.fromEntries(row.values) : row.values,
    }));
  }
  return obj;
}

export function recomputeCosting(design) {
  const fabricTotal = (design.fabricConsumption || []).reduce((sum, f) => {
    const qty = (f.consumption || 0) * (1 + (f.wastagePercent || 0) / 100);
    return sum + qty * (f.fabricCost || 0);
  }, 0);

  const accessoriesTotal = (design.accessories || []).reduce((sum, a) => {
    return sum + (a.consumption || a.quantity || 0) * (a.unitCost || 0);
  }, 0);

  if (!design.costing) design.costing = {};
  design.costing.fabricCost = fabricTotal;
  design.costing.accessoriesCost = accessoriesTotal;

  const c = design.costing;
  const actualCost = (c.fabricCost || 0) + (c.accessoriesCost || 0)
    + (c.printingCost || 0) + (c.embroideryCost || 0) + (c.laborCost || 0)
    + (c.packingCost || 0) + (c.overhead || 0);
  c.actualCost = Math.round(actualCost * 100) / 100;

  const selling = c.expectedSellingPrice || design.targetPrice || 0;
  c.margin = selling ? Math.round((selling - c.actualCost) * 100) / 100 : 0;
}

function detectChangeSummary(before, after) {
  const summaries = [];
  for (const field of VERSION_TRACKED_FIELDS) {
    const b = before[field];
    const a = after[field];
    if (stableStringify(b) !== stableStringify(a)) {
      summaries.push(FIELD_LABELS[field] || `${field} updated`);
    }
  }
  if (summaries.length === 0) return 'Updated';
  return [...new Set(summaries)].slice(0, 3).join('; ');
}

async function saveVersionSnapshot(design, userId, changeSummary) {
  const snapshot = migrateFabricOnRead(design);
  delete snapshot.assets;
  await DesignVersion.create({
    organizationId: design.organizationId,
    factoryId: design.factoryId,
    designId: design._id,
    version: design.currentVersion,
    changeSummary,
    snapshot,
    createdBy: userId,
    updatedBy: userId,
  });
}

function buildDesignSnapshot(designDoc) {
  const snap = migrateFabricOnRead(designDoc);
  const allowed = [...VERSION_TRACKED_FIELDS, 'designCode', 'factoryId', 'organizationId'];
  const data = {};
  for (const key of allowed) {
    if (snap[key] !== undefined) data[key] = snap[key];
  }
  return data;
}

export function getLookups() {
  return getDesignLookups();
}

export async function createDesign(data, userId) {
  const factory = await Factory.findById(data.factoryId);
  if (!factory) throw new NotFoundError('Factory not found');
  const prefix = `DSN-${factory.code}-`;
  const designCode = await nextDocumentNumber(data.factoryId, 'DESIGN', prefix);
  const design = await Design.create({
    ...data,
    designCode,
    status: 'DRAFT',
    currentVersion: 1,
    createdBy: userId,
    updatedBy: userId,
  });
  await assertStyleNumberUnique(design);
  recomputeCosting(design);
  await design.save();
  await saveVersionSnapshot(design, userId, 'Initial Design');
  return getDesign(design._id, { factoryId: data.factoryId });
}

export async function listDesigns(factoryId, {
  status, category, collectionId, seasonId, gender, tags, search, page, limit, skip, viewer, permissions,
}) {
  const filter = applySoftDeleteFilter({ factoryId });
  if (status) filter.status = status;
  if (category) filter.category = category;
  if (collectionId) filter.collectionId = collectionId;
  if (seasonId) filter.seasonId = seasonId;
  if (gender) filter.gender = gender;
  if (tags) {
    const tagList = tags.split(',').map((t) => t.trim()).filter(Boolean);
    if (tagList.length) filter.tags = { $in: tagList };
  }
  if (search?.trim()) {
    const re = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [
      { title: re },
      { designCode: re },
      { styleNumber: re },
      { skuPrefix: re },
    ];
  }
  if (viewer && !canViewAllDesigns(permissions, viewer.isSuperAdmin)) {
    filter.createdBy = viewer._id;
  }
  const [items, total] = await Promise.all([
    Design.find(filter)
      .populate('collectionId', 'name code')
      .populate('seasonId', 'name year')
      .populate('createdBy', 'firstName lastName email')
      .skip(skip)
      .limit(limit)
      .sort({ collectionId: 1, styleNumber: 1, createdAt: -1 }),
    Design.countDocuments(filter),
  ]);
  return { items: items.map(migrateFabricOnRead), total };
}

export async function getDesign(id, { factoryId, viewer, permissions } = {}) {
  const filter = applySoftDeleteFilter({ _id: id });
  if (factoryId) filter.factoryId = factoryId;
  if (viewer && !canViewAllDesigns(permissions, viewer.isSuperAdmin)) {
    filter.createdBy = viewer._id;
  }
  const design = await Design.findOne(filter)
    .populate('collectionId', 'name')
    .populate('seasonId', 'name year')
    .populate('sizeChartId')
    .populate('createdBy', 'firstName lastName email');
  if (!design) throw new NotFoundError('Design not found');
  const assets = await DesignAsset.find(applySoftDeleteFilter({ designId: design._id })).sort({ createdAt: 1 });
  const versionCount = await DesignVersion.countDocuments({ designId: design._id });
  return { ...migrateFabricOnRead(design), assets, versionCount };
}

async function getDesignDoc(id, factoryId) {
  const filter = applySoftDeleteFilter({ _id: id });
  if (factoryId) filter.factoryId = factoryId;
  const design = await Design.findOne(filter);
  if (!design) throw new NotFoundError('Design not found');
  return design;
}

function assertCanEditDesign(design, viewer, permissions) {
  if (!viewer) return;
  if (canViewAllDesigns(permissions, viewer?.isSuperAdmin)) return;
  if (design.createdBy?.toString() !== viewer._id.toString()) {
    throw new ForbiddenError('You can only edit your own designs');
  }
}

export async function updateDesign(id, data, userId, { factoryId, viewer, permissions } = {}) {
  const design = await getDesignDoc(id, factoryId);
  assertCanEditDesign(design, viewer, permissions);
  if (design.status !== 'DRAFT' && design.status !== 'REVISION_REQUESTED') {
    throw new ConflictError('Only DRAFT or REVISION_REQUESTED designs can be edited');
  }

  const before = buildDesignSnapshot(design);
  const allowed = VERSION_TRACKED_FIELDS;
  for (const key of allowed) {
    if (data[key] !== undefined) design[key] = data[key];
  }
  if (data.fabricConsumption !== undefined) design.fabricSuggestions = [];

  recomputeCosting(design);
  await assertStyleNumberUnique(design);
  const after = buildDesignSnapshot(design);
  const changeSummary = detectChangeSummary(before, after);

  design.currentVersion = (design.currentVersion || 1) + 1;
  design.updatedBy = userId;
  design.updatedAt = new Date();
  await design.save();
  await saveVersionSnapshot(design, userId, changeSummary);
  return getDesign(id, { factoryId, viewer, permissions });
}

export async function getDesignStats(factoryId, { viewer, permissions } = {}) {
  const filter = applySoftDeleteFilter({ factoryId });
  if (viewer && !canViewAllDesigns(permissions, viewer.isSuperAdmin)) {
    filter.createdBy = viewer._id;
  }
  const [total, inReview, released, draft] = await Promise.all([
    Design.countDocuments(filter),
    Design.countDocuments({ ...filter, status: 'IN_REVIEW' }),
    Design.countDocuments({ ...filter, status: 'RELEASED' }),
    Design.countDocuments({ ...filter, status: { $in: ['DRAFT', 'REVISION_REQUESTED'] } }),
  ]);
  return { total, inReview, released, draft };
}

export async function submitDesign(id, userId, { factoryId, viewer, permissions } = {}) {
  const design = await getDesignDoc(id, factoryId);
  assertCanEditDesign(design, viewer, permissions);
  if (design.status !== 'DRAFT' && design.status !== 'REVISION_REQUESTED') {
    throw new ConflictError('Invalid status for submit');
  }
  const imageCount = await DesignAsset.countDocuments({
    designId: design._id,
    assetType: { $in: IMAGE_ASSET_TYPES },
    isDeleted: false,
  });
  if (imageCount === 0) {
    throw new ValidationError('At least one image or sketch is required before submission');
  }
  const hasSizeChart = !!(
    design.sizeChartData?.sizeLabels?.length && design.sizeChartData?.rows?.length
  );
  const hasConsumption = !!(design.fabricConsumption?.length);
  const hasBom = !!(design.bomLines?.length);
  if (!hasSizeChart || !hasConsumption || !hasBom) {
    const missing = [
      !hasSizeChart && 'Size Chart',
      !hasConsumption && 'Fabric consumption',
      !hasBom && 'BOM',
    ].filter(Boolean);
    throw new ValidationError(
      `Tech pack incomplete — fill ${missing.join(', ')} on the design before submit`,
    );
  }
  design.status = 'IN_REVIEW';
  design.submittedAt = new Date();
  design.updatedBy = userId;
  await design.save();
  await submitForApproval({
    organizationId: design.organizationId,
    factoryId: design.factoryId,
    documentType: 'DESIGN',
    documentId: design._id,
    submittedBy: userId,
  });

  const approverIds = await findUserIdsWithFactoryPermission(
    design.factoryId,
    ['design.approve', 'approval.approve'],
    { excludeUserId: userId },
  );
  await Promise.all(approverIds.map((approverId) => notify({
    organizationId: design.organizationId,
    factoryId: design.factoryId,
    userId: approverId,
    eventType: 'design.submitted',
    title: 'Design submitted for approval',
    message: `${design.designCode} — ${design.title} is awaiting your review`,
    referenceType: 'DESIGN',
    referenceId: design._id,
  })));

  emitDesignUpdated(design, { actorId: userId });
  return design;
}

export async function approveDesign(id, userId, { syncApproval = true } = {}) {
  const design = await Design.findOne(applySoftDeleteFilter({ _id: id }));
  if (!design) throw new NotFoundError('Design not found');
  if (!['SUBMITTED', 'IN_REVIEW'].includes(design.status)) {
    throw new ConflictError('Design not in review');
  }
  if (syncApproval) {
    await syncApprovalApproved('DESIGN', design._id, userId);
  }
  design.status = 'APPROVED';
  design.approvedAt = new Date();
  design.approvedBy = userId;
  design.updatedBy = userId;
  await design.save();
  if (design.createdBy) {
    await notify({
      organizationId: design.organizationId,
      factoryId: design.factoryId,
      userId: design.createdBy,
      eventType: 'design.approved',
      title: 'Design approved',
      message: `${design.designCode} — ${design.title} has been approved`,
      referenceType: 'DESIGN',
      referenceId: design._id,
    });
  }
  emitDesignUpdated(design, { actorId: userId });
  return design;
}

export async function rejectDesign(id, userId, comments, { syncApproval = true } = {}) {
  const design = await Design.findOne(applySoftDeleteFilter({ _id: id }));
  if (!design) throw new NotFoundError('Design not found');
  if (!['SUBMITTED', 'IN_REVIEW'].includes(design.status)) {
    throw new ConflictError('Design not in review');
  }
  if (syncApproval) {
    await syncApprovalRejected('DESIGN', design._id, userId, comments);
  }
  design.status = 'REJECTED';
  design.rejectionComments = comments;
  design.updatedBy = userId;
  await design.save();
  if (design.createdBy) {
    await notify({
      organizationId: design.organizationId,
      factoryId: design.factoryId,
      userId: design.createdBy,
      eventType: 'design.rejected',
      title: 'Design rejected',
      message: comments?.trim()
        ? `${design.designCode} — ${design.title} was rejected: ${comments.trim()}`
        : `${design.designCode} — ${design.title} was rejected`,
      referenceType: 'DESIGN',
      referenceId: design._id,
    });
  }
  emitDesignUpdated(design, { actorId: userId });
  return design;
}

export async function requestRevision(id, userId, comments, { syncApproval = true } = {}) {
  const design = await Design.findOne(applySoftDeleteFilter({ _id: id }));
  if (!design) throw new NotFoundError('Design not found');
  if (!['SUBMITTED', 'IN_REVIEW'].includes(design.status)) {
    throw new ConflictError('Design not in review');
  }
  if (syncApproval) {
    await syncApprovalRevisionRequested('DESIGN', design._id, userId, comments);
  }
  design.status = 'REVISION_REQUESTED';
  design.revisionComments = comments;
  design.updatedBy = userId;
  await design.save();
  if (design.createdBy) {
    await notify({
      organizationId: design.organizationId,
      factoryId: design.factoryId,
      userId: design.createdBy,
      eventType: 'design.revision_requested',
      title: 'Revision requested',
      message: comments?.trim()
        ? `${design.designCode} — ${design.title} needs revision: ${comments.trim()}`
        : `${design.designCode} — ${design.title} needs revision`,
      referenceType: 'DESIGN',
      referenceId: design._id,
    });
  }
  emitDesignUpdated(design, { actorId: userId });
  return design;
}

export async function releaseDesign(id, userId) {
  const design = await Design.findOne(applySoftDeleteFilter({ _id: id }));
  if (!design) throw new NotFoundError('Design not found');
  if (design.status !== 'APPROVED') {
    throw new ConflictError('Only APPROVED designs can be released');
  }
  const versionRecord = await DesignVersion.findOne({ designId: design._id, version: design.currentVersion });
  if (versionRecord) {
    versionRecord.released = true;
    versionRecord.releasedAt = new Date();
    versionRecord.updatedBy = userId;
    await versionRecord.save();
  } else {
    await saveVersionSnapshot(design, userId, 'Released version');
  }
  design.status = 'RELEASED';
  design.releasedAt = new Date();
  design.releasedBy = userId;
  design.releasedVersion = design.currentVersion;
  design.updatedBy = userId;
  await design.save();
  if (design.createdBy) {
    await notify({
      organizationId: design.organizationId,
      factoryId: design.factoryId,
      userId: design.createdBy,
      eventType: 'design.released',
      title: 'Design version released',
      message: `${design.designCode} v${design.releasedVersion} is released for product development`,
      referenceType: 'DESIGN',
      referenceId: design._id,
    });
  }
  emitDesignUpdated(design, { actorId: userId });
  return getDesign(id);
}

export async function listDesignVersions(designId, { viewer, permissions } = {}) {
  await getDesign(designId, { viewer, permissions });
  return DesignVersion.find({ designId })
    .populate('createdBy', 'firstName lastName email')
    .sort({ version: -1 });
}

export async function getDesignVersion(designId, version, { viewer, permissions } = {}) {
  await getDesign(designId, { viewer, permissions });
  const record = await DesignVersion.findOne({ designId, version })
    .populate('createdBy', 'firstName lastName email');
  if (!record) throw new NotFoundError('Version not found');
  return record;
}

const TIMELINE_SUMMARIES = {
  CREATED: 'Design tech pack created',
  EDIT: 'Design updated',
  CLONED: 'Design cloned',
  SUBMITTED: 'Submitted for approval',
  APPROVED: 'Design approved',
  REJECTED: 'Design rejected',
  REVISION_REQUESTED: 'Revision requested',
  RELEASED: 'Design version released',
};

function pushTimelineEntry(entries, entry) {
  if (!entry.at) return;
  entries.push(entry);
}

export async function listDesignTimeline(designId, { factoryId, viewer, permissions } = {}) {
  const design = await getDesign(designId, { factoryId, viewer, permissions });
  const entries = [];

  pushTimelineEntry(entries, {
    id: `created-${design._id}`,
    kind: 'CREATED',
    at: design.createdAt,
    actor: design.createdBy,
    version: 1,
    summary: TIMELINE_SUMMARIES.CREATED,
  });

  const versions = await DesignVersion.find({ designId })
    .populate('createdBy', 'firstName lastName email')
    .sort({ version: 1 });

  for (const v of versions) {
    const at = v.releasedAt || v.createdAt;
    let kind = 'EDIT';
    let summary = v.changeSummary || TIMELINE_SUMMARIES.EDIT;

    if (v.released) {
      kind = 'RELEASED';
      summary = `Version ${v.version} released`;
    } else if (/^Cloned from /i.test(v.changeSummary || '')) {
      kind = 'CLONED';
      summary = v.changeSummary;
    } else if (v.version === 1 && v.changeSummary === 'Initial Design') {
      continue;
    }

    pushTimelineEntry(entries, {
      id: String(v._id),
      kind,
      at,
      actor: v.createdBy,
      version: v.version,
      summary,
      released: !!v.released,
    });
  }

  const instances = await ApprovalInstance.find({ documentType: 'DESIGN', documentId: designId })
    .populate('submittedBy', 'firstName lastName email')
    .populate('steps.approverId', 'firstName lastName email')
    .sort({ submittedAt: 1 });

  const stepActionToKind = {
    APPROVED: 'APPROVED',
    REJECTED: 'REJECTED',
    CHANGES_REQUESTED: 'REVISION_REQUESTED',
  };

  for (const inst of instances) {
    pushTimelineEntry(entries, {
      id: `submit-${inst._id}`,
      kind: 'SUBMITTED',
      at: inst.submittedAt,
      actor: inst.submittedBy,
      summary: TIMELINE_SUMMARIES.SUBMITTED,
      approvalInstanceId: inst._id,
    });

    for (const [i, step] of (inst.steps || []).entries()) {
      const kind = stepActionToKind[step.action] || step.action;
      pushTimelineEntry(entries, {
        id: `step-${inst._id}-${i}`,
        kind,
        at: step.actionAt,
        actor: step.approverId,
        comments: step.comments?.trim() || undefined,
        summary: TIMELINE_SUMMARIES[kind] || step.action?.replace(/_/g, ' '),
        level: step.level,
        approvalInstanceId: inst._id,
      });
    }
  }

  if (design.releasedAt && !entries.some((e) => e.kind === 'RELEASED' && e.version === design.releasedVersion)) {
    const releasedBy = design.releasedBy
      ? await User.findById(design.releasedBy).select('firstName lastName email')
      : null;
    pushTimelineEntry(entries, {
      id: `released-${design._id}`,
      kind: 'RELEASED',
      at: design.releasedAt,
      actor: releasedBy,
      version: design.releasedVersion,
      summary: `Version ${design.releasedVersion ?? design.currentVersion} released for product development`,
    });
  }

  entries.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  return entries;
}

export async function cloneDesign(id, userId, { viewer, permissions } = {}) {
  const source = await getDesignDoc(id);
  if (viewer && !canViewAllDesigns(permissions, viewer.isSuperAdmin)) {
    if (source.createdBy?.toString() !== viewer._id.toString()) {
      throw new ForbiddenError('You can only clone your own designs');
    }
  }
  const factory = await Factory.findById(source.factoryId);
  const prefix = `DSN-${factory.code}-`;
  const designCode = await nextDocumentNumber(source.factoryId, 'DESIGN', prefix);
  const snap = buildDesignSnapshot(source);
  const styleNumber = await nextCloneStyleNumber(source);
  const cloned = await Design.create({
    ...snap,
    designCode,
    title: `${source.title} (Copy)`,
    styleNumber,
    status: 'DRAFT',
    currentVersion: 1,
    submittedAt: undefined,
    approvedAt: undefined,
    approvedBy: undefined,
    rejectionComments: undefined,
    revisionComments: undefined,
    organizationId: source.organizationId,
    factoryId: source.factoryId,
    createdBy: userId,
    updatedBy: userId,
  });
  await cloneDesignAssets(source._id, cloned._id, userId, source.organizationId, source.factoryId);
  await saveVersionSnapshot(cloned, userId, 'Cloned from ' + source.designCode);
  return getDesign(cloned._id, { viewer, permissions });
}

export async function listDesignSamples(designId, { viewer, permissions } = {}) {
  await getDesign(designId, { viewer, permissions });
  const { Sample } = await import('../sampling/sample.model.js');
  return Sample.find(applySoftDeleteFilter({ designId }))
    .sort({ createdAt: -1 });
}

export async function uploadDesignAsset(designId, { fileName, mimeType, contentBase64, assetType }, userId, { viewer, permissions } = {}) {
  const design = await getDesignDoc(designId);
  assertCanEditDesign(design, viewer, permissions);
  if (!['DRAFT', 'REVISION_REQUESTED'].includes(design.status)) {
    throw new ConflictError('Assets can only be added to editable designs');
  }
  if (!contentBase64) throw new ValidationError('contentBase64 is required');
  const normalizedType = normalizeAssetType(assetType || 'FRONT_IMAGE');
  const buffer = Buffer.from(contentBase64, 'base64');
  if (buffer.length > MAX_ASSET_BYTES) {
    throw new ValidationError(`File exceeds ${MAX_ASSET_BYTES / 1024 / 1024}MB limit`);
  }

  if (SINGLE_SLOT_ASSET_TYPES.includes(normalizedType) || SINGLE_SLOT_ASSET_TYPES.includes(assetType)) {
    const slotTypes = normalizedType === 'FRONT_IMAGE'
      ? ['FRONT_IMAGE', 'IMAGE']
      : [normalizedType];
    await DesignAsset.updateMany(
      { designId: design._id, assetType: { $in: slotTypes }, isDeleted: false },
      { isDeleted: true, updatedBy: userId },
    );
  }

  const key = `designs/${design.factoryId}/${designId}/${Date.now()}-${fileName}`;
  const uploaded = await uploadFile({ key, body: buffer, contentType: mimeType });
  const url = uploaded.mode === 'stub' && mimeType?.startsWith('image/')
    ? `data:${mimeType};base64,${contentBase64}`
    : uploaded.url;

  return DesignAsset.create({
    organizationId: design.organizationId,
    factoryId: design.factoryId,
    designId: design._id,
    assetType: normalizedType,
    fileName,
    mimeType,
    sizeBytes: buffer.length,
    url,
    createdBy: userId,
    updatedBy: userId,
  });
}

export async function deleteDesignAsset(assetId, userId, { viewer, permissions } = {}) {
  const asset = await DesignAsset.findOne(applySoftDeleteFilter({ _id: assetId }));
  if (!asset) throw new NotFoundError('Asset not found');
  const design = await getDesignDoc(asset.designId);
  assertCanEditDesign(design, viewer, permissions);
  if (!['DRAFT', 'REVISION_REQUESTED'].includes(design.status)) {
    throw new ConflictError('Cannot delete assets from this design');
  }
  asset.isDeleted = true;
  asset.updatedBy = userId;
  await asset.save();
  return asset;
}

export async function listCollections(organizationId) {
  return DesignCollection.find(applySoftDeleteFilter({ organizationId, status: 'ACTIVE' })).sort({ name: 1 });
}

export async function createCollection(data, userId) {
  return DesignCollection.create({ ...data, createdBy: userId, updatedBy: userId });
}

export async function listSeasons(organizationId) {
  return Season.find(applySoftDeleteFilter({ organizationId, status: 'ACTIVE' })).sort({ year: -1, name: 1 });
}

export async function createSeason(data, userId) {
  return Season.create({ ...data, createdBy: userId, updatedBy: userId });
}

export async function listSizeCharts(factoryId) {
  const charts = await SizeChart.find(applySoftDeleteFilter({ factoryId, status: 'ACTIVE' })).sort({ name: 1 });
  return charts.map((c) => {
    const obj = c.toObject();
    if (obj.rows) {
      obj.rows = obj.rows.map((row) => ({
        measurementName: row.measurementName,
        values: row.values instanceof Map ? Object.fromEntries(row.values) : row.values,
      }));
    }
    return obj;
  });
}

export async function listMaterialOptions(factoryId) {
  const { listMaterials } = await import('../inventory/inventory.service.js');
  const { items } = await listMaterials(factoryId, { page: 1, limit: 500, skip: 0 });
  return items.map((m) => ({
    _id: m._id,
    materialCode: m.materialCode,
    name: m.name,
    unit: m.unit,
    category: m.category,
  }));
}

export async function createSizeChart(data, userId) {
  return SizeChart.create({ ...data, createdBy: userId, updatedBy: userId });
}


export async function regenerateDesignSkus(id, userId, { viewer, permissions } = {}) {
  const design = await getDesignDoc(id);
  assertCanEditDesign(design, viewer, permissions);
  if (!design.collectionId) throw new ValidationError('Collection is required');
  if (!design.styleNumber?.trim()) throw new ValidationError('Style number is required');
  await autoFillSkusForDesign(design, { overwriteExisting: true });
  await validateGeneratedSkus(design, { excludeDesignId: design._id });
  design.updatedBy = userId;
  design.updatedAt = new Date();
  await design.save();
  return getDesign(id, { viewer, permissions });
}

export function generateBomFromDesign(design) {
  const lines = [];
  for (const f of design.fabricConsumption || []) {
    if (!f.materialId) continue;
    const qty = (f.consumption || 0) * (1 + (f.wastagePercent || 0) / 100);
    lines.push({
      materialId: f.materialId,
      quantity: Math.round(qty * 1000) / 1000,
      unit: f.unit || 'METERS',
      category: 'FABRIC',
    });
  }
  for (const a of design.accessories || []) {
    if (!a.materialId) continue;
    lines.push({
      materialId: a.materialId,
      quantity: a.consumption || a.quantity || 1,
      unit: a.unit || 'PIECES',
      category: a.accessoryType || 'ACCESSORY',
    });
  }
  return lines;
}
