import Joi from 'joi';
import * as sampleService from './sample.service.js';
import { success, paginate, buildMeta } from '../../shared/utils/response.js';
import {
  SAMPLE_STATUS_LIST, SAMPLE_TYPE_LIST, SAMPLE_WORKFLOW_PHASES,
} from './sample.defaults.js';

const superAdminFlag = (req) => ({ isSuperAdmin: !!req.user?.isSuperAdmin });

const materialLineSchema = Joi.object({
  materialId: Joi.string().required(),
  requiredQty: Joi.number().min(0).required(),
  unit: Joi.string().trim().required(),
  unitCost: Joi.number().min(0),
});

export const createSchema = Joi.object({
  body: Joi.object({
    designId: Joi.string().required(),
    laborHours: Joi.number().min(0),
    laborRate: Joi.number().min(0),
    sampleType: Joi.string().valid(...SAMPLE_TYPE_LIST),
    comments: Joi.string().allow(''),
  }),
});

export const updateMaterialsSchema = Joi.object({
  body: Joi.object({
    materialRequirements: Joi.array().items(materialLineSchema).min(1).required(),
    laborHours: Joi.number().min(0),
    laborRate: Joi.number().min(0),
    comments: Joi.string().allow(''),
  }),
});

const fitIssueSchema = Joi.object({
  area: Joi.string().required(),
  severity: Joi.string().valid('MINOR', 'MAJOR', 'CRITICAL'),
  description: Joi.string().allow(''),
});

const qcMeasurementSchema = Joi.object({
  point: Joi.string().required(),
  required: Joi.string().allow(''),
  actual: Joi.string().allow(''),
  tolerance: Joi.string().allow(''),
  pass: Joi.boolean(),
});

const fitAnalysisSchema = Joi.object({
  evaluatedOn: Joi.string().valid('MANNEQUIN', 'LIVE_MODEL', 'FLAT_MEASURE', 'DRESS_FORM', 'CUSTOMER_REP'),
  overallResult: Joi.string().valid('PASS', 'MINOR_ISSUES', 'MAJOR_ISSUES', 'FAIL'),
  issues: Joi.array().items(fitIssueSchema),
  patternRevisionRequired: Joi.boolean(),
  notes: Joi.string().allow(''),
});

export const optionalCommentSchema = Joi.object({
  body: Joi.object({
    comments: Joi.string().allow(''),
    fitAnalysis: fitAnalysisSchema,
    qcMeasurements: Joi.array().items(qcMeasurementSchema),
  }),
});

export const commentSchema = Joi.object({
  body: Joi.object({
    comments: Joi.string().trim().min(3).required(),
    fitAnalysis: fitAnalysisSchema,
    qcMeasurements: Joi.array().items(qcMeasurementSchema),
  }),
});

export async function catalog(req, res, next) {
  try {
    success(res, {
      statuses: SAMPLE_STATUS_LIST,
      sampleTypes: SAMPLE_TYPE_LIST,
      workflowPhases: SAMPLE_WORKFLOW_PHASES,
    });
  } catch (e) { next(e); }
}

export async function materialOptions(req, res, next) {
  try {
    success(res, await sampleService.listMaterialOptions(req.factoryId));
  } catch (e) { next(e); }
}

export async function stats(req, res, next) {
  try {
    success(res, await sampleService.getSampleStats(req.factoryId, {
      patternMasterId: req.query.patternMasterId,
    }));
  } catch (e) { next(e); }
}

export async function eligibleDesigns(req, res, next) {
  try {
    success(res, await sampleService.listEligibleDesigns(req.factoryId));
  } catch (e) { next(e); }
}

export async function create(req, res, next) {
  try {
    const sample = await sampleService.createSample({
      ...req.body,
      factoryId: req.factoryId,
      organizationId: req.user.organizationId,
    }, req.user._id);
    success(res, sample, null, 201);
  } catch (e) { next(e); }
}

export async function list(req, res, next) {
  try {
    const { page, limit, skip } = paginate(req.query);
    const { items, total } = await sampleService.listSamples(req.factoryId, {
      status: req.query.status,
      sampleType: req.query.sampleType,
      designId: req.query.designId,
      search: req.query.search || req.query.q,
      excludeTerminal: req.query.excludeTerminal === 'true',
      patternMasterId: req.query.patternMasterId,
      page, limit, skip,
    });
    success(res, items, buildMeta(page, limit, total));
  } catch (e) { next(e); }
}

