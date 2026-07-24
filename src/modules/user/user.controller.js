import Joi from 'joi';
import * as userService from './user.service.js';
import { success, paginate, buildMeta } from '../../shared/utils/response.js';
import { ALL_PERMISSION_CODES } from '../../config/systemRoles.js';
import { resolveOrganizationId } from './userContext.js';
import { validatePermissionCodes } from './permissionUtils.js';

export const createUserSchema = Joi.object({
  body: Joi.object({
    email: Joi.string().email({ tlds: { allow: false } }).required(),
    password: Joi.string().min(8).required(),
    firstName: Joi.string().required(),
    lastName: Joi.string().required(),
    phone: Joi.string().allow(''),
    employeeId: Joi.string(),
    organizationId: Joi.string().required(),
  }),
});

export const assignRoleSchema = Joi.object({
  body: Joi.object({
    roleId: Joi.string().required(),
    factoryId: Joi.string().required(),
    organizationId: Joi.string().required(),
    expiresAt: Joi.date().iso().optional(),
  }),
});

export const updateUserSchema = Joi.object({
  body: Joi.object({
    firstName: Joi.string(),
    lastName: Joi.string(),
    phone: Joi.string().allow(''),
    status: Joi.string().valid('ACTIVE', 'INACTIVE', 'LOCKED'),
  }).min(1),
});

export const createRoleSchema = Joi.object({
  body: Joi.object({
    code: Joi.string().required(),
    name: Joi.string().required(),
    permissions: Joi.array().items(Joi.string()).min(1).required(),
  }),
});

export const updateRoleSchema = Joi.object({
  body: Joi.object({
    name: Joi.string(),
    permissions: Joi.array().items(Joi.string()).min(1),
  }).min(1),
});

export const resetPasswordSchema = Joi.object({
  body: Joi.object({
    newPassword: Joi.string().min(8).required(),
  }),
});

export const changePasswordSchema = Joi.object({
  body: Joi.object({
    currentPassword: Joi.string().required(),
    newPassword: Joi.string().min(8).required(),
  }),
});

export const createDelegationSchema = Joi.object({
  body: Joi.object({
    delegateId: Joi.string().required(),
    permissions: Joi.array().items(Joi.string()).min(1).required(),
    startDate: Joi.date().iso().required(),
    endDate: Joi.date().iso().greater(Joi.ref('startDate')).required(),
  }),
});

export async function createUser(req, res, next) {
  try {
    const orgId = resolveOrganizationId(req, { fromBody: true });
    const user = await userService.createUser(
      { ...req.body, organizationId: orgId },
      req.user._id,
      req.user.email,
    );
    return success(res, user, null, 201);
  } catch (err) {
    next(err);
  }
}

export async function listUsers(req, res, next) {
  try {
    const orgId = resolveOrganizationId(req);
    const { page, limit, skip } = paginate(req.query);
    const { items, total } = await userService.listUsers(orgId, {
      page,
      limit,
      skip,
      status: req.query.status,
      search: req.query.search,
    });
    return success(res, items, buildMeta(page, limit, total));
  } catch (err) {
    next(err);
  }
}

export async function getUser(req, res, next) {
  try {
    const orgId = resolveOrganizationId(req);
    const user = await userService.getUser(req.params.id, orgId);
    return success(res, user);
  } catch (err) {
    next(err);
  }
}

export async function updateUser(req, res, next) {
  try {
    const orgId = resolveOrganizationId(req);
    const user = await userService.updateUser(
      req.params.id, orgId, req.body, req.user._id, req.user.email,
    );
    return success(res, user);
  } catch (err) {
    next(err);
  }
}

export async function deleteUser(req, res, next) {
  try {
    const orgId = resolveOrganizationId(req);
    const result = await userService.deleteUser(
      req.params.id, orgId, req.user._id, req.user.email,
    );
    return success(res, result);
  } catch (err) {
    next(err);
  }
}

export async function resetPassword(req, res, next) {
  try {
    const orgId = resolveOrganizationId(req);
    const result = await userService.resetPassword(
      req.params.id, orgId, req.body.newPassword, req.user._id, req.user.email,
    );
    return success(res, result);
  } catch (err) {
    next(err);
  }
}

