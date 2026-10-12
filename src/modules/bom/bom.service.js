import { Bom } from './bom.model.js';
import { Sku } from '../sku/sku.model.js';
import { Design } from '../design/design.model.js';
import { Sample } from '../sampling/sample.model.js';
import { Material } from '../inventory/material.model.js';
import { PatternDevelopment } from '../pattern/pattern.model.js';
import { ApprovalWorkflow } from '../approval/approvalWorkflow.model.js';
import * as mrpService from '../mrp/mrp.service.js';
import { getPatternTechPack } from '../pattern/pattern.service.js';
import { submitForApproval } from '../approval/approval.service.js';
import {
  syncApprovalApproved,
  syncApprovalRejected,
  syncApprovalRevisionRequested,
} from '../../shared/services/approvalSync.js';
import { notify } from '../notification/notification.service.js';
import { findUserIdsWithFactoryPermission } from '../user/user.service.js';
import { NotFoundError, ConflictError, ValidationError } from '../../shared/errors/AppError.js';
import { applySoftDeleteFilter, escapeRegex, queryString } from '../../shared/utils/schema.js';
import { BOM_EDITABLE_STATUSES, BOM_APPROVABLE_STATUSES, BOM_OPEN_STATUSES } from './bom.defaults.js';

const BOM_POPULATE = [
  { path: 'skuId', select: 'skuCode name size color status designId sampleId basePrice' },
  { path: 'lines.materialId', select: 'materialCode name unit unitCost category' },
  { path: 'approvedBy', select: 'firstName lastName email' },
];

async function populateBom(doc) {
  if (!doc) return doc;
  return Bom.findById(doc._id).populate(BOM_POPULATE);
}

async function loadSku(skuId, factoryId) {
  const sku = await Sku.findOne(applySoftDeleteFilter({ _id: skuId, factoryId }));
  if (!sku) throw new NotFoundError('SKU not found');
  return sku;
}

async function loadBom(id, factoryId) {
  const bom = await Bom.findOne(applySoftDeleteFilter({ _id: id, factoryId }));
  if (!bom) throw new NotFoundError('BOM not found');
  return bom;
}

/**
 * BOM quantities come from the pattern master's signed-off tech pack — a reopened (in-progress)
 * pattern may still change consumption or trims.
 */
async function loadCompletedPattern(designId, factoryId, action) {
  if (!designId) return null;
  const pd = await PatternDevelopment.findOne(applySoftDeleteFilter({ designId, factoryId }))
    .select('status updatedAt');
  if (pd && pd.status !== 'COMPLETED') {
    throw new ConflictError(
      `Pattern development is ${pd.status.replace(/_/g, ' ').toLowerCase()} — `
      + `the pattern master must complete (re-sign) the pattern before ${action}`,
    );
  }
  return pd;
}

/** Lines without a colour are shared by every variant. */
function lineAppliesToColor(lineColor, skuColor) {
  if (!skuColor || !lineColor?.trim()) return true;
  return lineColor.trim().toLowerCase() === String(skuColor).trim().toLowerCase();
}

async function assertMaterials(lines, factoryId) {
  if (!lines?.length) return;
  const ids = [...new Set(lines.map((l) => l.materialId?.toString()))];
  const materials = await Material.find({ _id: { $in: ids }, factoryId, isDeleted: false });
  if (materials.length !== ids.length) {
    throw new ValidationError('One or more materials are invalid for this factory');
  }
  const matMap = new Map(materials.map((m) => [m._id.toString(), m]));
  return lines.map((line) => {
    const mat = matMap.get(line.materialId.toString());
    return {
      materialId: line.materialId,
      materialCategory: line.materialCategory || mat?.category,
      quantityPerPiece: line.quantityPerPiece,
      unit: line.unit || mat?.unit || 'PIECES',
      wastagePercent: line.wastagePercent ?? 0,
      unitCost: line.unitCost ?? mat?.unitCost ?? 0,
      isOptional: !!line.isOptional,
    };
  });
}

