import { Router } from 'express';
import Joi from 'joi';
import { authMiddleware } from '../../middleware/auth.js';
import { tenantMiddleware, requireFactory } from '../../middleware/tenant.js';
import { rbac, rbacAny } from '../../middleware/rbac.js';
import { validate } from '../../middleware/errorHandler.js';
import { ForbiddenError } from '../../shared/errors/AppError.js';
import { success, paginate, buildMeta } from '../../shared/utils/response.js';
import * as designService from './design.service.js';
import {
  DESIGN_CATEGORIES, DESIGN_FITS, DESIGN_GENDERS, DESIGN_AGE_GROUPS,
  ACCESSORY_TYPES, COLOR_VARIANT_STATUSES, PRODUCTION_PRIORITIES, DESIGN_ASSET_TYPES,
} from '../../config/designLookups.js';

const router = Router();
router.use(authMiddleware, tenantMiddleware, requireFactory);

/** Design authors must not approve; factory admins (create+approve+elevated) may. */
function forbidDesignAuthorReview(req, _res, next) {
  const perms = req.permissions || [];
  if (req.user?.isSuperAdmin || perms.includes('*')) return next();
  if (!perms.includes('design.approve')) {
    return next(new ForbiddenError('Insufficient permissions'));
  }
  const isAuthor = perms.includes('design.create') || perms.includes('design.update');
  if (!isAuthor) return next();
  const elevated = perms.includes('design.delete')
    || perms.includes('user.read')
    || perms.includes('user.update')
    || perms.includes('approval.approve')
    || perms.includes('approval.configure')
    || perms.includes('role.configure');
  if (!elevated) {
    return next(new ForbiddenError('Design authors cannot approve or release designs'));
  }
  return next();
}

const productSpecsSchema = Joi.object({
  material: Joi.string().allow(''),
  fabricGsm: Joi.number().min(0).allow(null),
  fabricWidth: Joi.string().allow(''),
  fabricFinish: Joi.string().allow(''),
  shrinkagePercent: Joi.number().min(0).allow(null),
  printingType: Joi.string().allow(''),
  embroidery: Joi.boolean(),
  washCare: Joi.string().allow(''),
  ironing: Joi.string().allow(''),
});

const colorVariantSchema = Joi.object({
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
});

const fabricConsumptionSchema = Joi.object({
  materialId: Joi.string().required(),
  color: Joi.string().allow(''),
  gsm: Joi.number().min(0).allow(null),
  consumption: Joi.number().min(0),
  unit: Joi.string(),
  wastagePercent: Joi.number().min(0).max(100),
  supplierName: Joi.string().allow(''),
  fabricCost: Joi.number().min(0),
  leadTimeDays: Joi.number().min(0).allow(null),
  minOrderQty: Joi.number().min(0).allow(null),
  approvedVendor: Joi.boolean(),
});

const accessorySchema = Joi.object({
  accessoryType: Joi.string().valid(...ACCESSORY_TYPES).allow(''),
  materialId: Joi.string().allow(''),
  color: Joi.string().allow(''),
  size: Joi.string().allow(''),
  supplierName: Joi.string().allow(''),
  consumption: Joi.number().min(0),
  unit: Joi.string().allow(''),
  unitCost: Joi.number().min(0),
  approved: Joi.boolean(),
});

const sizeChartDataSchema = Joi.object({
  unit: Joi.string(),
  sizeLabels: Joi.array().items(Joi.string()),
  rows: Joi.array().items(Joi.object({
    measurementName: Joi.string().required(),
    values: Joi.object().pattern(Joi.string(), Joi.number()),
  })),
});

const bomLineSchema = Joi.object({
  materialId: Joi.string().allow(''),
  materialName: Joi.string().allow(''),
  quantity: Joi.number().min(0),
  unit: Joi.string().allow(''),
  category: Joi.string().allow(''),
  notes: Joi.string().allow(''),
});

