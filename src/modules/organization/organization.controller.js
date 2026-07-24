import Joi from 'joi';
import * as orgService from './organization.service.js';
import { success, paginate, buildMeta } from '../../shared/utils/response.js';

export const createOrgSchema = Joi.object({
  body: Joi.object({
    code: Joi.string().min(3).max(10).required(),
    name: Joi.string().required(),
    legalName: Joi.string(),
    defaultCurrency: Joi.string().default('INR'),
    timezone: Joi.string().default('Asia/Kolkata'),
  }),
});

export const createFactorySchema = Joi.object({
  body: Joi.object({
    code: Joi.string().min(2).max(8).required(),
    name: Joi.string().required(),
    address: Joi.object(),
    contact: Joi.object(),
    capacity: Joi.object(),
  }),
});

export async function createOrganization(req, res, next) {
  try {
    const org = await orgService.createOrganization(req.body, req.user._id);
    return success(res, org, null, 201);
  } catch (err) {
    next(err);
  }
}

export async function listOrganizations(req, res, next) {
  try {
    const { page, limit, skip } = paginate(req.query);
    const { items, total } = await orgService.listOrganizations({ page, limit, skip });
    return success(res, items, buildMeta(page, limit, total));
  } catch (err) {
    next(err);
  }
}

export async function getOrganization(req, res, next) {
  try {
    const org = await orgService.getOrganization(req.params.id);
    return success(res, org);
  } catch (err) {
    next(err);
  }
}

export async function createFactory(req, res, next) {
  try {
    const factory = await orgService.createFactory(req.params.orgId, req.body, req.user._id);
    return success(res, factory, null, 201);
  } catch (err) {
    next(err);
  }
}

export async function listFactories(req, res, next) {
  try {
    const { page, limit, skip } = paginate(req.query);
    const { items, total } = await orgService.listFactories(req.params.orgId, { page, limit, skip });
    return success(res, items, buildMeta(page, limit, total));
  } catch (err) {
    next(err);
  }
}

export async function getFactory(req, res, next) {
  try {
    const factory = await orgService.getFactory(req.params.id);
    return success(res, factory);
  } catch (err) {
    next(err);
  }
}

export async function createFinancialYear(req, res, next) {
  try {
    const fy = await orgService.createFinancialYear(req.params.orgId, req.body);
    return success(res, fy, null, 201);
  } catch (err) {
    next(err);
  }
}

export async function listFinancialYears(req, res, next) {
  try {
    const items = await orgService.listFinancialYears(req.params.orgId);
    return success(res, items);
  } catch (err) {
    next(err);
  }
}