export async function suggestBomLines(skuId, factoryId) {
  const sku = await loadSku(skuId, factoryId);
  const design = sku.designId
    ? await Design.findOne(applySoftDeleteFilter({ _id: sku.designId, factoryId }))
    : null;
  if (design) await loadCompletedPattern(design._id, factoryId, 'building a BOM');
  const techPack = design
    ? await getPatternTechPack(design._id, factoryId)
    : null;
  const skuColor = sku.color?.name;

  const lines = [];
  const source = techPack?.bomLines?.length || techPack?.fabricConsumption?.length
    ? 'pattern_bom'
    : 'sample_materials';
  const seen = new Set();

  async function pushLine(materialId, quantityPerPiece, unit, wastagePercent, fallbackName, fallbackCost) {
    if (!materialId || seen.has(String(materialId))) return;
    if (!(Number(quantityPerPiece) > 0)) return;
    seen.add(String(materialId));
    const mat = await Material.findById(materialId);
    lines.push({
      materialId,
      materialCategory: mat?.category,
      quantityPerPiece: quantityPerPiece || 0,
      // Inventory issues and MRP work in the material's stock unit.
      unit: mat?.unit || unit || 'PIECES',
      wastagePercent: wastagePercent ?? 0,
      unitCost: mat?.unitCost ?? fallbackCost ?? 0,
      materialCode: mat?.materialCode,
      materialName: mat?.name || fallbackName,
    });
  }

  // Fabric first (consumption + wastage); a bomLines entry for the same material is a legacy mirror.
  for (const line of techPack?.fabricConsumption || []) {
    if (!lineAppliesToColor(line.color, skuColor)) continue;
    await pushLine(line.materialId, line.consumption, line.unit, line.wastagePercent, undefined, line.fabricCost);
  }
  for (const line of techPack?.bomLines || []) {
    if (!lineAppliesToColor(line.color, skuColor)) continue;
    await pushLine(line.materialId, line.quantity, line.unit, 0, line.materialName);
  }

  if (!lines.length && sku.sampleId) {
    const sample = await Sample.findOne(applySoftDeleteFilter({ _id: sku.sampleId, factoryId }));
    for (const req of sample?.materialRequirements || []) {
      if (!req.materialId) continue;
      const mat = await Material.findById(req.materialId);
      lines.push({
        materialId: req.materialId,
        materialCategory: mat?.category,
        quantityPerPiece: req.requiredQty || 1,
        unit: mat?.unit || req.unit || 'PIECES',
        wastagePercent: 0,
        unitCost: req.unitCost ?? mat?.unitCost ?? 0,
        materialCode: mat?.materialCode,
        materialName: mat?.name,
      });
    }
  }

  return {
    skuId: sku._id,
    skuCode: sku.skuCode,
    skuColor: skuColor || undefined,
    designId: design?._id,
    designCode: design?.designCode,
    source,
    lines,
  };
}

export async function getBomStats(factoryId) {
  const base = applySoftDeleteFilter({ factoryId });
  const [total, draft, pendingApproval, approved, active, obsolete, needsReview] = await Promise.all([
    Bom.countDocuments(base),
    Bom.countDocuments({ ...base, status: 'DRAFT' }),
    Bom.countDocuments({ ...base, status: 'PENDING_APPROVAL' }),
    Bom.countDocuments({ ...base, status: 'APPROVED' }),
    Bom.countDocuments({ ...base, status: 'ACTIVE' }),
    Bom.countDocuments({ ...base, status: 'OBSOLETE' }),
    Bom.countDocuments({ ...base, status: 'ACTIVE', needsReview: true }),
  ]);
  return {
    total, draft, pendingApproval, approved, active, obsolete, needsReview,
  };
}

export async function createBom({ skuId, factoryId, organizationId, lines, fromDesign }, userId) {
  const sku = await loadSku(skuId, factoryId);
  const pd = await loadCompletedPattern(sku.designId, factoryId, 'creating a BOM');

  const openVersion = await Bom.findOne({
    skuId,
    factoryId,
    status: { $in: BOM_OPEN_STATUSES },
    isDeleted: false,
  }).sort({ version: -1 });
  if (openVersion) {
    const next = {
      DRAFT: 'edit and approve it',
      PENDING_APPROVAL: 'finish its approval',
      APPROVED: 'freeze it (Freeze & MRP)',
    }[openVersion.status];
    throw new ConflictError(
      `${openVersion.bomCode} (v${openVersion.version}) is ${openVersion.status.replace(/_/g, ' ')} for this SKU — ${next} first`,
    );
  }

  let bomLines = lines;
  if ((!bomLines || !bomLines.length) && fromDesign !== false) {
    const suggestion = await suggestBomLines(skuId, factoryId);
    bomLines = suggestion.lines;
  }
  if (!bomLines?.length) {
    throw new ValidationError('BOM lines are required — add materials or fill the BOM on the pattern');
  }

  const normalizedLines = await assertMaterials(bomLines, factoryId);

  const latest = await Bom.findOne({ skuId, factoryId, isDeleted: false }).sort({ version: -1 });
  const version = (latest?.version || 0) + 1;
  const bomCode = `BOM-${sku.skuCode}-v${version}`;

  const bom = new Bom({
    organizationId,
    factoryId,
    bomCode,
    skuId,
    version,
    status: 'DRAFT',
    lines: normalizedLines,
    patternDevelopmentId: pd?._id,
    patternUpdatedAt: pd?.updatedAt,
    createdBy: userId,
    updatedBy: userId,
  });
  await bom.save();
  return populateBom(bom);
}

