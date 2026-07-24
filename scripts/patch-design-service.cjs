const fs = require('fs');
const p = 'c:/Users/PushkarLS68/erpFactory/backend/src/modules/design/design.service.js';
let s = fs.readFileSync(p, 'utf8');

if (!s.includes('skuGeneration.service')) {
  s = s.replace(
    "} from '../../config/designLookups.js';",
    `} from '../../config/designLookups.js';
import {
  autoFillSkusForDesign,
  validateGeneratedSkus,
} from '../sku/skuGeneration.service.js';`
  );
}

s = s.replace(
  "'title', 'description', 'skuPrefix', 'category',",
  "'title', 'description', 'skuPrefix', 'styleNumber', 'skuCodeInputs', 'category',"
);

const skuHelpers = `
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
`;

if (!s.includes('applySkuPipeline')) {
  s = s.replace('const MAX_ASSET_BYTES', skuHelpers + '\nconst MAX_ASSET_BYTES');
}

s = s.replace(
  `export async function createDesign(data, userId) {
  const factory = await Factory.findById(data.factoryId);
  if (!factory) throw new NotFoundError('Factory not found');
  const prefix = \`DSN-\${factory.code}-\`;
  const designCode = await nextDocumentNumber(data.factoryId, 'DESIGN', prefix);
  const design = await Design.create({
    ...data,
    designCode,
    status: 'DRAFT',
    currentVersion: 1,
    createdBy: userId,
    updatedBy: userId,
  });
  recomputeCosting(design);
  await design.save();
  await saveVersionSnapshot(design, userId, 'Initial Design');
  return getDesign(design._id);
}`,
  `export async function createDesign(data, userId) {
  if (!data.collectionId) throw new ValidationError('Collection is required');
  const factory = await Factory.findById(data.factoryId);
  if (!factory) throw new NotFoundError('Factory not found');
  const prefix = \`DSN-\${factory.code}-\`;
  const designCode = await nextDocumentNumber(data.factoryId, 'DESIGN', prefix);
  const design = await Design.create({
    ...data,
    designCode,
    status: 'DRAFT',
    currentVersion: 1,
    createdBy: userId,
    updatedBy: userId,
  });
  recomputeCosting(design);
  await assertStyleNumberUnique(design);
  await applySkuPipeline(design, { overwriteExisting: false });
  await design.save();
  await saveVersionSnapshot(design, userId, 'Initial Design');
  return getDesign(design._id);
}`
);

s = s.replace(
  'export async function listDesigns(factoryId, { status, category, tags, page, limit, skip, viewer, permissions }) {',
  'export async function listDesigns(factoryId, { status, category, collectionId, tags, page, limit, skip, viewer, permissions }) {'
);
s = s.replace(
  '  if (category) filter.category = category;',
  '  if (category) filter.category = category;\n  if (collectionId) filter.collectionId = collectionId;'
);
s = s.replace(
  '.sort({ createdAt: -1 }),',
  '.sort({ collectionId: 1, styleNumber: 1, createdAt: -1 }),'
);
s = s.replace(
  `.populate('collectionId', 'name')`,
  `.populate('collectionId', 'name code')`
);

s = s.replace(
  `  recomputeCosting(design);
  const after = buildDesignSnapshot(design);
  const changeSummary = detectChangeSummary(before, after);

  design.currentVersion = (design.currentVersion || 1) + 1;
  design.updatedBy = userId;
  design.updatedAt = new Date();
  await design.save();`,
  `  recomputeCosting(design);
  if (!design.collectionId) throw new ValidationError('Collection is required');
  await assertStyleNumberUnique(design);
  await applySkuPipeline(design, { overwriteExisting: false, excludeDesignId: design._id });
  const after = buildDesignSnapshot(design);
  const changeSummary = detectChangeSummary(before, after);

  design.currentVersion = (design.currentVersion || 1) + 1;
  design.updatedBy = userId;
  design.updatedAt = new Date();
  await design.save();`
);

const regenerateFn = `
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
`;

if (!s.includes('regenerateDesignSkus')) {
  s = s.replace('export function generateBomFromDesign', regenerateFn + '\nexport function generateBomFromDesign');
}

fs.writeFileSync(p, s);
console.log('design.service patched');
