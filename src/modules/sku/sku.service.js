import { Sku } from './sku.model.js';
import { Sample } from '../sampling/sample.model.js';
import { Design } from '../design/design.model.js';
import { PatternDevelopment } from '../pattern/pattern.model.js';
import { Bom } from '../bom/bom.model.js';
import { NotFoundError, ConflictError, ValidationError } from '../../shared/errors/AppError.js';
import {
  applySoftDeleteFilter, asObjectId, escapeRegex, queryString,
} from '../../shared/utils/schema.js';
import { autoFillSkusForDesign, validateGeneratedSkus } from './skuGeneration.service.js';
import { SKU_STATUS_LIST } from './sku.defaults.js';

function normalizeToken(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
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

/** Full design document (not the populated subset) so the generated matrix can be saved. */
async function loadDesignForSample(sample) {
  const designId = sample.designId?._id || sample.designId;
  const design = await Design.findOne(applySoftDeleteFilter({ _id: designId, factoryId: sample.factoryId }));
  if (!design) throw new NotFoundError('Design not found');
  return design;
}

/** After release the pattern master's graded chart owns the size range; else the designer's. */
async function resolveSkuSizeLabels(design) {
  const pd = await PatternDevelopment.findOne(applySoftDeleteFilter({
    designId: design._id,
    factoryId: design.factoryId,
  })).select('status sizeChartData.sizeLabels');
  const graded = (pd?.sizeChartData?.sizeLabels || []).filter((s) => String(s || '').trim());
  if (graded.length) return { sizeLabels: graded, sizeSource: 'pattern', pattern: pd };
  return {
    sizeLabels: (design.sizeChartData?.sizeLabels || []).filter((s) => String(s || '').trim()),
    sizeSource: 'design',
    pattern: pd,
  };
}

/**
 * The single SKU matrix used by preview, bulk create and single create: generated with the
 * configured formula, written to design.colorVariants[].sizes[].sku (empty codes, or codes no
 * Sku document uses yet), validated for duplicates, and checked against existing Sku codes.
 */
async function buildSkuMatrix(sample, { persist = false, userId } = {}) {
  const design = await loadDesignForSample(sample);
  const { sizeLabels, sizeSource, pattern } = await resolveSkuSizeLabels(design);
  if (!pattern || pattern.status !== 'COMPLETED') {
    throw new ConflictError(
      `Pattern development ${pattern ? `is ${pattern.status.replace(/_/g, ' ').toLowerCase()}` : 'has not started'}`
      + ' — the pattern master must complete (re-sign) the pattern before SKUs are generated',
    );
  }
  if (!design.styleNumber?.trim()) {
    throw new ValidationError(`${design.designCode} has no style number — SKU codes cannot be generated`);
  }
  if (!design.colorVariants?.length) {
    throw new ValidationError(`${design.designCode} has no colour variants — add at least one before creating SKUs`);
  }
  if (!sizeLabels.length) {
    throw new ValidationError(`${design.designCode} has no size range — grade the pattern size chart first`);
  }

  const usedCodes = new Set(await Sku.find({
    organizationId: sample.organizationId,
    designId: design._id,
    isDeleted: false,
  }).distinct('skuCode'));
  // Keep codes that already back a Sku; refresh empty or stale (unused) ones.
  await autoFillSkusForDesign(design, {
    sizeLabels,
    overwriteExisting: (code) => !usedCodes.has(code),
  });
  await validateGeneratedSkus(design, { excludeDesignId: design._id });

  const rows = [];
  for (const variant of design.colorVariants || []) {
    for (const row of variant.sizes || []) {
      if (!row.size) continue;
      if (!row.sku) {
        throw new ValidationError(`SKU code could not be generated for ${variant.name || 'colour'} / ${row.size}`);
      }
      rows.push({
        size: row.size,
        color: { name: variant.name, hexCode: variant.hexCode },
        skuCode: row.sku,
        name: `${design.title} - ${row.size} - ${variant.name || 'Default'}`,
      });
    }
  }
  if (!rows.length) {
    throw new ValidationError('No size/colour matrix on design — add colour variants and a size range first');
  }

  const existing = await Sku.find({
    organizationId: sample.organizationId,
    skuCode: { $in: rows.map((r) => r.skuCode) },
    isDeleted: false,
  }).select('skuCode designId factoryId');
  const byCode = new Map(existing.map((s) => [s.skuCode, s]));
  for (const row of rows) {
    const ex = byCode.get(row.skuCode);
    row.exists = !!ex;
    row.existingSkuId = ex?._id;
    if (ex && (String(ex.designId || '') !== String(design._id)
      || String(ex.factoryId || '') !== String(sample.factoryId))) {
      row.conflict = `SKU code ${row.skuCode} already belongs to another design or factory`;
    }
  }

  if (persist && design.isModified()) {
    if (userId) design.updatedBy = userId;
    await design.save();
  }
  return { design, rows, sizeSource };
}

function assertNoMatrixConflicts(rows) {
  const conflicts = rows.filter((r) => r.conflict);
  if (conflicts.length) {
    const codes = conflicts.slice(0, 5).map((r) => r.skuCode).join(', ');
    throw new ConflictError(
      `${conflicts.length} SKU code(s) already belong to another design or factory: ${codes}`
      + ' — change the style number / colour codes and regenerate',
    );
  }
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
    .populate('designId', 'designCode title styleNumber colorVariants sizeChartData.sizeLabels')
    .sort({ updatedAt: -1 });

  const existingCounts = await Sku.aggregate([
    { $match: { factoryId: asObjectId(factoryId), isDeleted: false } },
    { $group: { _id: '$sampleId', count: { $sum: 1 } } },
  ]);
  const countBySample = new Map(existingCounts.map((r) => [r._id?.toString(), r.count]));

  // Same size source as buildSkuMatrix: graded pattern chart, else the designer's range.
  const designIds = samples.map((s) => s.designId?._id).filter(Boolean);
  const patterns = await PatternDevelopment.find(applySoftDeleteFilter({
    factoryId,
    designId: { $in: designIds },
  })).select('designId sizeChartData.sizeLabels');
  const gradedByDesign = new Map(patterns.map((p) => [
    String(p.designId),
    (p.sizeChartData?.sizeLabels || []).filter((x) => String(x || '').trim()).length,
  ]));

  return samples.map((s) => {
    const design = s.designId;
    const graded = gradedByDesign.get(String(design?._id)) || 0;
    const sizeCount = graded || (design?.sizeChartData?.sizeLabels || []).length;
    const matrixRows = (design?.colorVariants || []).length * sizeCount;
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
  // Same matrix bulk create uses (not saved), so the counts shown here are the counts created.
  const { design, rows, sizeSource } = await buildSkuMatrix(sample, { persist: false });
  return {
    sampleId: sample._id,
    sampleCode: sample.sampleCode,
    designId: design._id,
    designCode: design.designCode,
    sizeSource,
    previews: rows,
    newCount: rows.filter((p) => !p.exists && !p.conflict).length,
    skipCount: rows.filter((p) => p.exists && !p.conflict).length,
    conflictCount: rows.filter((p) => p.conflict).length,
  };
}

export async function createSkuFromSample(
  { sampleId, factoryId, size, color, basePrice, name, status },
  userId,
) {
  const sample = await loadSample(sampleId, factoryId);
  const { design, rows } = await buildSkuMatrix(sample, { persist: true, userId });
  const colorName = color?.name || design.colorVariants?.[0]?.name || '';
  const sizeCode = normalizeToken(size || rows[0]?.size);
  const row = rows.find((r) => normalizeToken(r.size) === sizeCode
    && String(r.color?.name || '').toLowerCase() === String(colorName).toLowerCase());
  if (!row) {
    throw new ValidationError(
      `Size ${sizeCode || '—'} / colour ${colorName || '—'} is not in ${design.designCode}'s SKU matrix`,
    );
  }
  if (row.conflict) throw new ConflictError(row.conflict);
  if (row.exists) throw new ConflictError(`SKU code already exists: ${row.skuCode}`);

  const sku = await Sku.create({
    organizationId: sample.organizationId,
    factoryId: sample.factoryId,
    skuCode: row.skuCode,
    name: name || row.name,
    designId: design._id,
    sampleId: sample._id,
    size: row.size,
    color: row.color,
    barcode: row.skuCode,
    basePrice: basePrice ?? design.targetPrice ?? 0,
    status: status || 'ACTIVE',
    createdBy: userId,
    updatedBy: userId,
  });
  return populateSku(sku);
}

export async function createSkusFromDesign({ designId, sampleId, factoryId, basePrice }, userId) {
  const sample = await loadSample(sampleId, factoryId);
  if (String(sample.designId?._id || sample.designId) !== String(designId)) {
    throw new ConflictError('Sample does not belong to design');
  }

  const { design, rows } = await buildSkuMatrix(sample, { persist: true, userId });
  assertNoMatrixConflicts(rows);

  const created = [];
  const skipped = [];
  for (const row of rows) {
    if (row.exists) {
      skipped.push({ skuCode: row.skuCode, reason: 'already exists' });
      continue;
    }
    const doc = await Sku.create({
      organizationId: sample.organizationId,
      factoryId: sample.factoryId,
      skuCode: row.skuCode,
      name: row.name,
      designId: design._id,
      sampleId: sample._id,
      size: row.size,
      color: row.color,
      barcode: row.skuCode,
      basePrice: basePrice ?? design.targetPrice ?? 0,
      status: 'ACTIVE',
      createdBy: userId,
      updatedBy: userId,
    });
    created.push(doc);
  }

  return { created: await Promise.all(created.map(populateSku)), skipped };
}

/** SKU ids that have a frozen (ACTIVE) BOM — the production-ready handoff set. */
async function skuIdsWithActiveBom(factoryId, skuIds) {
  const filter = { factoryId: asObjectId(factoryId), status: 'ACTIVE', isDeleted: false };
  if (skuIds) filter.skuId = { $in: skuIds };
  return Bom.distinct('skuId', filter);
}

export async function listSkus(factoryId, {
  page, limit, skip, status, designId, sampleId, search, hasActiveBom,
}) {
  const filter = applySoftDeleteFilter({ factoryId });
  status = queryString(status);
  designId = queryString(designId);
  sampleId = queryString(sampleId);
  search = queryString(search);
  hasActiveBom = queryString(hasActiveBom);
  if (status) {
    const statuses = status.split(',').map((s) => s.trim()).filter(Boolean);
    filter.status = statuses.length > 1 ? { $in: statuses } : statuses[0];
  }
  if (designId) filter.designId = designId;
  if (sampleId) filter.sampleId = sampleId;

  if (hasActiveBom === 'true' || hasActiveBom === 'false') {
    const withBom = await skuIdsWithActiveBom(factoryId);
    filter._id = hasActiveBom === 'true' ? { $in: withBom } : { $nin: withBom };
  }

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
  const activeSet = new Set(
    (await skuIdsWithActiveBom(factoryId, items.map((s) => s._id))).map(String),
  );
  return {
    items: items.map((s) => ({ ...s.toObject(), hasActiveBom: activeSet.has(String(s._id)) })),
    total,
  };
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
