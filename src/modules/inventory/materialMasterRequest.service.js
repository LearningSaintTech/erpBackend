import { MaterialMasterRequest } from './materialMasterRequest.model.js';
import { Material } from './material.model.js';
import { PatternDevelopment } from '../pattern/pattern.model.js';
import { Design } from '../design/design.model.js';
import { Factory } from '../organization/factory.model.js';
import { UserRoleAssignment } from '../user/userRoleAssignment.model.js';
import { NotFoundError, ConflictError, ValidationError } from '../../shared/errors/AppError.js';
import { applySoftDeleteFilter } from '../../shared/utils/schema.js';
import { nextDocumentNumber } from '../../shared/utils/numbering.js';
import { notify } from '../notification/notification.service.js';
import { createMaterial } from './inventory.service.js';
import { MATERIAL_CATEGORIES, MATERIAL_UNITS } from './inventory.defaults.js';

const PATTERN_UNIT = {
  METERS: 'M',
  YARDS: 'YD',
  PIECES: 'PC',
  CONES: 'CONE',
  KG: 'KG',
};

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function slugCodePart(value, max = 18) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toUpperCase()
    .slice(0, max) || 'FAB';
}

function toPatternUnit(unit) {
  return PATTERN_UNIT[unit] || unit || 'M';
}

