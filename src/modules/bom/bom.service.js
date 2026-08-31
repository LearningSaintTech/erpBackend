import { Bom } from './bom.model.js';
import { Sku } from '../sku/sku.model.js';
import { Design } from '../design/design.model.js';
import { Sample } from '../sampling/sample.model.js';
import { Material } from '../inventory/material.model.js';
import * as mrpService from '../mrp/mrp.service.js';
import { getPatternTechPack } from '../pattern/pattern.service.js';
import { NotFoundError, ConflictError, ValidationError } from '../../shared/errors/AppError.js';
import { applySoftDeleteFilter } from '../../shared/utils/schema.js';
import { BOM_EDITABLE_STATUSES, BOM_APPROVABLE_STATUSES } from './bom.defaults.js';

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const BOM_POPULATE = [
  { path: 'skuId', select: 'skuCode name size status designId sampleId basePrice' },
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
  const techPack = design
    ? await getPatternTechPack(design._id, factoryId)
    : null;

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
      unit: unit || mat?.unit || 'PIECES',
      wastagePercent: wastagePercent ?? 0,
      unitCost: mat?.unitCost ?? fallbackCost ?? 0,
      materialCode: mat?.materialCode,
      materialName: mat?.name || fallbackName,
    });
  }

  if (techPack?.fabricConsumption?.length) {
    for (const line of techPack.fabricConsumption) {
      await pushLine(line.materialId, line.consumption, line.unit, line.wastagePercent, undefined, line.fabricCost);
    }
  }

  if (techPack?.bomLines?.length) {
    for (const line of techPack.bomLines) {
      await pushLine(line.materialId, line.quantity, line.unit, 0, line.materialName);
    }
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
        unit: req.unit || mat?.unit || 'PIECES',
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
    designId: design?._id,
    designCode: design?.designCode,
    source,
    lines,
  };
}

export async function getBomStats(factoryId) {
  const base = applySoftDeleteFilter({ factoryId });
  const [total, draft, approved, active, obsolete] = await Promise.all([
    Bom.countDocuments(base),
    Bom.countDocuments({ ...base, status: 'DRAFT' }),
    Bom.countDocuments({ ...base, status: 'APPROVED' }),
    Bom.countDocuments({ ...base, status: 'ACTIVE' }),
    Bom.countDocuments({ ...base, status: 'OBSOLETE' }),
  ]);
  return { total, draft, approved, active, obsolete };
}

export async function createBom({ skuId, factoryId, organizationId, lines, fromDesign }, userId) {
  const sku = await loadSku(skuId, factoryId);

  const draftExists = await Bom.findOne({
    skuId,
    factoryId,
    status: 'DRAFT',
    isDeleted: false,
  });
  if (draftExists) {
    throw new ConflictError(`Draft BOM ${draftExists.bomCode} already exists for this SKU — edit or approve it first`);
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

export async function approveBom(id, factoryId, userId) {
  const bom = await loadBom(id, factoryId);
  if (!BOM_APPROVABLE_STATUSES.includes(bom.status)) {
    throw new ConflictError('BOM cannot be approved in current status');
  }
  if (!bom.lines?.length) throw new ValidationError('BOM has no lines');
  bom.status = 'APPROVED';
  bom.approvedBy = userId;
  bom.approvedAt = new Date();
  bom.updatedBy = userId;
  await bom.save();
  return populateBom(bom);
}

export async function finalizeBom(id, factoryId, userId) {
  const bom = await loadBom(id, factoryId);
  if (bom.status !== 'APPROVED') throw new ConflictError('BOM must be APPROVED to finalize');

  await Bom.updateMany(
    { skuId: bom.skuId, factoryId, status: 'ACTIVE', isDeleted: false },
    { status: 'OBSOLETE', updatedBy: userId },
  );

  bom.status = 'ACTIVE';
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

export async function listBoms(factoryId, { page, limit, skip, status, skuId, search }) {
  const filter = applySoftDeleteFilter({ factoryId });
  if (status) filter.status = status;
  if (skuId) filter.skuId = skuId;

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
  return { items, total };
}