export async function unlockUser(req, res, next) {
  try {
    const orgId = resolveOrganizationId(req);
    const user = await userService.unlockUser(
      req.params.id, orgId, req.user._id, req.user.email,
    );
    return success(res, user);
  } catch (err) {
    next(err);
  }
}

export async function changePassword(req, res, next) {
  try {
    const result = await userService.changePassword(
      req.user._id, req.body.currentPassword, req.body.newPassword,
    );
    return success(res, result);
  } catch (err) {
    next(err);
  }
}

export async function assignRole(req, res, next) {
  try {
    const orgId = resolveOrganizationId(req, { fromBody: true });
    const assignment = await userService.assignRole({
      userId: req.params.id,
      roleId: req.body.roleId,
      factoryId: req.body.factoryId,
      organizationId: orgId,
      assignedBy: req.user._id,
      expiresAt: req.body.expiresAt,
      actorEmail: req.user.email,
    });
    return success(res, assignment, null, 201);
  } catch (err) {
    next(err);
  }
}

export async function listUserAssignments(req, res, next) {
  try {
    const orgId = resolveOrganizationId(req);
    const items = await userService.listUserAssignments(req.params.id, orgId);
    return success(res, items);
  } catch (err) {
    next(err);
  }
}

export async function listUserDelegations(req, res, next) {
  try {
    const del = await import('./delegation.service.js');
    const orgId = resolveOrganizationId(req);
    const items = await del.listDelegations(req.factoryId, req.params.id, orgId);
    return success(res, items);
  } catch (err) {
    next(err);
  }
}

export async function revokeAssignment(req, res, next) {
  try {
    const orgId = resolveOrganizationId(req);
    const result = await userService.revokeAssignment(
      req.params.assignmentId, orgId, req.user._id, req.user.email,
    );
    return success(res, result);
  } catch (err) {
    next(err);
  }
}

export async function listRoles(req, res, next) {
  try {
    const orgId = resolveOrganizationId(req);
    const roles = await userService.listRoles(orgId);
    return success(res, roles);
  } catch (err) {
    next(err);
  }
}

export async function getRole(req, res, next) {
  try {
    const orgId = resolveOrganizationId(req);
    const role = await userService.getRole(req.params.id, orgId);
    return success(res, role);
  } catch (err) {
    next(err);
  }
}

export async function createRole(req, res, next) {
  try {
    const orgId = resolveOrganizationId(req);
    validatePermissionCodes(req.body.permissions);
    const role = await userService.createRole(
      { ...req.body, organizationId: orgId },
      req.user._id,
      req.user.email,
    );
    return success(res, role, null, 201);
  } catch (err) {
    next(err);
  }
}

export async function updateRole(req, res, next) {
  try {
    const orgId = resolveOrganizationId(req);
    const role = await userService.updateRole(
      req.params.id, orgId, req.body, req.user._id, req.user.email,
    );
    return success(res, role);
  } catch (err) {
    next(err);
  }
}

export async function deleteRole(req, res, next) {
  try {
    const orgId = resolveOrganizationId(req);
    const result = await userService.deleteRole(
      req.params.id, orgId, req.user._id, req.user.email,
    );
    return success(res, result);
  } catch (err) {
    next(err);
  }
}

export async function listRoleMembers(req, res, next) {
  try {
    const orgId = resolveOrganizationId(req);
    const members = await userService.listRoleMembers(req.params.id, orgId);
    return success(res, members);
  } catch (err) {
    next(err);
  }
}

export async function listPermissions(req, res, next) {
  try {
    return success(res, ALL_PERMISSION_CODES);
  } catch (err) {
    next(err);
  }
}

export async function myPermissions(req, res, next) {
  try {
    if (req.user.isSuperAdmin) return success(res, { permissions: ['*'] });
    const permissions = await userService.getUserPermissions(req.user._id, req.factoryId);
    return success(res, { permissions });
  } catch (err) {
    next(err);
  }
}