const costingSchema = Joi.object({
  fabricCost: Joi.number().min(0),
  accessoriesCost: Joi.number().min(0),
  printingCost: Joi.number().min(0),
  embroideryCost: Joi.number().min(0),
  laborCost: Joi.number().min(0),
  packingCost: Joi.number().min(0),
  overhead: Joi.number().min(0),
  profitPercent: Joi.number().min(0),
  expectedSellingPrice: Joi.number().min(0),
  actualCost: Joi.number(),
  margin: Joi.number(),
});

const productionInfoSchema = Joi.object({
  sampleRequired: Joi.boolean(),
  sampleDeadline: Joi.date().allow(null),
  productionLineId: Joi.string().allow(null, ''),
  expectedProductionQty: Joi.number().min(0).allow(null),
  productionPriority: Joi.string().valid(...PRODUCTION_PRIORITIES),
  remarks: Joi.string().allow(''),
});

const qualityNotesSchema = Joi.object({
  allowedDefects: Joi.string().allow(''),
  colorTolerance: Joi.string().allow(''),
  shrinkagePercent: Joi.number().min(0).allow(null),
  measurementTolerance: Joi.string().allow(''),
  checklist: Joi.array().items(Joi.object({
    item: Joi.string().required(),
    required: Joi.boolean(),
  })),
});

const manufacturingNotesSchema = Joi.object({
  specialStitch: Joi.string().allow(''),
  needleType: Joi.string().allow(''),
  machineType: Joi.string().allow(''),
  threadColor: Joi.string().allow(''),
  packingInstructions: Joi.string().allow(''),
  foldingInstructions: Joi.string().allow(''),
  ironInstructions: Joi.string().allow(''),
  barcodePosition: Joi.string().allow(''),
  labelPosition: Joi.string().allow(''),
});

const designBodySchema = Joi.object({
  title: Joi.string().required(),
  description: Joi.string().allow(''),
  skuPrefix: Joi.string().allow(''),
  styleNumber: Joi.string().allow(''),
  category: Joi.string().valid(...DESIGN_CATEGORIES).allow(''),
  subCategory: Joi.string().allow(''),
  gender: Joi.string().valid(...DESIGN_GENDERS).allow(''),
  ageGroup: Joi.string().valid(...DESIGN_AGE_GROUPS).allow(''),
  fit: Joi.string().valid(...DESIGN_FITS).allow(''),
  sleeveType: Joi.string().allow(''),
  neckType: Joi.string().allow(''),
  pattern: Joi.string().allow(''),
  occasion: Joi.string().allow(''),
  tags: Joi.array().items(Joi.string()),
  collectionId: Joi.string().required(),
  seasonId: Joi.string().allow(null, ''),
  sizeChartId: Joi.string().allow(null, ''),
  sizeChartData: sizeChartDataSchema,
  targetPrice: Joi.number().min(0).allow(null),
  currency: Joi.string().default('INR'),
  productSpecs: productSpecsSchema,
  colorVariants: Joi.array().items(colorVariantSchema),
  fabricConsumption: Joi.array().items(fabricConsumptionSchema),
  accessories: Joi.array().items(accessorySchema),
  bomLines: Joi.array().items(bomLineSchema),
  costing: costingSchema,
  productionInfo: productionInfoSchema,
  qualityNotes: qualityNotesSchema,
  manufacturingNotes: manufacturingNotesSchema,
});

const createSchema = Joi.object({ body: designBodySchema });
const createUpdateCollectionOptional = designBodySchema.fork(['collectionId'], (s) => s.optional());
const updateSchema = Joi.object({ body: createUpdateCollectionOptional.fork(['title'], (s) => s.optional()) });

const assetSchema = Joi.object({
  body: Joi.object({
    fileName: Joi.string().required(),
    mimeType: Joi.string().required(),
    contentBase64: Joi.string().required(),
    assetType: Joi.string().valid(...DESIGN_ASSET_TYPES).default('FRONT_IMAGE'),
  }),
});

