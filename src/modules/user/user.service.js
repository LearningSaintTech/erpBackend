import crypto from 'crypto';
import { User } from './user.model.js';
import { Role } from './role.model.js';
import { UserRoleAssignment } from './userRoleAssignment.model.js';
import { Delegation } from './delegation.model.js';
import { Session } from '../auth/session.model.js';
import { Factory } from '../organization/factory.model.js';
import {
  UnauthorizedError, NotFoundError, ConflictError, ForbiddenError,
} from '../../shared/errors/AppError.js';
import { signAccessToken, signRefreshToken } from '../../middleware/auth.js';
import { applySoftDeleteFilter } from '../../shared/utils/schema.js';
import { validatePermissionCodes } from './permissionUtils.js';
import { logRbacEvent } from './rbacAudit.js';

const now = () => new Date();

function isAssignmentActive(assignment, at = now()) {
  return !assignment.expiresAt || assignment.expiresAt >= at;
}

export async function getUserPermissions(userId, factoryId) {
  const at = now();
  const filter = { userId };
  if (factoryId) filter.factoryId = factoryId;

  const assignments = await UserRoleAssignment.find(filter).populate('roleId');
  const permissions = new Set();
  for (const a of assignments) {
    if (!isAssignmentActive(a, at)) continue;
    if (a.roleId?.permissions) {
      a.roleId.permissions.forEach((p) => permissions.add(p));
    }
  }

  if (factoryId) {
    const delegations = await Delegation.find({
      delegateId: userId,
      factoryId,
      status: 'ACTIVE',
      isDeleted: false,
      startDate: { $lte: at },
      endDate: { $gte: at },
    });
    for (const d of delegations) {
      d.permissions?.forEach((p) => permissions.add(p));
    }
  }

  return [...permissions];
}

/** Active factory users whose role (or delegation) includes any of the given permission codes. */
export async function findUserIdsWithFactoryPermission(factoryId, permissionCodes, { excludeUserId } = {}) {
  const codes = Array.isArray(permissionCodes) ? permissionCodes : [permissionCodes];
  const at = now();
  const assignments = await UserRoleAssignment.find({ factoryId })
    .populate('roleId')
    .populate('userId', 'status');

  const userIds = new Set();
  for (const a of assignments) {
    if (!isAssignmentActive(a, at)) continue;
    const uid = a.userId?._id || a.userId;
    if (!uid || a.userId?.status === 'INACTIVE') continue;
    if (excludeUserId && uid.toString() === excludeUserId.toString()) continue;
    const perms = a.roleId?.permissions || [];
    if (perms.includes('*') || codes.some((c) => perms.includes(c))) {
      userIds.add(uid.toString());
    }
  }

  const delegations = await Delegation.find({
    factoryId,
    status: 'ACTIVE',
    isDeleted: false,
    startDate: { $lte: at },
    endDate: { $gte: at },
  });
  for (const d of delegations) {
    const uid = d.delegateId?.toString();
    if (!uid || (excludeUserId && uid === excludeUserId.toString())) continue;
    if (d.permissions?.includes('*') || codes.some((c) => d.permissions?.includes(c))) {
      userIds.add(uid);
    }
  }

  return [...userIds];
}

export async function getUserFactories(userId) {
  const assignments = await UserRoleAssignment.find({ userId }).populate('factoryId', 'name code');
  const map = new Map();
  for (const a of assignments) {
    if (a.factoryId) {
      map.set(a.factoryId._id.toString(), {
        _id: a.factoryId._id,
        name: a.factoryId.name,
        code: a.factoryId.code,
      });
    }
  }
  return [...map.values()];
}