export async function getBom(id, factoryId) {
  const bom = await Bom.findOne(applySoftDeleteFilter({ _id: id, factoryId })).populate(BOM_POPULATE);
  if (!bom) throw new NotFoundError('BOM not found');
  return bom;
}

export async function getActiveBomForSku(skuId, factoryId) {
  const bom = await Bom.findOne({
    skuId,
    factoryId,
    status: 'ACTIVE',
    isDeleted: false,
  }).populate(BOM_POPULATE);
  return bom;
}

export async function updateBom(id, factoryId, { lines }, userId) {
  const bom = await loadBom(id, factoryId);
  if (!BOM_EDITABLE_STATUSES.includes(bom.status)) {
    throw new ConflictError('Only DRAFT BOM can be edited');
  }
  if (!lines?.length) throw new ValidationError('BOM must have at least one line');
  bom.lines = await assertMaterials(lines, factoryId);
  bom.updatedBy = userId;
  await bom.save();
  return populateBom(bom);
}

async function hasActiveBomWorkflow(bom) {
  return !!(await ApprovalWorkflow.exists({
    organizationId: bom.organizationId,
    factoryId: bom.factoryId,
    documentType: 'BOM',
    isActive: true,
  }));
}

export async function submitBomForApproval(id, factoryId, userId) {
  const bom = await loadBom(id, factoryId);
  if (bom.status !== 'DRAFT') {
    throw new ConflictError('Only a DRAFT BOM can be submitted for approval');
  }
  if (!bom.lines?.length) throw new ValidationError('BOM has no lines');

  bom.status = 'PENDING_APPROVAL';
  bom.submittedBy = userId;
  bom.submittedAt = new Date();
  bom.updatedBy = userId;
  await bom.save();

  let instance;
  try {
    instance = await submitForApproval({
      organizationId: bom.organizationId,
      factoryId: bom.factoryId,
      documentType: 'BOM',
      documentId: bom._id,
      submittedBy: userId,
    });
  } catch (err) {
    bom.status = 'DRAFT';
    await bom.save();
    throw err;
  }

  const approverIds = await findUserIdsWithFactoryPermission(
    bom.factoryId,
    ['bom.approve', 'approval.approve'],
    { excludeUserId: userId },
  );
  await Promise.all(approverIds.map((approverId) => notify({
    organizationId: bom.organizationId,
    factoryId: bom.factoryId,
    userId: approverId,
    eventType: 'approval.pending',
    title: 'BOM awaiting approval',
    message: `${bom.bomCode} (v${bom.version}) is awaiting your approval`,
    referenceType: 'APPROVAL',
    referenceId: instance?._id || bom._id,
  })));
  return populateBom(bom);
}

export async function approveBom(id, factoryId, userId, { syncApproval = true } = {}) {
  const bom = await loadBom(id, factoryId);
  if (!BOM_APPROVABLE_STATUSES.includes(bom.status)) {
    throw new ConflictError('BOM cannot be approved in current status');
  }
  if (!bom.lines?.length) throw new ValidationError('BOM has no lines');
  // With a configured workflow the approval must go through it; without one, direct approve stays.
  if (bom.status === 'DRAFT' && await hasActiveBomWorkflow(bom)) {
    throw new ConflictError('Submit the BOM for approval first');
  }
  if (syncApproval) {
    await syncApprovalApproved('BOM', bom._id, userId);
  }
  bom.status = 'APPROVED';
  bom.approvedBy = userId;
  bom.approvedAt = new Date();
  bom.updatedBy = userId;
  await bom.save();
  return populateBom(bom);
}

