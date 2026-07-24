const fs = require('fs');

// app.js
const appPath = 'c:/Users/PushkarLS68/erpFactory/backend/src/app.js';
let app = fs.readFileSync(appPath, 'utf8');
if (!app.includes('inventoryCode')) {
  app = app.replace(
    "import settingsRoutes from './modules/settings/settings.routes.js';",
    "import settingsRoutes from './modules/settings/settings.routes.js';\nimport inventoryCodeRoutes from './modules/inventoryCode/inventoryCode.routes.js';"
  );
  app = app.replace(
    "app.use('/api/v1', settingsRoutes);",
    "app.use('/api/v1', settingsRoutes);\napp.use('/api/v1', inventoryCodeRoutes);"
  );
  fs.writeFileSync(appPath, app);
  console.log('app.js patched');
}

// sku.service.js
const skuPath = 'c:/Users/PushkarLS68/erpFactory/backend/src/modules/sku/sku.service.js';
let sku = fs.readFileSync(skuPath, 'utf8');
if (!sku.includes('createSkusFromDesign')) {
  sku = `import { Sku } from './sku.model.js';
import { Sample } from '../sampling/sample.model.js';
import { Design } from '../design/design.model.js';
import { NotFoundError, ConflictError } from '../../shared/errors/AppError.js';
import { applySoftDeleteFilter } from '../../shared/utils/schema.js';

export async function createSkuFromSample({ sampleId, size, color, basePrice, name }, userId) {
  const sample = await Sample.findOne(applySoftDeleteFilter({ _id: sampleId }));
  if (!sample) throw new NotFoundError('Sample not found');
  if (sample.status !== 'APPROVED') throw new ConflictError('Sample must be APPROVED to create SKU');

  const design = await Design.findById(sample.designId);
  if (!design) throw new NotFoundError('Design not found');

  const colorName = color?.name || design?.colorVariants?.[0]?.name || 'Default';
  const sizeCode = size || 'M';

  let skuCode = null;
  for (const variant of design.colorVariants || []) {
    const variantColor = variant.name || '';
    if (color?.name && variantColor && variantColor !== color.name) continue;
    for (const row of variant.sizes || []) {
      if (sizeCode && row.size && row.size !== sizeCode) continue;
      if (row.sku) {
        skuCode = row.sku;
        break;
      }
    }
    if (skuCode) break;
  }

  if (!skuCode) {
    skuCode = \`\${design?.designCode || 'SKU'}-\${sizeCode}-\${colorName.substring(0, 3).toUpperCase()}\`;
  }

  const existing = await Sku.findOne({ organizationId: sample.organizationId, skuCode, isDeleted: false });
  if (existing) throw new ConflictError('SKU code already exists');

  return Sku.create({
    organizationId: sample.organizationId,
    factoryId: sample.factoryId,
    skuCode,
    name: name || \`\${design?.title || 'Product'} - \${sizeCode} - \${colorName}\`,
    designId: sample.designId,
    sampleId: sample._id,
    size: sizeCode,
    color: color || design?.colorVariants?.[0] || { name: colorName },
    barcode: skuCode,
    basePrice: basePrice || 0,
    status: 'ACTIVE',
    createdBy: userId,
    updatedBy: userId,
  });
}

export async function createSkusFromDesign({ designId, sampleId, basePrice }, userId) {
  const sample = await Sample.findOne(applySoftDeleteFilter({ _id: sampleId }));
  if (!sample) throw new NotFoundError('Sample not found');
  if (sample.status !== 'APPROVED') throw new ConflictError('Sample must be APPROVED to create SKUs');
  if (sample.designId?.toString() !== designId) throw new ConflictError('Sample does not belong to design');

  const design = await Design.findById(designId);
  if (!design) throw new NotFoundError('Design not found');

  const created = [];
  for (const variant of design.colorVariants || []) {
    for (const row of variant.sizes || []) {
      if (!row.sku) continue;
      const exists = await Sku.findOne({
        organizationId: sample.organizationId,
        skuCode: row.sku,
        isDeleted: false,
      });
      if (exists) continue;

      const doc = await Sku.create({
        organizationId: sample.organizationId,
        factoryId: sample.factoryId,
        skuCode: row.sku,
        name: \`\${design.title} - \${row.size} - \${variant.name || 'Default'}\`,
        designId: design._id,
        sampleId: sample._id,
        size: row.size,
        color: { name: variant.name, hexCode: variant.hexCode },
        barcode: row.sku,
        basePrice: basePrice || design.targetPrice || 0,
        status: 'ACTIVE',
        createdBy: userId,
        updatedBy: userId,
      });
      created.push(doc);
    }
  }
  return created;
}

export async function listSkus(factoryId, { page, limit, skip }) {
  const filter = applySoftDeleteFilter({ factoryId });
  const [items, total] = await Promise.all([
    Sku.find(filter).skip(skip).limit(limit).sort({ createdAt: -1 }),
    Sku.countDocuments(filter),
  ]);
  return { items, total };
}

export async function getSku(id) {
  const sku = await Sku.findOne(applySoftDeleteFilter({ _id: id }));
  if (!sku) throw new NotFoundError('SKU not found');
  return sku;
}
`;
  fs.writeFileSync(skuPath, sku);
  console.log('sku.service patched');
}

// sku.routes.js
const skuRoutesPath = 'c:/Users/PushkarLS68/erpFactory/backend/src/modules/sku/sku.routes.js';
let skuRoutes = fs.readFileSync(skuRoutesPath, 'utf8');
if (!skuRoutes.includes('/skus/bulk')) {
  skuRoutes = skuRoutes.replace(
    `router.post('/skus', rbac('sku.create'), validate(createSchema), async (req, res, next) => {`,
    `const bulkSchema = Joi.object({
  body: Joi.object({
    designId: Joi.string().required(),
    sampleId: Joi.string().required(),
    basePrice: Joi.number(),
  }),
});

router.post('/skus/bulk', rbac('sku.create'), validate(bulkSchema), async (req, res, next) => {
  try {
    const skus = await skuService.createSkusFromDesign(req.body, req.user._id);
    success(res, skus, null, 201);
  } catch (e) { next(e); }
});

router.post('/skus', rbac('sku.create'), validate(createSchema), async (req, res, next) => {`
  );
  fs.writeFileSync(skuRoutesPath, skuRoutes);
  console.log('sku.routes patched');
}