const reviewCommentsSchema = Joi.object({
  body: Joi.object({
    comments: Joi.string().trim().min(3).required(),
  }),
});

router.get('/designs/stats', rbac('design.read'), async (req, res, next) => {
  try {
    success(res, await designService.getDesignStats(req.factoryId, {
      viewer: req.user,
      permissions: req.permissions || [],
    }));
  } catch (e) { next(e); }
});

router.get('/designs/lookups', rbac('design.read'), async (req, res, next) => {
  try {
    success(res, designService.getLookups());
  } catch (e) { next(e); }
});

router.post('/designs', rbac('design.create'), validate(createSchema), async (req, res, next) => {
  try {
    const design = await designService.createDesign({
      ...req.body,
      factoryId: req.factoryId,
      organizationId: req.user.organizationId || req.organizationId,
    }, req.user._id);
    success(res, design, null, 201);
  } catch (e) { next(e); }
});

router.get('/designs', rbac('design.read'), async (req, res, next) => {
  try {
    const { page, limit, skip } = paginate(req.query);
    const { items, total } = await designService.listDesigns(req.factoryId, {
      status: req.query.status,
      category: req.query.category,
      collectionId: req.query.collectionId,
      seasonId: req.query.seasonId,
      gender: req.query.gender,
      tags: req.query.tags,
      search: req.query.search || req.query.q,
      page,
      limit,
      skip,
      viewer: req.user,
      permissions: req.permissions || [],
    });
    success(res, items, buildMeta(page, limit, total));
  } catch (e) { next(e); }
});

router.get('/designs/material-options', rbac('design.read'), async (req, res, next) => {
  try {
    success(res, await designService.listMaterialOptions(req.factoryId));
  } catch (e) { next(e); }
});

router.get('/designs/:id', rbac('design.read'), async (req, res, next) => {
  try {
    success(res, await designService.getDesign(req.params.id, {
      factoryId: req.factoryId,
      viewer: req.user,
      permissions: req.permissions || [],
    }));
  } catch (e) { next(e); }
});

router.post('/designs/:id/generate-sku', rbac('design.update'), async (req, res, next) => {
  try {
    success(res, await designService.regenerateDesignSkus(req.params.id, req.user._id, {
      viewer: req.user,
      permissions: req.permissions || [],
    }));
  } catch (e) { next(e); }
});

router.put('/designs/:id', rbacAny('design.update', 'design.approve'), validate(updateSchema), async (req, res, next) => {
  try {
    success(res, await designService.updateDesign(req.params.id, req.body, req.user._id, {
      factoryId: req.factoryId,
      viewer: req.user,
      permissions: req.permissions || [],
    }));
  } catch (e) { next(e); }
});

router.post('/designs/:id/submit', rbacAny('design.update', 'design.approve'), async (req, res, next) => {
  try {
    success(res, await designService.submitDesign(req.params.id, req.user._id, {
      factoryId: req.factoryId,
      viewer: req.user,
      permissions: req.permissions || [],
    }));
  } catch (e) { next(e); }
});

router.post('/designs/:id/approve', rbac('design.approve'), forbidDesignAuthorReview, async (req, res, next) => {
  try {
    success(res, await designService.approveDesign(req.params.id, req.user._id));
  } catch (e) { next(e); }
});

router.post('/designs/:id/reject', rbac('design.approve'), forbidDesignAuthorReview, validate(reviewCommentsSchema), async (req, res, next) => {
  try {
    success(res, await designService.rejectDesign(req.params.id, req.user._id, req.body.comments));
  } catch (e) { next(e); }
});

router.post('/designs/:id/revision', rbac('design.approve'), forbidDesignAuthorReview, validate(reviewCommentsSchema), async (req, res, next) => {
  try {
    success(res, await designService.requestRevision(req.params.id, req.user._id, req.body.comments));
  } catch (e) { next(e); }
});