async function returnBomToDraft(id, factoryId, userId, comments, { syncApproval, kind }) {
  const bom = await loadBom(id, factoryId);
  if (bom.status !== 'PENDING_APPROVAL') {
    throw new ConflictError('BOM is not pending approval');
  }
  if (syncApproval) {
    if (kind === 'reject') await syncApprovalRejected('BOM', bom._id, userId, comments);
    else await syncApprovalRevisionRequested('BOM', bom._id, userId, comments);
  }
  bom.status = 'DRAFT';
  if (kind === 'reject') bom.rejectionComments = comments;
  else bom.revisionComments = comments;
  bom.updatedBy = userId;
  await bom.save();

  const notifyId = bom.submittedBy || bom.createdBy;
  if (notifyId && String(notifyId) !== String(userId)) {
    await notify({
      organizationId: bom.organizationId,
      factoryId: bom.factoryId,
      userId: notifyId,
      eventType: 'approval.rejected',
      title: kind === 'reject' ? 'BOM rejected' : 'BOM changes requested',
      message: comments?.trim()
        ? `${bom.bomCode}: ${comments.trim()}`
        : `${bom.bomCode} was returned to draft`,
      referenceType: 'APPROVAL',
      referenceId: bom._id,
    });
  }
  return populateBom(bom);
}

export async function rejectBom(id, factoryId, userId, comments, { syncApproval = true } = {}) {
  return returnBomToDraft(id, factoryId, userId, comments, { syncApproval, kind: 'reject' });
}

export async function requestBomChanges(id, factoryId, userId, comments, { syncApproval = true } = {}) {
  return returnBomToDraft(id, factoryId, userId, comments, { syncApproval, kind: 'changes' });
}

export async function finalizeBom(id, factoryId, userId) {
  const bom = await loadBom(id, factoryId);
  if (bom.status !== 'APPROVED') throw new ConflictError('BOM must be APPROVED to finalize');

  // Freezing an older version would obsolete a newer standard that production may already use.
  const newer = await Bom.findOne({
    skuId: bom.skuId,
    factoryId,
    isDeleted: false,
    version: { $gt: bom.version },
    status: { $in: ['ACTIVE', 'APPROVED'] },
  }).sort({ version: -1 });
  if (newer) {
    throw new ConflictError(
      `${newer.bomCode} (v${newer.version}) is already ${newer.status} — only the latest version can be frozen`,
    );
  }

  await Bom.updateMany(
    { skuId: bom.skuId, factoryId, status: 'ACTIVE', isDeleted: false },
    { status: 'OBSOLETE', updatedBy: userId },
  );

  bom.status = 'ACTIVE';
  bom.needsReview = false;
  bom.reviewReason = undefined;
  bom.updatedBy = userId;
  await bom.save();

  const mrp = await mrpService.calculateMrpPreview({
    bomId: bom._id,
    skuId: bom.skuId,
    factoryId: bom.factoryId,
    organizationId: bom.organizationId,
    orderQuantity: 1,
    userId,
  });

  return { bom: await populateBom(bom), mrp };
}

export async function listBoms(factoryId, {
  page, limit, skip, status, skuId, search, needsReview,
}) {
  const filter = applySoftDeleteFilter({ factoryId });
  status = queryString(status);
  skuId = queryString(skuId);
  search = queryString(search);
  needsReview = queryString(needsReview);
  if (status) filter.status = status;
  if (skuId) filter.skuId = skuId;
  if (needsReview === 'true') filter.needsReview = true;

  if (search?.trim()) {
    const regex = new RegExp(escapeRegex(search.trim()), 'i');
    const matchingSkus = await Sku.find(applySoftDeleteFilter({
      factoryId,
      $or: [{ skuCode: regex }, { name: regex }],
    })).select('_id');
    filter.$or = [
      { bomCode: regex },
      ...(matchingSkus.length ? [{ skuId: { $in: matchingSkus.map((s) => s._id) } }] : []),
    ];
  }

  const [items, total] = await Promise.all([
    Bom.find(filter).populate(BOM_POPULATE).skip(skip).limit(limit).sort({ updatedAt: -1 }),
    Bom.countDocuments(filter),
  ]);

  // Lets the UI offer "Freeze & MRP" only on the newest version of each SKU.
  const skuIds = items.map((b) => b.skuId?._id || b.skuId).filter(Boolean);
  const latestRows = skuIds.length
    ? await Bom.aggregate([
      { $match: { factoryId: items[0].factoryId, isDeleted: false, skuId: { $in: skuIds } } },
      { $group: { _id: '$skuId', latestVersion: { $max: '$version' } } },
    ])
    : [];
  const latestBySku = new Map(latestRows.map((r) => [String(r._id), r.latestVersion]));
  const enriched = items.map((b) => {
    const obj = b.toObject();
    const latest = latestBySku.get(String(b.skuId?._id || b.skuId));
    obj.isLatestVersion = latest == null || b.version >= latest;
    return obj;
  });
  return { items: enriched, total };
}
