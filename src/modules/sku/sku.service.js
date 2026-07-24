import { Sku } from './sku.model.js';
import { Sample } from '../sampling/sample.model.js';
import { Design } from '../design/design.model.js';
import { Material } from '../inventory/material.model.js';
import { NotFoundError, ConflictError, ValidationError } from '../../shared/errors/AppError.js';
import { applySoftDeleteFilter } from '../../shared/utils/schema.js';
import { autoFillSkusForDesign, generateSkuForSize } from './skuGeneration.service.js';
import { SKU_STATUS_LIST } from './sku.defaults.js';

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SKU_POPULATE = [
  { path: 'designId', select: 'designCode title styleNumber status targetPrice' },
  { path: 'sampleId', select: 'sampleCode sampleType status' },
];

async function populateSku(doc) {
  if (!doc) return doc;
  return Sku.findById(doc._id).populate(SKU_POPULATE);
}

async function loadSample(sampleId, factoryId) {
  const sample = await Sample.findOne(applySoftDeleteFilter({ _id: sampleId, factoryId }))
    .populate('designId', 'designCode title styleNumber colorVariants targetPrice skuPrefix category fit gender collectionId sizeChartData');
  if (!sample) throw new NotFoundError('Sample not found');
  if (sample.status !== 'APPROVED') throw new ConflictError('Sample must be APPROVED to create SKU');
  return sample;
}

async function loadDesignForSample(sample) {
  const design = sample.designId?._id
    ? sample.designId
    : await Design.findOne(applySoftDeleteFilter({ _id: sample.designId, factoryId: sample.factoryId }));
  if (!design) throw new NotFoundError('Design not found');
  return design;
}

function normalizeColor(color, design) {
  if (color?.name) return color;
  const first = design.colorVariants?.[0];
  return first ? { name: first.name, hexCode: first.hexCode } : { name: 'Default' };
}

async function resolveSkuCode(design, sizeCode, colorName, colorFilter) {
  await autoFillSkusForDesign(design, { overwriteExisting: false });

  for (let vi = 0; vi < (design.colorVariants || []).length; vi += 1) {
    const variant = design.colorVariants[vi];
    const variantColor = variant.name || '';
    if (colorFilter?.name && variantColor && variantColor !== colorFilter.name) continue;
    for (let si = 0; si < (variant.sizes || []).length; si += 1) {
      const row = variant.sizes[si];
      if (sizeCode && row.size && row.size !== sizeCode) continue;
      if (row.sku) return row.sku;
      try {
        return await generateSkuForSize(design, vi, si);
      } catch {
        // fall through to fallback code
      }
    }
  }

  return `${design.designCode || 'SKU'}-${sizeCode}-${String(colorName).substring(0, 3).toUpperCase()}`;
}

export async function getSkuStats(factoryId) {
  const base = applySoftDeleteFilter({ factoryId });
  const [total, active, draft, discontinued] = await Promise.all([
    Sku.countDocuments(base),
    Sku.countDocuments({ ...base, status: 'ACTIVE' }),
    Sku.countDocuments({ ...base, status: 'DRAFT' }),
    Sku.countDocuments({ ...base, status: 'DISCONTINUED' }),
  ]);
  return { total, active, draft, discontinued };
}

export async function listEligibleSamples(factoryId) {
  const samples = await Sample.find(applySoftDeleteFilter({ factoryId, status: 'APPROVED' }))
    .populate('designId', 'designCode title styleNumber colorVariants')
    .sort({ updatedAt: -1 });

  const existingCounts = await Sku.aggregate([
    { $match: { factoryId, isDeleted: false } },
    { $group: { _id: '$sampleId', count: { $sum: 1 } } },
  ]);
  const countBySample = new Map(existingCounts.map((r) => [r._id?.toString(), r.count]));

  return samples.map((s) => {
    const design = s.designId;
    const matrixRows = (design?.colorVariants || []).reduce(
      (sum, v) => sum + (v.sizes?.length || 0),
      0,
    );
    const existing = countBySample.get(s._id.toString()) || 0;
    return {
      _id: s._id,
      sampleCode: s.sampleCode,
      sampleType: s.sampleType,
      designId: design?._id || s.designId,
      designCode: design?.designCode,
      designTitle: design?.title,
      matrixRows,
      existingSkus: existing,
      canBulk: matrixRows > 0,
    };
  });
}

export async function previewSkusFromSample(sampleId, factoryId) {
  const sample = await loadSample(sampleId, factoryId);
  const design = await loadDesignForSample(sample);
  await autoFillSkusForDesign(design, { overwriteExisting: false });

  const previews = [];
  for (const variant of design.colorVariants || []) {
    for (const row of variant.sizes || []) {
      if (!row.size) continue;
      const skuCode = row.sku || await resolveSkuCode(design, row.size, variant.name, { name: variant.name });
      const existing = await Sku.findOne({
        organizationId: sample.organizationId,
        skuCode,
        isDeleted: false,
      });
      previews.push({
        size: row.size,
        color: { name: variant.name, hexCode: variant.hexCode },
        skuCode,
        name: `${design.title} - ${row.size} - ${variant.name || 'Default'}`,
        exists: !!existing,
        existingSkuId: existing?._id,
      });
    }
  }

  if (!previews.length) {
    const sizeCode = 'M';
    const color = normalizeColor(null, design);
    const skuCode = await resolveSkuCode(design, sizeCode, color.name, color);
    const existing = await Sku.findOne({
      organizationId: sample.organizationId,
      skuCode,
      isDeleted: false,
    });
    previews.push({
      size: sizeCode,
      color,
      skuCode,
      name: `${design.title} - ${sizeCode} - ${color.name}`,
      exists: !!existing,
      existingSkuId: existing?._id,
    });
  }

  return {
    sampleId: sample._id,
    sampleCode: sample.sampleCode,
    designId: design._id,
    designCode: design.designCode,
    previews,
    newCount: previews.filter((p) => !p.exists).length,
    skipCount: previews.filter((p) => p.exists).length,
  };
}