router.post('/designs/:id/release', rbac('design.approve'), forbidDesignAuthorReview, async (req, res, next) => {
  try {
    success(res, await designService.releaseDesign(req.params.id, req.user._id));
  } catch (e) { next(e); }
});

router.post('/designs/:id/clone', rbac('design.create'), async (req, res, next) => {
  try {
    success(res, await designService.cloneDesign(req.params.id, req.user._id, {
      viewer: req.user,
      permissions: req.permissions || [],
    }), null, 201);
  } catch (e) { next(e); }
});

router.get('/designs/:id/versions', rbac('design.read'), async (req, res, next) => {
  try {
    success(res, await designService.listDesignVersions(req.params.id, {
      viewer: req.user,
      permissions: req.permissions || [],
    }));
  } catch (e) { next(e); }
});

router.get('/designs/:id/timeline', rbac('design.read'), async (req, res, next) => {
  try {
    success(res, await designService.listDesignTimeline(req.params.id, {
      factoryId: req.factoryId,
      viewer: req.user,
      permissions: req.permissions || [],
    }));
  } catch (e) { next(e); }
});

router.get('/designs/:id/versions/:version', rbac('design.read'), async (req, res, next) => {
  try {
    success(res, await designService.getDesignVersion(req.params.id, Number(req.params.version), {
      viewer: req.user,
      permissions: req.permissions || [],
    }));
  } catch (e) { next(e); }
});

router.get('/designs/:id/samples', rbac('design.read'), async (req, res, next) => {
  try {
    success(res, await designService.listDesignSamples(req.params.id, {
      viewer: req.user,
      permissions: req.permissions || [],
    }));
  } catch (e) { next(e); }
});

router.post('/designs/:id/assets', rbacAny('design.update', 'design.approve'), validate(assetSchema), async (req, res, next) => {
  try {
    const asset = await designService.uploadDesignAsset(req.params.id, req.body, req.user._id, {
      viewer: req.user,
      permissions: req.permissions || [],
    });
    success(res, asset, null, 201);
  } catch (e) { next(e); }
});

router.delete('/designs/:id/assets/:assetId', rbacAny('design.update', 'design.approve'), async (req, res, next) => {
  try {
    success(res, await designService.deleteDesignAsset(req.params.assetId, req.user._id, {
      viewer: req.user,
      permissions: req.permissions || [],
    }));
  } catch (e) { next(e); }
});

router.get('/collections', rbac('design.read'), async (req, res, next) => {
  try {
    success(res, await designService.listCollections(req.user.organizationId || req.organizationId));
  } catch (e) { next(e); }
});

router.post('/collections', rbac('design.create'), async (req, res, next) => {
  try {
    const col = await designService.createCollection({
      ...req.body,
      organizationId: req.user.organizationId || req.organizationId,
      factoryId: req.factoryId,
    }, req.user._id);
    success(res, col, null, 201);
  } catch (e) { next(e); }
});

router.get('/seasons', rbac('design.read'), async (req, res, next) => {
  try {
    success(res, await designService.listSeasons(req.user.organizationId || req.organizationId));
  } catch (e) { next(e); }
});

router.post('/seasons', rbac('design.create'), async (req, res, next) => {
  try {
    const season = await designService.createSeason({
      ...req.body,
      organizationId: req.user.organizationId || req.organizationId,
      factoryId: req.factoryId,
    }, req.user._id);
    success(res, season, null, 201);
  } catch (e) { next(e); }
});

router.get('/size-charts', rbac('design.read'), async (req, res, next) => {
  try {
    success(res, await designService.listSizeCharts(req.factoryId));
  } catch (e) { next(e); }
});

router.post('/size-charts', rbac('design.create'), async (req, res, next) => {
  try {
    const chart = await designService.createSizeChart({
      ...req.body,
      organizationId: req.user.organizationId || req.organizationId,
      factoryId: req.factoryId,
    }, req.user._id);
    success(res, chart, null, 201);
  } catch (e) { next(e); }
});

export default router;