export async function getSuperAdminFactories() {
  return Factory.find(applySoftDeleteFilter({}))
    .select('name code organizationId')
    .sort({ code: 1 });
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function permissionsForLogin(user, factories) {
  if (user.isSuperAdmin) return ['*'];
  const defaultFactoryId = factories[0]?._id;
  return getUserPermissions(user._id, defaultFactoryId);
}

export async function login(email, password, meta = {}) {
  const user = await User.findOne({ email: email.toLowerCase() }).select('+passwordHash');
  if (!user) throw new UnauthorizedError('Invalid credentials');

  if (user.status === 'INACTIVE') throw new UnauthorizedError('Account inactive');
  if (user.status === 'LOCKED' && user.lockedUntil && user.lockedUntil > now()) {
    throw new UnauthorizedError('Account locked. Try again later.');
  }

  const valid = await user.comparePassword(password);
  if (!valid) {
    user.failedLoginAttempts = (user.failedLoginAttempts || 0) + 1;
    if (user.failedLoginAttempts >= 5) {
      user.lockedUntil = new Date(Date.now() + 15 * 60 * 1000);
      user.status = 'LOCKED';
    }
    await user.save();
    throw new UnauthorizedError('Invalid credentials');
  }

  user.failedLoginAttempts = 0;
  user.lockedUntil = null;
  if (user.status === 'LOCKED') user.status = 'ACTIVE';
  user.lastLoginAt = now();
  await user.save();

  const factories = user.isSuperAdmin
    ? await getSuperAdminFactories()
    : await getUserFactories(user._id);
  const permissions = await permissionsForLogin(user, factories);

  const payload = {
    sub: user._id.toString(),
    org: user.organizationId?.toString(),
    isSuperAdmin: user.isSuperAdmin,
  };

  const accessToken = signAccessToken(payload);
  const refreshToken = signRefreshToken({ sub: user._id.toString(), type: 'refresh' });

  await Session.create({
    userId: user._id,
    refreshTokenHash: hashToken(refreshToken),
    deviceInfo: meta.deviceInfo,
    ipAddress: meta.ipAddress,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });

  const safeUser = await User.findById(user._id).select('-passwordHash');
  return { accessToken, refreshToken, user: safeUser, factories, permissions };
}

export async function logout(refreshToken) {
  if (!refreshToken) return;
  await Session.updateOne(
    { refreshTokenHash: hashToken(refreshToken), isRevoked: false },
    { isRevoked: true }
  );
}

export async function refreshAccessToken(refreshToken) {
  if (!refreshToken) throw new UnauthorizedError('Refresh token required');

  const session = await Session.findOne({
    refreshTokenHash: hashToken(refreshToken),
    isRevoked: false,
    expiresAt: { $gt: now() },
  });
  if (!session) throw new UnauthorizedError('Invalid refresh token');

  const user = await User.findById(session.userId);
  if (!user || user.status === 'INACTIVE') throw new UnauthorizedError('User inactive');
  if (user.status === 'LOCKED' && user.lockedUntil && user.lockedUntil > now()) {
    throw new UnauthorizedError('Account locked');
  }

  const payload = {
    sub: user._id.toString(),
    org: user.organizationId?.toString(),
    isSuperAdmin: user.isSuperAdmin,
  };

  const accessToken = signAccessToken(payload);
  const factories = user.isSuperAdmin
    ? await getSuperAdminFactories()
    : await getUserFactories(user._id);
  const permissions = await permissionsForLogin(user, factories);

  return { accessToken, user, factories, permissions };
}

export async function createUser(data, createdBy, actorEmail) {
  const passwordHash = await User.hashPassword(data.password);
  const user = await User.create({
    organizationId: data.organizationId,
    email: data.email.toLowerCase(),
    passwordHash,
    firstName: data.firstName,
    lastName: data.lastName,
    phone: data.phone,
    employeeId: data.employeeId,
    createdBy,
  });

  await logRbacEvent({
    organizationId: data.organizationId,
    userId: createdBy,
    userEmail: actorEmail,
    action: 'user.create',
    targetType: 'user',
    targetId: user._id,
    metadata: { email: user.email },
  });

  return user;
}

export async function assignRole({
  userId, roleId, factoryId, organizationId, assignedBy, expiresAt, actorEmail,
}) {
  const user = await User.findOne({ _id: userId, organizationId, isDeleted: false });
  if (!user) throw new NotFoundError('User not found');

  const role = await Role.findOne({
    _id: roleId,
    $or: [{ organizationId: null, isSystem: true }, { organizationId }],
  });
  if (!role) throw new NotFoundError('Role not found');

  const factory = await Factory.findOne({ _id: factoryId, organizationId, isDeleted: false });
  if (!factory) throw new NotFoundError('Factory not found');

  const assignment = await UserRoleAssignment.findOneAndUpdate(
    { userId, roleId, factoryId },
    { organizationId, assignedBy, assignedAt: now(), expiresAt: expiresAt || null },
    { upsert: true, new: true }
  );

  await logRbacEvent({
    organizationId,
    factoryId,
    userId: assignedBy,
    userEmail: actorEmail,
    action: 'role.assign',
    targetType: 'user',
    targetId: userId,
    metadata: { roleId, roleCode: role.code, factoryId },
  });

  return assignment;
}

export async function listUsers(organizationId, { page, limit, skip, status, search }) {
  const filter = { organizationId, isDeleted: false };
  if (status) filter.status = status;
  if (search?.trim()) {
    const re = new RegExp(search.trim(), 'i');
    filter.$or = [{ email: re }, { firstName: re }, { lastName: re }, { employeeId: re }];
  }
  const [items, total] = await Promise.all([
    User.find(filter).skip(skip).limit(limit).sort({ createdAt: -1 }),
    User.countDocuments(filter),
  ]);
  return { items, total };
}

export async function listUserAssignments(userId, organizationId) {
  return UserRoleAssignment.find({ userId, organizationId })
    .populate('roleId', 'code name permissions isSystem')
    .populate('factoryId', 'code name')
    .sort({ assignedAt: -1 });
}

export async function listRoles(organizationId) {
  return Role.find({
    $or: [{ organizationId: null, isSystem: true }, { organizationId }],
  });
}

export async function getUser(id, organizationId) {
  const user = await User.findOne({ _id: id, organizationId, isDeleted: false });
  if (!user) throw new NotFoundError('User not found');
  return user;
}

export async function updateUser(id, organizationId, data, updatedBy, actorEmail) {
  const user = await getUser(id, organizationId);
  if (data.firstName) user.firstName = data.firstName;
  if (data.lastName) user.lastName = data.lastName;
  if (data.phone !== undefined) user.phone = data.phone;
  if (data.status) user.status = data.status;
  user.updatedBy = updatedBy;
  await user.save();

  await logRbacEvent({
    organizationId,
    userId: updatedBy,
    userEmail: actorEmail,
    action: 'user.update',
    targetType: 'user',
    targetId: user._id,
    metadata: { fields: Object.keys(data) },
  });

  return user;
}

export async function deleteUser(id, organizationId, deletedBy, actorEmail) {
  const user = await getUser(id, organizationId);
  if (user.isSuperAdmin) throw new ForbiddenError('Cannot delete super admin');

  user.isDeleted = true;
  user.status = 'INACTIVE';
  user.updatedBy = deletedBy;
  await user.save();

  await UserRoleAssignment.deleteMany({ userId: id, organizationId });
  await Session.updateMany({ userId: id, isRevoked: false }, { isRevoked: true });

  await logRbacEvent({
    organizationId,
    userId: deletedBy,
    userEmail: actorEmail,
    action: 'user.delete',
    targetType: 'user',
    targetId: user._id,
    metadata: { email: user.email },
  });

  return { deleted: true };
}

export async function resetPassword(id, organizationId, newPassword, updatedBy, actorEmail) {
  const user = await User.findOne({ _id: id, organizationId, isDeleted: false }).select('+passwordHash');
  if (!user) throw new NotFoundError('User not found');

  user.passwordHash = await User.hashPassword(newPassword);
  user.passwordResetRequired = true;
  user.updatedBy = updatedBy;
  await user.save();

  await logRbacEvent({
    organizationId,
    userId: updatedBy,
    userEmail: actorEmail,
    action: 'user.reset_password',
    targetType: 'user',
    targetId: user._id,
  });

  return { reset: true };
}

export async function unlockUser(id, organizationId, updatedBy, actorEmail) {
  const user = await getUser(id, organizationId);
  user.status = 'ACTIVE';
  user.lockedUntil = null;
  user.failedLoginAttempts = 0;
  user.updatedBy = updatedBy;
  await user.save();

  await logRbacEvent({
    organizationId,
    userId: updatedBy,
    userEmail: actorEmail,
    action: 'user.unlock',
    targetType: 'user',
    targetId: user._id,
  });

  return user;
}

export async function changePassword(userId, currentPassword, newPassword) {
  const user = await User.findById(userId).select('+passwordHash');
  if (!user) throw new NotFoundError('User not found');

  const valid = await user.comparePassword(currentPassword);
  if (!valid) throw new UnauthorizedError('Current password is incorrect');

  user.passwordHash = await User.hashPassword(newPassword);
  user.passwordResetRequired = false;
  await user.save();

  return { changed: true };
}

export async function createRole(data, createdBy, actorEmail) {
  validatePermissionCodes(data.permissions);
  const role = await Role.create({ ...data, isCustom: true });

  await logRbacEvent({
    organizationId: data.organizationId,
    userId: createdBy,
    userEmail: actorEmail,
    action: 'role.create',
    targetType: 'role',
    targetId: role._id,
    metadata: { code: role.code },
  });

  return role;
}

export async function getRole(id, organizationId) {
  const role = await Role.findOne({
    _id: id,
    $or: [{ organizationId: null, isSystem: true }, { organizationId }],
  });
  if (!role) throw new NotFoundError('Role not found');
  return role;
}

export async function updateRole(id, organizationId, { name, permissions }, updatedBy, actorEmail) {
  const role = await getRole(id, organizationId);
  if (role.isSystem) throw new ConflictError('System roles cannot be modified');
  if (name) role.name = name;
  if (permissions) {
    validatePermissionCodes(permissions);
    role.permissions = permissions;
  }
  await role.save();

  await logRbacEvent({
    organizationId,
    userId: updatedBy,
    userEmail: actorEmail,
    action: 'role.update',
    targetType: 'role',
    targetId: role._id,
    metadata: { code: role.code },
  });

  return role;
}

export async function deleteRole(id, organizationId, deletedBy, actorEmail) {
  const role = await getRole(id, organizationId);
  if (role.isSystem) throw new ConflictError('System roles cannot be deleted');

  const assignmentCount = await UserRoleAssignment.countDocuments({ roleId: id, organizationId });
  if (assignmentCount > 0) {
    throw new ConflictError('Role has active assignments. Revoke assignments first.');
  }

  await role.deleteOne();

  await logRbacEvent({
    organizationId,
    userId: deletedBy,
    userEmail: actorEmail,
    action: 'role.delete',
    targetType: 'role',
    targetId: id,
    metadata: { code: role.code },
  });

  return { deleted: true };
}

export async function listRoleMembers(roleId, organizationId) {
  await getRole(roleId, organizationId);
  return UserRoleAssignment.find({ roleId, organizationId })
    .populate('userId', 'firstName lastName email status')
    .populate('factoryId', 'code name')
    .sort({ assignedAt: -1 });
}

export async function revokeAssignment(assignmentId, organizationId, revokedBy, actorEmail) {
  const assignment = await UserRoleAssignment.findOne({ _id: assignmentId, organizationId });
  if (!assignment) throw new NotFoundError('Assignment not found');

  const meta = {
    userId: assignment.userId,
    roleId: assignment.roleId,
    factoryId: assignment.factoryId,
  };
  await assignment.deleteOne();

  await logRbacEvent({
    organizationId,
    factoryId: assignment.factoryId,
    userId: revokedBy,
    userEmail: actorEmail,
    action: 'role.revoke',
    targetType: 'assignment',
    targetId: assignmentId,
    metadata: meta,
  });

  return { removed: true };
}

export async function listPermissions() {
  const { ALL_PERMISSION_CODES } = await import('../../config/systemRoles.js');
  return ALL_PERMISSION_CODES;
}
