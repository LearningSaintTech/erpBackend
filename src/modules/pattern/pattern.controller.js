import Joi from 'joi';
import * as patternService from './pattern.service.js';
import { success, paginate, buildMeta } from '../../shared/utils/response.js';
import { PATTERN_STATUS_LIST } from './pattern.model.js';
import {
  FIT_EVALUATION_MODES, FIT_ISSUE_AREAS, FIT_ISSUE_SEVERITIES, FIT_OVERALL_RESULTS,
  PATTERN_WORKFLOW_STEPS,
} from './pattern.defaults.js';

const markerSchema = Joi.object({
  fileName: Joi.string().allow(''),
  url: Joi.string().uri().allow(''),
  mimeType: Joi.string().allow(''),
  length: Joi.number().min(0),
  width: Joi.number().min(0),
  fabricWidth: Joi.number().min(0),
  piecesPerMarker: Joi.number().min(1),
  efficiencyPercent: Joi.number().min(0).max(100),
  notes: Joi.string().allow(''),
});

const gradingSchema = Joi.object({
  baseSize: Joi.string().allow(''),
  gradedSizes: Joi.array().items(Joi.string()),
  notes: Joi.string().allow(''),
});

const calculatedConsumptionSchema = Joi.object({
  metersPerGarment: Joi.number().min(0),
  wastagePercent: Joi.number().min(0).max(100),
  derivedFromMarker: Joi.boolean(),
  notes: Joi.string().allow(''),
});

const sizeChartDataSchema = Joi.object({
  unit: Joi.string().allow(''),
  sizeLabels: Joi.array().items(Joi.string()),
  rows: Joi.array().items(Joi.object({
    measurementName: Joi.string().required(),
    values: Joi.object().pattern(Joi.string(), Joi.number()),
  })),
});

const fabricConsumptionSchema = Joi.object({
  materialId: Joi.string().required(),
  color: Joi.string().allow(''),
  gsm: Joi.number().min(0).allow(null),
  consumption: Joi.number().min(0),
  unit: Joi.string().allow(''),
  wastagePercent: Joi.number().min(0).max(100),
  supplierName: Joi.string().allow(''),
  fabricCost: Joi.number().min(0),
  leadTimeDays: Joi.number().min(0).allow(null),
  minOrderQty: Joi.number().min(0).allow(null),
  approvedVendor: Joi.boolean(),
});

const bomLineSchema = Joi.object({
  materialId: Joi.string().allow(''),
  materialName: Joi.string().allow(''),
  quantity: Joi.number().min(0),
  unit: Joi.string().allow(''),
  category: Joi.string().allow(''),
  notes: Joi.string().allow(''),
});

const accessorySchema = Joi.object({
  accessoryType: Joi.string().allow(''),
  materialId: Joi.string().allow(''),
  color: Joi.string().allow(''),
  size: Joi.string().allow(''),
  supplierName: Joi.string().allow(''),
  consumption: Joi.number().min(0),
  unit: Joi.string().allow(''),
  unitCost: Joi.number().min(0),
  approved: Joi.boolean(),
});

const fabricSpecsSchema = Joi.object({
  fabricGsm: Joi.number().min(0).allow(null),
  fabricWidth: Joi.string().allow(''),
  fabricFinish: Joi.string().allow(''),
  shrinkagePercent: Joi.number().min(0).allow(null),
});

