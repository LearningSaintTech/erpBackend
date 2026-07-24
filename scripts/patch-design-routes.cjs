const fs = require('fs');
const p = 'c:/Users/PushkarLS68/erpFactory/backend/src/modules/design/design.routes.js';
let s = fs.readFileSync(p, 'utf8');

s = s.replace(
  `const colorVariantSchema = Joi.object({
  name: Joi.string().required(),
  pantoneCode: Joi.string().allow(''),
  hexCode: Joi.string().allow(''),
  code: Joi.string().allow(''),
  fabricDyeCode: Joi.string().allow(''),
  supplierShade: Joi.string().allow(''),
  status: Joi.string().valid(...COLOR_VARIANT_STATUSES),
  frontImageAssetId: Joi.string().allow(null, ''),
  backImageAssetId: Joi.string().allow(null, ''),
  availableQty: Joi.number().min(0).allow(null),
});`,
  `const colorVariantSchema = Joi.object({
  name: Joi.string().required(),
  pantoneCode: Joi.string().allow(''),
  hexCode: Joi.string().allow(''),
  code: Joi.string().allow(''),
  fabricDyeCode: Joi.string().allow(''),
  supplierShade: Joi.string().allow(''),
  status: Joi.string().valid(...COLOR_VARIANT_STATUSES),
  frontImageAssetId: Joi.string().allow(null, ''),
  backImageAssetId: Joi.string().allow(null, ''),
  availableQty: Joi.number().min(0).allow(null),
  sizes: Joi.array().items(Joi.object({
    size: Joi.string().required(),
    sku: Joi.string().allow(''),
  })),
});`
);

s = s.replace(
  `  skuPrefix: Joi.string().allow(''),
  category:`,
  `  skuPrefix: Joi.string().allow(''),
  styleNumber: Joi.string().allow(''),
  category:`
);

s = s.replace(
  `  collectionId: Joi.string().allow(null, ''),`,
  `  collectionId: Joi.string().required(),`
);

const createSchemaOld = `const createSchema = Joi.object({ body: designBodySchema });`;
const createSchemaNew = `const createSchema = Joi.object({ body: designBodySchema });
const createUpdateCollectionOptional = designBodySchema.fork(['collectionId'], (s) => s.optional());`;
if (!s.includes('createUpdateCollectionOptional')) {
  s = s.replace(createSchemaOld, createSchemaNew);
  s = s.replace(
    `const updateSchema = Joi.object({ body: designBodySchema.fork(['title'], (s) => s.optional()) });`,
    `const updateSchema = Joi.object({ body: createUpdateCollectionOptional.fork(['title'], (s) => s.optional()) });`
  );
}

s = s.replace(
  `      category: req.query.category,
      tags: req.query.tags,`,
  `      category: req.query.category,
      collectionId: req.query.collectionId,
      tags: req.query.tags,`
);

if (!s.includes('generate-sku')) {
  s = s.replace(
    `router.put('/designs/:id', rbac('design.update'), validate(updateSchema), async (req, res, next) => {`,
    `router.post('/designs/:id/generate-sku', rbac('design.update'), async (req, res, next) => {
  try {
    success(res, await designService.regenerateDesignSkus(req.params.id, req.user._id, {
      viewer: req.user,
      permissions: req.permissions || [],
    }));
  } catch (e) { next(e); }
});

router.put('/designs/:id', rbac('design.update'), validate(updateSchema), async (req, res, next) => {`
  );
}

fs.writeFileSync(p, s);
console.log('routes patched', s.includes('generate-sku'));
