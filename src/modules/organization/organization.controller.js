import Joi from 'joi';
import * as orgService from './organization.service.js';
import { success, paginate, buildMeta } from '../../shared/utils/response.js';
import { ForbiddenError } from '../../shared/errors/AppError.js';
import { pickFields } from '../../shared/utils/schema.js';
import { UserRoleAssignment } from '../user/userRoleAssignment.model.js';

/** Non-super-admins may only touch their own organization. */
export function assertOrgAccess(req, orgId) {
  if (req.user.isSuperAdmin) return;
  if (String(orgId) !== String(req.user.organizationId)) {
    throw new ForbiddenError('Cross-organization access denied');
  }
}

/** Non-super-admins may only touch factories they are assigned to. */
export async function assertFactoryAccess(req, factoryId) {
  if (req.user.isSuperAdmin) return;
  const assigned = await UserRoleAssignment.exists({ userId: req.user._id, factoryId });
  if (!assigned) throw new ForbiddenError('Factory access denied');
}

export const financialYearSchema = Joi.object({
  body: Joi.object({
    name: Joi.string().required(),
    startDate: Joi.date().required(),
    endDate: Joi.date().greater(Joi.ref('startDate')).required(),
    isActive: Joi.boolean(),
  }),
});

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
    const { items, total } = await orgService.listOrganizations({
      page, limit, skip,
      onlyId: req.user.isSuperAdmin ? null : req.user.organizationId,
    });
    return success(res, items, buildMeta(page, limit, total));
  } catch (err) {
    next(err);
  }
}

export async function getOrganization(req, res, next) {
  try {
    assertOrgAccess(req, req.params.id);
    const org = await orgService.getOrganization(req.params.id);
    return success(res, org);
  } catch (err) {
    next(err);
  }
}

export async function createFactory(req, res, next) {
  try {
    assertOrgAccess(req, req.params.orgId);
    const factory = await orgService.createFactory(req.params.orgId, req.body, req.user._id);
    return success(res, factory, null, 201);
  } catch (err) {
    next(err);
  }
}

export async function listFactories(req, res, next) {
  try {
    const { page, limit, skip } = paginate(req.query);
    assertOrgAccess(req, req.params.orgId);
    const { items, total } = await orgService.listFactories(req.params.orgId, { page, limit, skip });
    return success(res, items, buildMeta(page, limit, total));
  } catch (err) {
    next(err);
  }
}

export async function getFactory(req, res, next) {
  try {
    const factory = await orgService.getFactory(req.params.id);
    assertOrgAccess(req, factory.organizationId);
    await assertFactoryAccess(req, factory._id);
    return success(res, factory);
  } catch (err) {
    next(err);
  }
}

export async function createFinancialYear(req, res, next) {
  try {
    assertOrgAccess(req, req.params.orgId);
    const fy = await orgService.createFinancialYear(
      req.params.orgId,
      pickFields(req.body, ['name', 'startDate', 'endDate', 'isActive']),
    );
    return success(res, fy, null, 201);
  } catch (err) {
    next(err);
  }
}

export async function listFinancialYears(req, res, next) {
  try {
    assertOrgAccess(req, req.params.orgId);
    const items = await orgService.listFinancialYears(req.params.orgId);
    return success(res, items);
  } catch (err) {
    next(err);
  }
}