async function populateRequest(doc) {
  return MaterialMasterRequest.findById(doc._id)
    .populate('requestedBy', 'firstName lastName email')
    .populate('reviewedBy', 'firstName lastName email')
    .populate('designId', 'designCode title')
    .populate('materialId', 'materialCode name unit category unitCost');
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

async function uniqueMaterialCode(factoryId, proposed, name, category) {
  const trimmed = String(proposed || '').trim().toUpperCase();
  if (trimmed) {
    const existing = await Material.findOne(applySoftDeleteFilter({ factoryId, materialCode: trimmed }));
    if (existing) throw new ConflictError(`Material code already exists: ${trimmed}`);
    return trimmed;
  }
  const prefix = category === 'FABRIC' ? 'FAB' : category === 'THREAD' ? 'THR' : 'RM';
  const base = `${prefix}-${slugCodePart(name)}`.slice(0, 36);
  const clash = await Material.findOne(applySoftDeleteFilter({ factoryId, materialCode: base }));
  if (!clash) return base;
  return nextDocumentNumber(factoryId, `MATCODE-${prefix}`, `${prefix}-`);
}

async function attachToPattern(request, material, userId) {
  if (!request.designId) return;
  const pd = await PatternDevelopment.findOne(applySoftDeleteFilter({
    designId: request.designId,
    factoryId: request.factoryId,
  }));
  if (!pd) return;

  const materialId = material._id;
  const alreadyOnFabric = (pd.fabricConsumption || []).some((l) => String(l.materialId || '') === String(materialId));
  const alreadyOnTrim = (pd.accessories || []).some((l) => String(l.materialId || '') === String(materialId));
  if (alreadyOnFabric || alreadyOnTrim) return;

  const isFabric = (request.category || material.category) === 'FABRIC';
  if (isFabric) {
    const lines = (pd.fabricConsumption || []).map((l) => l.toObject?.() ?? l);
    const emptyIdx = lines.findIndex((l) => !l.materialId);
    const next = {
      materialId,
      consumption: 0,
      unit: toPatternUnit(material.unit),
      fabricCost: material.unitCost || 0,
      wastagePercent: 0,
    };
    if (emptyIdx >= 0) lines[emptyIdx] = { ...lines[emptyIdx], ...next };
    else lines.push(next);
    pd.fabricConsumption = lines;
  } else {
    const lines = (pd.accessories || []).map((l) => l.toObject?.() ?? l);
    lines.push({
      accessoryType: request.category || material.category || 'ACCESSORY',
      materialId,
      consumption: 0,
      unit: toPatternUnit(material.unit),
      unitCost: material.unitCost || 0,
    });
    pd.accessories = lines;
  }

  if (pd.status === 'ASSIGNED') pd.status = 'IN_PROGRESS';
  pd.updatedBy = userId;
  await pd.save();
}

export async function createMaterialMasterRequest(data, userId) {
  const name = String(data.name || '').trim();
  if (name.length < 2) throw new ValidationError('Fabric name is required');

  const category = MATERIAL_CATEGORIES.includes(data.category) ? data.category : 'FABRIC';
  const unit = MATERIAL_UNITS.includes(data.unit) ? data.unit : 'METERS';
  if (!data.designId) throw new ValidationError('designId is required');

  const design = await Design.findOne(applySoftDeleteFilter({
    _id: data.designId,
    factoryId: data.factoryId,
  })).select('_id designCode title');
  if (!design) throw new NotFoundError('Design not found');

  const duplicate = await MaterialMasterRequest.findOne(applySoftDeleteFilter({
    factoryId: data.factoryId,
    designId: data.designId,
    status: 'PENDING',
    name: new RegExp(`^${escapeRegex(name)}$`, 'i'),
  }));
  if (duplicate) throw new ConflictError('A pending store request for this fabric already exists');

  const factory = await Factory.findById(data.factoryId).select('code');
  const requestNumber = await nextDocumentNumber(
    data.factoryId,
    'MATERIAL_MASTER_REQUEST',
    `MMR-${factory?.code || 'F'}-`,
  );

  const request = await MaterialMasterRequest.create({
    organizationId: data.organizationId,
    factoryId: data.factoryId,
    requestNumber,
    name,
    proposedCode: String(data.proposedCode || '').trim().toUpperCase(),
    category,
    unit,
    unitCost: Number(data.unitCost) || 0,
    notes: String(data.notes || '').trim(),
    designId: data.designId,
    requestedBy: userId,
    status: 'PENDING',
    createdBy: userId,
    updatedBy: userId,
  });

  await notifyUsersWithPermission({
    organizationId: data.organizationId,
    factoryId: data.factoryId,
    permission: 'inventory.create',
    excludeUserId: userId,
    eventType: 'material_master.requested',
    title: 'Fabric master request',
    message: `${requestNumber}: ${name} for ${design.designCode || 'design'} — approve to add it to the store`,
    referenceType: 'MATERIAL_MASTER_REQUEST',
    referenceId: request._id,
  });

  return populateRequest(request);
}

export async function listMaterialMasterRequests(factoryId, {
  page = 1, limit = 20, skip = 0, status, designId, canSeeAll, userId,
} = {}) {
  const filter = applySoftDeleteFilter({ factoryId });
  if (status) filter.status = status;
  if (designId) filter.designId = designId;
  if (!canSeeAll) {
    filter.$or = [{ requestedBy: userId }];
    if (designId) filter.$or.push({ designId });
  }

  const [items, total] = await Promise.all([
    MaterialMasterRequest.find(filter)
      .skip(skip)
      .limit(limit)
      .sort({ createdAt: -1 })
      .populate('requestedBy', 'firstName lastName email')
      .populate('reviewedBy', 'firstName lastName email')
      .populate('designId', 'designCode title')
      .populate('materialId', 'materialCode name unit category unitCost'),
    MaterialMasterRequest.countDocuments(filter),
  ]);
  return { items, total };
}

export async function approveMaterialMasterRequest(id, factoryId, body, userId) {
  const request = await MaterialMasterRequest.findOne(applySoftDeleteFilter({ _id: id, factoryId }));
  if (!request) throw new NotFoundError('Material master request not found');
  if (request.status !== 'PENDING') throw new ConflictError('Request is no longer pending');

  const name = String(body.name || request.name).trim();
  const category = MATERIAL_CATEGORIES.includes(body.category) ? body.category : request.category;
  const unit = MATERIAL_UNITS.includes(body.unit) ? body.unit : request.unit;
  const unitCost = body.unitCost !== undefined ? Number(body.unitCost) || 0 : (request.unitCost || 0);
  const materialCode = await uniqueMaterialCode(
    factoryId,
    body.materialCode || request.proposedCode,
    name,
    category,
  );

  const material = await createMaterial({
    factoryId,
    organizationId: request.organizationId,
    materialCode,
    name,
    category,
    unit,
    unitCost,
  }, userId);

  request.status = 'APPROVED';
  request.reviewedBy = userId;
  request.reviewedAt = new Date();
  request.reviewNotes = String(body.reviewNotes || '').trim();
  request.materialId = material._id;
  request.name = name;
  request.category = category;
  request.unit = unit;
  request.unitCost = unitCost;
  request.updatedBy = userId;
  await request.save();

  await attachToPattern(request, material, userId);

  const designLabel = request.designId
    ? (await Design.findById(request.designId).select('designCode title'))?.designCode
    : '';
  await notify({
    organizationId: request.organizationId,
    factoryId,
    userId: request.requestedBy,
    eventType: 'material_master.approved',
    title: 'Fabric added to store',
    message: `${request.requestNumber}: ${material.materialCode} — ${material.name} is on the material master${designLabel ? ` and attached to ${designLabel}` : ''}`,
    referenceType: request.designId ? 'PATTERN' : 'MATERIAL_MASTER_REQUEST',
    referenceId: request.designId || request._id,
  });

  return populateRequest(request);
}

export async function rejectMaterialMasterRequest(id, factoryId, body, userId) {
  const request = await MaterialMasterRequest.findOne(applySoftDeleteFilter({ _id: id, factoryId }));
  if (!request) throw new NotFoundError('Material master request not found');
  if (request.status !== 'PENDING') throw new ConflictError('Request is no longer pending');

  request.status = 'REJECTED';
  request.reviewedBy = userId;
  request.reviewedAt = new Date();
  request.reviewNotes = String(body.reviewNotes || '').trim();
  request.updatedBy = userId;
  await request.save();

  await notify({
    organizationId: request.organizationId,
    factoryId,
    userId: request.requestedBy,
    eventType: 'material_master.rejected',
    title: 'Fabric request declined',
    message: `${request.requestNumber}: ${request.name}${request.reviewNotes ? ` — ${request.reviewNotes}` : ''}`,
    referenceType: request.designId ? 'PATTERN' : 'MATERIAL_MASTER_REQUEST',
    referenceId: request.designId || request._id,
  });

  return populateRequest(request);
}

export async function countPendingMaterialMasterRequests(factoryId) {
  return MaterialMasterRequest.countDocuments(applySoftDeleteFilter({ factoryId, status: 'PENDING' }));
}
