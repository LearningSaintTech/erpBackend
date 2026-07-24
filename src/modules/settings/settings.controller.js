import Joi from 'joi';
import * as settingsService from './settings.service.js';
import { success } from '../../shared/utils/response.js';
import { resolveOrganizationId } from '../user/userContext.js';
import { FEATURE_FLAG_CATALOG } from './settings.defaults.js';

const shiftSchema = Joi.object({
  name: Joi.string().required(),
  startTime: Joi.string().pattern(/^\d{2}:\d{2}$/).required(),
  endTime: Joi.string().pattern(/^\d{2}:\d{2}$/).required(),
});

export const generalSettingsSchema = Joi.object({
  body: Joi.object({
    timezone: Joi.string(),
    currency: Joi.string().length(3),
    dateFormat: Joi.string(),
    locale: Joi.string(),
    fiscalYearStartMonth: Joi.number().integer().min(1).max(12),
    lowStockAlertDays: Joi.number().integer().min(1).max(90),
    defaultUom: Joi.string(),
  }).min(1),
});

export const integrationsSettingsSchema = Joi.object({
  body: Joi.object({
    email: Joi.object({
      enabled: Joi.boolean(),
      host: Joi.string().allow(''),
      port: Joi.number().integer(),
      secure: Joi.boolean(),
      user: Joi.string().allow(''),
      fromName: Joi.string().allow(''),
      fromEmail: Joi.string().email({ tlds: { allow: false } }).allow(''),
      password: Joi.string().allow(''),
    }),
    sms: Joi.object({
      enabled: Joi.boolean(),
      provider: Joi.string().allow(''),
      apiKey: Joi.string().allow(''),
      senderId: Joi.string().allow(''),
    }),
    webhook: Joi.object({
      enabled: Joi.boolean(),
      url: Joi.string().uri().allow(''),
      secret: Joi.string().allow(''),
      events: Joi.array().items(Joi.string()),
    }),
  }).min(1),
});

export const featureFlagsSchema = Joi.object({
  body: Joi.object().pattern(
    Joi.string().valid(...FEATURE_FLAG_CATALOG.map((f) => f.key)),
    Joi.boolean(),
  ).min(1),
});

export const factorySettingsSchema = Joi.object({
  body: Joi.object({
    shifts: Joi.array().items(shiftSchema),
    workingDays: Joi.array().items(Joi.number().integer().min(0).max(6)),
    productionStages: Joi.array().items(Joi.string().trim().min(1)),
    defaultWarehouses: Joi.object(),
    numberingPrefixes: Joi.object(),
  }).min(1),
});

export async function getGeneral(req, res, next) {
  try {
    const orgId = resolveOrganizationId(req);
    const data = await settingsService.getSettings({
      organizationId: orgId,
      factoryId: null,
      category: 'GENERAL',
    });
    return success(res, data);
  } catch (e) { next(e); }
}

export async function updateGeneral(req, res, next) {
  try {
    const orgId = resolveOrganizationId(req);
    const data = await settingsService.updateSettings({
      organizationId: orgId,
      factoryId: null,
      category: 'GENERAL',
      settings: req.body,
    }, req.user._id);
    return success(res, data);
  } catch (e) { next(e); }
}

export async function getIntegrations(req, res, next) {
  try {
    const orgId = resolveOrganizationId(req);
    const data = await settingsService.getIntegrations(orgId);
    return success(res, data);
  } catch (e) { next(e); }
}

export async function updateIntegrations(req, res, next) {
  try {
    const orgId = resolveOrganizationId(req);
    const data = await settingsService.updateIntegrations(orgId, req.body, req.user._id);
    return success(res, data);
  } catch (e) { next(e); }
}

export async function getFeatureFlags(req, res, next) {
  try {
    const orgId = resolveOrganizationId(req);
    const data = await settingsService.getFeatureFlags(orgId, req.factoryId);
    return success(res, data);
  } catch (e) { next(e); }
}

export async function updateFeatureFlags(req, res, next) {
  try {
    const orgId = resolveOrganizationId(req);
    const data = await settingsService.updateSettings({
      organizationId: orgId,
      factoryId: req.factoryId || null,
      category: 'FEATURE_FLAGS',
      settings: req.body,
    }, req.user._id);
    return success(res, data);
  } catch (e) { next(e); }
}

export async function getFeatureFlagCatalog(req, res, next) {
  try {
    return success(res, FEATURE_FLAG_CATALOG);
  } catch (e) { next(e); }
}

export async function getReadiness(req, res, next) {
  try {
    return success(res, await settingsService.getReadiness());
  } catch (e) { next(e); }
}