export async function get(req, res, next) {
  try {
    success(res, await sampleService.getSample(req.params.id, req.factoryId));
  } catch (e) { next(e); }
}

export async function updateMaterials(req, res, next) {
  try {
    success(res, await sampleService.updateSampleMaterials(
      req.params.id,
      req.factoryId,
      req.body,
      req.user._id,
      superAdminFlag(req),
    ));
  } catch (e) { next(e); }
}

export async function refreshMaterials(req, res, next) {
  try {
    success(res, await sampleService.refreshMaterialsFromDesign(
      req.params.id,
      req.factoryId,
      req.user._id,
      superAdminFlag(req),
    ));
  } catch (e) { next(e); }
}

export async function submitMaterialRequest(req, res, next) {
  try {
    success(res, await sampleService.submitMaterialRequest(
      req.params.id,
      req.factoryId,
      req.user._id,
      superAdminFlag(req),
    ));
  } catch (e) { next(e); }
}

export async function approveMaterialRequest(req, res, next) {
  try {
    success(res, await sampleService.approveMaterialRequest(req.params.id, req.factoryId, req.user._id));
  } catch (e) { next(e); }
}

export async function rejectMaterialRequest(req, res, next) {
  try {
    success(res, await sampleService.rejectMaterialRequest(
      req.params.id, req.factoryId, req.user._id, req.body.comments,
    ));
  } catch (e) { next(e); }
}

export async function submitForApproval(req, res, next) {
  try {
    success(res, await sampleService.submitSampleForApproval(
      req.params.id,
      req.factoryId,
      req.user._id,
      superAdminFlag(req),
    ));
  } catch (e) { next(e); }
}

export async function reserveMaterials(req, res, next) {
  try {
    success(res, await sampleService.reserveMaterials(req.params.id, req.factoryId, req.user._id));
  } catch (e) { next(e); }
}

export async function issueMaterials(req, res, next) {
  try {
    success(res, await sampleService.issueMaterials(req.params.id, req.factoryId, req.user._id));
  } catch (e) { next(e); }
}

export async function completeCutting(req, res, next) {
  try {
    success(res, await sampleService.completeCutting(
      req.params.id,
      req.factoryId,
      req.user._id,
      superAdminFlag(req),
    ));
  } catch (e) { next(e); }
}

export async function complete(req, res, next) {
  try {
    success(res, await sampleService.completeSample(
      req.params.id,
      req.factoryId,
      req.user._id,
      superAdminFlag(req),
    ));
  } catch (e) { next(e); }
}

export async function qcPass(req, res, next) {
  try {
    success(res, await sampleService.passSampleQc(
      req.params.id,
      req.factoryId,
      req.user._id,
      req.body.comments,
      req.body.fitAnalysis,
      req.body.qcMeasurements,
    ));
  } catch (e) { next(e); }
}

export async function qcFail(req, res, next) {
  try {
    success(res, await sampleService.failSampleQc(
      req.params.id,
      req.factoryId,
      req.user._id,
      req.body.comments,
      req.body.fitAnalysis,
      req.body.qcMeasurements,
    ));
  } catch (e) { next(e); }
}

export async function completeFitTrial(req, res, next) {
  try {
    success(res, await sampleService.completeFitTrial(
      req.params.id,
      req.factoryId,
      req.user._id,
      req.body.comments,
      req.body.fitAnalysis,
      superAdminFlag(req),
    ));
  } catch (e) { next(e); }
}

export async function approve(req, res, next) {
  try {
    success(res, await sampleService.approveSample(req.params.id, req.factoryId, req.user._id));
  } catch (e) { next(e); }
}

export async function reject(req, res, next) {
  try {
    success(res, await sampleService.rejectSample(
      req.params.id, req.factoryId, req.user._id, req.body.comments,
    ));
  } catch (e) { next(e); }
}

export async function revision(req, res, next) {
  try {
    success(res, await sampleService.requestSampleRevision(
      req.params.id, req.factoryId, req.user._id, req.body.comments,
    ));
  } catch (e) { next(e); }
}

export async function reopen(req, res, next) {
  try {
    success(res, await sampleService.reopenSampleForRevision(
      req.params.id,
      req.factoryId,
      req.user._id,
      superAdminFlag(req),
    ));
  } catch (e) { next(e); }
}