export async function createSkuFromSample(
  { sampleId, factoryId, size, color, basePrice, name, status },
  userId,
) {
  const sample = await loadSample(sampleId, factoryId);
  const design = await loadDesignForSample(sample);
  const colorObj = normalizeColor(color, design);
  const sizeCode = size || design.sizeChartData?.sizeLabels?.[0] || 'M';
  const skuCode = await resolveSkuCode(design, sizeCode, colorObj.name, colorObj);

  const existing = await Sku.findOne({
    organizationId: sample.organizationId,
    skuCode,
    isDeleted: false,
  });
  if (existing) throw new ConflictError(`SKU code already exists: ${skuCode}`);

  const sku = await Sku.create({
    organizationId: sample.organizationId,
    factoryId: sample.factoryId,
    skuCode,
    name: name || `${design.title} - ${sizeCode} - ${colorObj.name}`,
    designId: design._id,
    sampleId: sample._id,
    size: sizeCode,
    color: colorObj,
    barcode: skuCode,
    basePrice: basePrice ?? design.targetPrice ?? 0,
    status: status || 'ACTIVE',
    createdBy: userId,
    updatedBy: userId,
  });
  return populateSku(sku);
}

export async function createSkusFromDesign({ designId, sampleId, factoryId, basePrice }, userId) {
  const sample = await loadSample(sampleId, factoryId);
  const design = await loadDesignForSample(sample);
  if (design._id.toString() !== designId) {
    throw new ConflictError('Sample does not belong to design');
  }

  await autoFillSkusForDesign(design, { overwriteExisting: false });

  const created = [];
  const skipped = [];
  for (const variant of design.colorVariants || []) {
    for (const row of variant.sizes || []) {
      if (!row.size) continue;
      let skuCode = row.sku;
      if (!skuCode) {
        try {
          const vi = design.colorVariants.indexOf(variant);
          const si = variant.sizes.indexOf(row);
          skuCode = await generateSkuForSize(design, vi, si);
        } catch {
          continue;
        }
      }

      const exists = await Sku.findOne({
        organizationId: sample.organizationId,
        skuCode,
        isDeleted: false,
      });
      if (exists) {
        skipped.push({ skuCode, reason: 'already exists' });
        continue;
      }

      const doc = await Sku.create({
        organizationId: sample.organizationId,
        factoryId: sample.factoryId,
        skuCode,
        name: `${design.title} - ${row.size} - ${variant.name || 'Default'}`,
        designId: design._id,
        sampleId: sample._id,
        size: row.size,
        color: { name: variant.name, hexCode: variant.hexCode },
        barcode: skuCode,
        basePrice: basePrice ?? design.targetPrice ?? 0,
        status: 'ACTIVE',
        createdBy: userId,
        updatedBy: userId,
      });
      created.push(doc);
    }
  }

  if (!created.length && !skipped.length) {
    throw new ValidationError('No size/color matrix on design — add color variants and size chart first');
  }

  return { created: await Promise.all(created.map(populateSku)), skipped };
}

export async function listSkus(factoryId, { page, limit, skip, status, designId, sampleId, search }) {
  const filter = applySoftDeleteFilter({ factoryId });
  if (status) filter.status = status;
  if (designId) filter.designId = designId;
  if (sampleId) filter.sampleId = sampleId;

  if (search?.trim()) {
    const regex = new RegExp(escapeRegex(search.trim()), 'i');
    const matchingDesigns = await Design.find(applySoftDeleteFilter({
      factoryId,
      $or: [{ designCode: regex }, { title: regex }, { styleNumber: regex }],
    })).select('_id');
    filter.$or = [
      { skuCode: regex },
      { name: regex },
      { barcode: regex },
      ...(matchingDesigns.length ? [{ designId: { $in: matchingDesigns.map((d) => d._id) } }] : []),
    ];
  }

  const [items, total] = await Promise.all([
    Sku.find(filter).populate(SKU_POPULATE).skip(skip).limit(limit).sort({ updatedAt: -1 }),
    Sku.countDocuments(filter),
  ]);
  return { items, total };
}

export async function getSku(id, factoryId) {
  const sku = await Sku.findOne(applySoftDeleteFilter({ _id: id, factoryId })).populate(SKU_POPULATE);
  if (!sku) throw new NotFoundError('SKU not found');
  return sku;
}

async function loadSku(id, factoryId) {
  const sku = await Sku.findOne(applySoftDeleteFilter({ _id: id, factoryId }));
  if (!sku) throw new NotFoundError('SKU not found');
  return sku;
}

export async function updateSku(id, factoryId, data, userId) {
  const sku = await loadSku(id, factoryId);
  if (data.name?.trim()) sku.name = data.name.trim();
  if (data.basePrice != null) sku.basePrice = data.basePrice;
  if (data.barcode != null) sku.barcode = data.barcode;
  if (data.status && SKU_STATUS_LIST.includes(data.status)) sku.status = data.status;
  sku.updatedBy = userId;
  await sku.save();
  return populateSku(sku);
}
