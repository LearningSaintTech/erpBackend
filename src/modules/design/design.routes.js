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
  COLOR_VARIANT_STATUSES, DESIGN_ASSET_TYPES,
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

/** Design intent only — fabric technicals, wash care and ironing live on the pattern. */
const productSpecsSchema = Joi.object({
  material: Joi.string().allow(''),
  printingType: Joi.string().allow(''),
  embroidery: Joi.boolean(),
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

const sizeChartDataSchema = Joi.object({
  unit: Joi.string(),
  sizeLabels: Joi.array().items(Joi.string()),
  rows: Joi.array().items(Joi.object({
    measurementName: Joi.string().required(),
    values: Joi.object().pattern(Joi.string(), Joi.number()),
  })),
});

const designBodySchema = Joi.object({
  title: Joi.string().required(),
  description: Joi.string().allow(''),
  skuPrefix: Joi.string().allow(''),
  styleNumber: Joi.string().allow(''),
  category: Joi.string().max(40).allow(''),
  subCategory: Joi.string().max(40).allow(''),
  section: Joi.string().max(40).allow(''),
  gender: Joi.string().max(40).allow(''),
  ageGroup: Joi.string().max(40).allow(''),
  fit: Joi.string().max(40).allow(''),
  sleeveType: Joi.string().max(40).allow(''),
  neckType: Joi.string().max(40).allow(''),
  pattern: Joi.string().max(40).allow(''),
  occasion: Joi.string().max(40).allow(''),
  tags: Joi.array().items(Joi.string()),
  collectionCode: Joi.string().max(40).allow(''),
  seasonCode: Joi.string().max(40).allow(''),
  collectionId: Joi.string().allow('', null),
  seasonId: Joi.string().allow(null, ''),
  sizeChartId: Joi.string().allow(null, ''),
  sizeChartData: sizeChartDataSchema,
  targetPrice: Joi.number().min(0).allow(null),
  currency: Joi.string().default('INR'),
  productSpecs: productSpecsSchema,
  colorVariants: Joi.array().items(colorVariantSchema),
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

const releaseSchema = Joi.object({
  body: Joi.object({
    patternMasterId: Joi.string().hex().length(24).empty(['', null]),
  }).default({}),
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

router.post('/designs/:id/release', rbac('design.approve'), forbidDesignAuthorReview, validate(releaseSchema), async (req, res, next) => {
  try {
    success(res, await designService.releaseDesign(req.params.id, req.user._id, {
      patternMasterId: req.body?.patternMasterId,
    }));
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