const qualityNotesSchema = Joi.object({
  allowedDefects: Joi.string().allow(''),
  colorTolerance: Joi.string().allow(''),
  shrinkagePercent: Joi.number().min(0).allow(null),
  measurementTolerance: Joi.string().allow(''),
  checklist: Joi.array().items(Joi.object({
    item: Joi.string().allow(''),
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

const costingSchema = Joi.object({
  fabricCost: Joi.number().min(0),
  accessoriesCost: Joi.number().min(0),
  printingCost: Joi.number().min(0),
  embroideryCost: Joi.number().min(0),
  laborCost: Joi.number().min(0),
  packingCost: Joi.number().min(0),
  overhead: Joi.number().min(0),
  actualCost: Joi.number().min(0),
});

const productionInfoSchema = Joi.object({
  sampleRequired: Joi.boolean(),
  sampleDeadline: Joi.string().allow('', null),
  expectedProductionQty: Joi.number().min(0).allow(null),
  productionPriority: Joi.string().allow(''),
  remarks: Joi.string().allow(''),
});

export const assignSchema = Joi.object({
  body: Joi.object({
    designId: Joi.string().required(),
    patternMasterId: Joi.string().required(),
  }),
});

export const updateSchema = Joi.object({
  body: Joi.object({
    marker: markerSchema,
    patternNotes: Joi.string().allow(''),
    grading: gradingSchema,
    calculatedConsumption: calculatedConsumptionSchema,
    sizeChartData: sizeChartDataSchema,
    fabricConsumption: Joi.array().items(fabricConsumptionSchema),
    bomLines: Joi.array().items(bomLineSchema),
    accessories: Joi.array().items(accessorySchema),
    fabricSpecs: fabricSpecsSchema,
    qualityNotes: qualityNotesSchema,
    manufacturingNotes: manufacturingNotesSchema,
    costing: costingSchema,
    productionInfo: productionInfoSchema,
    sizeChartVerified: Joi.boolean(),
    consumptionVerified: Joi.boolean(),
    sampleBomVerified: Joi.boolean(),
  }).min(1),
});

export const markerUploadSchema = Joi.object({
  body: Joi.object({
    fileName: Joi.string().required(),
    mimeType: Joi.string().required(),
    contentBase64: Joi.string().required(),
  }),
});

export const reopenForFitSchema = Joi.object({
  body: Joi.object({
    sampleId: Joi.string().required(),
    reason: Joi.string().trim().min(3).required(),
  }),
});

export async function listMasters(req, res, next) {
  try {
    const users = await patternService.listPatternMasters({
      factoryId: req.factoryId,
      organizationId: req.organizationId,
    });
    success(res, users);
  } catch (e) { next(e); }
}

export async function assign(req, res, next) {
  try {
    const pd = await patternService.assignPatternMaster({
      designId: req.body.designId,
      factoryId: req.factoryId,
      patternMasterId: req.body.patternMasterId,
    }, req.user._id);
    success(res, pd, null, 201);
  } catch (e) { next(e); }
}

export async function list(req, res, next) {
  try {
    const { page, limit, skip } = paginate(req.query);
    const { items, total } = await patternService.listPatternDevelopments(req.factoryId, {
      status: req.query.status,
      patternMasterId: req.query.patternMasterId,
      search: req.query.search || req.query.q,
      page, limit, skip,
    });
    success(res, items, buildMeta(page, limit, total));
  } catch (e) { next(e); }
}

export async function stats(req, res, next) {
  try {
    success(res, await patternService.getPatternStats(req.factoryId));
  } catch (e) { next(e); }
}

export async function getByDesign(req, res, next) {
  try {
    success(res, await patternService.getPatternDevelopment(req.params.designId, req.factoryId));
  } catch (e) { next(e); }
}

export async function evidence(req, res, next) {
  try {
    success(res, await patternService.getDesignVerificationEvidence(req.params.designId, req.factoryId));
  } catch (e) { next(e); }
}

export async function techPack(req, res, next) {
  try {
    success(res, await patternService.getTechPackForPattern(req.params.designId, req.factoryId));
  } catch (e) { next(e); }
}

export async function materialOptions(req, res, next) {
  try {
    const { listMaterialOptions } = await import('../design/design.service.js');
    success(res, await listMaterialOptions(req.factoryId));
  } catch (e) { next(e); }
}

const superAdminFlag = (req) => ({ isSuperAdmin: !!req.user?.isSuperAdmin });

export async function uploadMarker(req, res, next) {
  try {
    success(res, await patternService.uploadPatternMarker(
      req.params.designId,
      req.factoryId,
      req.body,
      req.user._id,
      superAdminFlag(req),
    ));
  } catch (e) { next(e); }
}

export async function update(req, res, next) {
  try {
    success(res, await patternService.updatePatternDevelopment(
      req.params.designId,
      req.factoryId,
      req.body,
      req.user._id,
      superAdminFlag(req),
    ));
  } catch (e) { next(e); }
}

export async function complete(req, res, next) {
  try {
    success(res, await patternService.completePatternDevelopment(
      req.params.designId,
      req.factoryId,
      req.user._id,
      superAdminFlag(req),
    ));
  } catch (e) { next(e); }
}

export async function reopen(req, res, next) {
  try {
    success(res, await patternService.reopenPatternDevelopment(
      req.params.designId,
      req.factoryId,
      req.user._id,
      { reason: req.body?.reason },
    ));
  } catch (e) { next(e); }
}

export async function reopenForFit(req, res, next) {
  try {
    success(res, await patternService.reopenPatternForFit(
      req.params.designId,
      req.factoryId,
      req.user._id,
      req.body,
    ));
  } catch (e) { next(e); }
}

export function catalog(_req, res) {
  success(res, {
    statuses: PATTERN_STATUS_LIST,
    workflowSteps: PATTERN_WORKFLOW_STEPS,
    fitEvaluationModes: FIT_EVALUATION_MODES,
    fitIssueAreas: FIT_ISSUE_AREAS,
    fitIssueSeverities: FIT_ISSUE_SEVERITIES,
    fitOverallResults: FIT_OVERALL_RESULTS,
  });
}
