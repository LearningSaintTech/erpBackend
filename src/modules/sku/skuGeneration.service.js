import { buildStyleGenderSegment } from '../../shared/utils/skuGenderToken.js';
import { ValidationError, ConflictError } from '../../shared/errors/AppError.js';
import { resolveInventoryCode, getActiveSkuFormulaConfig } from '../inventoryCode/inventoryCode.service.js';
import { Design } from '../design/design.model.js';
import { applySoftDeleteFilter } from '../../shared/utils/schema.js';

const SELLABLE_EXCLUDED_KEYS = new Set(['skuUid']);

function normalizeToken(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

function getSizeLabels(design) {
  const labels = design.sizeChartData?.sizeLabels;
  if (labels?.length) return labels.map((s) => normalizeToken(s));
  return [];
}

export function ensureSizeMatrix(design) {
  const sizeLabels = getSizeLabels(design);
  if (!design.colorVariants?.length || !sizeLabels.length) return;

  for (const variant of design.colorVariants) {
    if (!variant.sizes?.length) {
      variant.sizes = sizeLabels.map((size) => ({ size, sku: '' }));
      continue;
    }
    const existing = new Map(variant.sizes.map((row) => [normalizeToken(row.size), row]));
    variant.sizes = sizeLabels.map((size) => {
      const prev = existing.get(size);
      return prev ? { ...prev, size } : { size, sku: '' };
    });
  }
}

export async function syncSkuCodeInputs(design) {
  const styleGender = buildStyleGenderSegment(design.styleNumber, design.gender);
  const productTypeCode = design.skuPrefix?.trim() || '';
  let productType = productTypeCode;
  if (!productType && design.category) {
    productType = await resolveInventoryCode('CATEGORY', design.category);
  }
  let fitType = '';
  if (design.fit) {
    fitType = await resolveInventoryCode('FIT', design.fit);
  }

  design.skuCodeInputs = {
    styleNu: design.styleNumber || '',
    gender: design.gender || '',
    styleGender,
    productType: productType || '',
    productTypeCode: productTypeCode || productType || '',
    fitType: fitType || '',
    collectionId: design.collectionId || null,
  };

  for (const variant of design.colorVariants || []) {
    const colourInput = variant.code || variant.name || '';
    const colour = colourInput ? await resolveInventoryCode('COLOR', colourInput) : '';
    variant.skuCodeInputs = { colour: colour || '' };
  }
}

async function resolveSegment(key, design, variant, sizeRow) {
  switch (key) {
    case 'styleGender':
      return design.skuCodeInputs?.styleGender || buildStyleGenderSegment(design.styleNumber, design.gender);
    case 'productType': {
      if (design.skuPrefix?.trim()) return normalizeToken(design.skuPrefix);
      if (design.skuCodeInputs?.productType) return normalizeToken(design.skuCodeInputs.productType);
      if (design.category) return await resolveInventoryCode('CATEGORY', design.category);
      return '';
    }
    case 'fitType':
      if (design.skuCodeInputs?.fitType) return normalizeToken(design.skuCodeInputs.fitType);
      if (design.fit) return await resolveInventoryCode('FIT', design.fit);
      return '';
    case 'colour': {
      const colourInput = variant.skuCodeInputs?.colour || variant.code || variant.name;
      if (!colourInput) return '';
      return await resolveInventoryCode('COLOR', colourInput);
    }
    case 'size':
      return normalizeToken(sizeRow?.size);
    case 'skuUid':
      return '';
    default:
      return '';
  }
}

export async function generateSkuForSize(design, variantIndex, sizeIndex, formulaConfig) {
  const config = formulaConfig || await getActiveSkuFormulaConfig();
  if (!config) throw new ValidationError('No active SKU formula configuration');

  const variant = design.colorVariants?.[variantIndex];
  const sizeRow = variant?.sizes?.[sizeIndex];
  if (!variant || !sizeRow) throw new ValidationError('Invalid variant or size index');

  const segments = [];
  for (const seg of config.skuSegmentOrder || []) {
    if (SELLABLE_EXCLUDED_KEYS.has(seg.key)) continue;
    const token = await resolveSegment(seg.key, design, variant, sizeRow);
    if (!token) {
      if (!seg.optional) {
        throw new ValidationError(
          `Cannot generate sku: missing code for segment '${seg.key}' (size '${sizeRow.size}')`,
        );
      }
      continue;
    }
    segments.push(token);
  }
  return segments.join('-');
}

export async function autoFillSkusForDesign(design, { overwriteExisting = false } = {}) {
  if (!design.collectionId) {
    throw new ValidationError('Collection is required before SKU generation');
  }
  if (!design.styleNumber?.trim()) {
    return design;
  }

  const config = await getActiveSkuFormulaConfig();
  if (!config) throw new ValidationError('No active SKU formula configuration');

  ensureSizeMatrix(design);
  await syncSkuCodeInputs(design);

  for (let vi = 0; vi < (design.colorVariants || []).length; vi += 1) {
    const variant = design.colorVariants[vi];
    for (let si = 0; si < (variant.sizes || []).length; si += 1) {
      const sizeRow = variant.sizes[si];
      if (sizeRow.sku && !overwriteExisting) continue;
      sizeRow.sku = await generateSkuForSize(design, vi, si, config);
    }
  }
  return design;
}

export function collectGeneratedSkus(design) {
  const skus = [];
  for (const variant of design.colorVariants || []) {
    for (const sizeRow of variant.sizes || []) {
      if (sizeRow.sku) skus.push(sizeRow.sku);
    }
  }
  return skus;
}

export async function validateGeneratedSkus(design, { excludeDesignId } = {}) {
  const skus = collectGeneratedSkus(design);
  const dupInDesign = skus.find((sku, idx) => skus.indexOf(sku) !== idx);
  if (dupInDesign) {
    throw new ConflictError(`Duplicate SKU within design: ${dupInDesign}`);
  }

  if (!design.factoryId || !skus.length) return;

  const filter = applySoftDeleteFilter({
    factoryId: design.factoryId,
    'colorVariants.sizes.sku': { $in: skus },
  });
  if (excludeDesignId) filter._id = { $ne: excludeDesignId };

  const conflict = await Design.findOne(filter).select('designCode styleNumber colorVariants.sizes.sku');
  if (conflict) {
    throw new ConflictError(`SKU already used by design ${conflict.designCode}`);
  }
}
