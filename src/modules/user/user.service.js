import crypto from 'crypto';
import { User } from './user.model.js';
import { Role } from './role.model.js';
import { UserRoleAssignment } from './userRoleAssignment.model.js';
import { Delegation } from './delegation.model.js';
import { Session } from '../auth/session.model.js';
import { Factory } from '../organization/factory.model.js';
import {
  UnauthorizedError, NotFoundError, ConflictError, ForbiddenError, BadRequestError,
} from '../../shared/errors/AppError.js';
import { signAccessToken, signRefreshToken } from '../../middleware/auth.js';
import { applySoftDeleteFilter, escapeRegex, pickFields } from '../../shared/utils/schema.js';
import { validatePermissionCodes } from './permissionUtils.js';
import { logRbacEvent } from './rbacAudit.js';
import { getRedis, isRedisReady } from '../../shared/services/redis.service.js';
import { resolveDeviceId } from '../auth/authDevice.util.js';
import { refreshTtlMs, refreshTtlSec } from '../auth/authCookie.util.js';
import { normalizeMobile } from '../auth/appleReviewOtp.util.js';

const now = () => new Date();

function isAssignmentActive(assignment, at = now()) {
  return !assignment.expiresAt || assignment.expiresAt >= at;
}

/** LOCKED with no expiry = locked by an admin (indefinite); with an expiry = auto-lock after failed logins. */
export function isAccountLocked(user, at = new Date()) {
  if (user.status !== 'LOCKED') return false;
  return !user.lockedUntil || user.lockedUntil > at;
}

/** An actor may only grant/revoke a role whose permissions they hold themselves in that factory. */
async function assertCanGrantRole(actor, role, factoryId) {
  if (!actor || actor.isSuperAdmin) return;
  const actorPerms = await getUserPermissions(actor._id, factoryId);
  if (actorPerms.includes('*')) return;
  const missing = (role.permissions || []).filter((p) => !actorPerms.includes(p));
  if (missing.length) {
    throw new ForbiddenError('Cannot grant or revoke a role with permissions you do not hold');
  }
}

function assertNotSuperAdminTarget(user, actor) {
  if (user.isSuperAdmin && !actor?.isSuperAdmin) {
    throw new ForbiddenError('Only a super admin can modify a super admin');
  }
}

async function revokeAllSessions(userId) {
  await Session.updateMany({ userId, isRevoked: false }, { isRevoked: true });
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
  if (isAccountLocked(user, now())) {
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

  return issueAuthSession(user, meta);
}

export async function issueAuthSession(user, meta = {}) {
  if (isAccountLocked(user, now())) throw new UnauthorizedError('Account locked');
  if (user.status === 'LOCKED') user.status = 'ACTIVE'; // expired auto-lock
  user.failedLoginAttempts = 0;
  user.lockedUntil = null;
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
  const deviceId = resolveDeviceId(meta.deviceId, user._id);

  await Session.create({
    userId: user._id,
    refreshTokenHash: hashToken(refreshToken),
    deviceInfo: { ...(meta.deviceInfo || {}), deviceId },
    ipAddress: meta.ipAddress,
    expiresAt: new Date(Date.now() + refreshTtlMs()),
  });

  try {
    if (isRedisReady()) {
      await getRedis().set(
        `refreshtoken:${user._id}:${deviceId}`,
        refreshToken,
        'EX',
        refreshTtlSec(),
      );
    }
  } catch (err) {
    console.warn('[AUTH] Redis refresh store failed:', err.message);
  }

  const safeUser = await User.findById(user._id).select('-passwordHash');
  return { accessToken, refreshToken, user: safeUser, factories, permissions };
}

export async function logout(refreshToken) {
  if (!refreshToken || typeof refreshToken !== 'string') return;
  await Session.updateOne(
    { refreshTokenHash: hashToken(refreshToken), isRevoked: false },
    { isRevoked: true }
  );
}

export async function refreshAccessToken(refreshToken) {
  if (!refreshToken || typeof refreshToken !== 'string') throw new UnauthorizedError('Refresh token required');

  const session = await Session.findOne({
    refreshTokenHash: hashToken(refreshToken),
    isRevoked: false,
    expiresAt: { $gt: now() },
  });
  if (!session) throw new UnauthorizedError('Invalid refresh token');

  const user = await User.findById(session.userId);
  if (!user || user.isDeleted || user.status === 'INACTIVE') throw new UnauthorizedError('User inactive');
  if (isAccountLocked(user, now())) {
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
  const phone = data.phone ? normalizeMobile(data.phone) : undefined;
  if (phone) {
    const existingPhone = await User.findOne({ phone, isDeleted: false });
    if (existingPhone) throw new ConflictError('Phone number already in use');
  }
  const passwordHash = await User.hashPassword(data.password);
  const user = await User.create({
    organizationId: data.organizationId,
    email: data.email.toLowerCase(),
    passwordHash,
    firstName: data.firstName,
    lastName: data.lastName,
    phone,
    countryCode: data.countryCode || '+91',
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
  userId, roleId, factoryId, organizationId, assignedBy, expiresAt, actorEmail, actor,
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

  assertNotSuperAdminTarget(user, actor);
  await assertCanGrantRole(actor, role, factoryId);

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

export async function listUsers(organizationId, { page, limit, skip, status, search, factoryId }) {
  const filter = { organizationId, isDeleted: false };
  if (typeof status === 'string' && status) filter.status = status;
  if (typeof search === 'string' && search.trim()) {
    const re = new RegExp(escapeRegex(search.trim()), 'i');
    filter.$or = [{ email: re }, { firstName: re }, { lastName: re }, { employeeId: re }];
  }
  const [items, total] = await Promise.all([
    User.find(filter).skip(skip).limit(limit).sort({ createdAt: -1 }),
    User.countDocuments(filter),
  ]);

  const userIds = items.map((u) => u._id);
  const assignFilter = { userId: { $in: userIds }, organizationId };
  if (factoryId) assignFilter.factoryId = factoryId;

  const assignments = userIds.length
    ? await UserRoleAssignment.find(assignFilter).populate('roleId', 'code name')
    : [];

  const rolesByUser = new Map();
  for (const a of assignments) {
    if (!isAssignmentActive(a)) continue;
    const uid = String(a.userId);
    if (!rolesByUser.has(uid)) rolesByUser.set(uid, []);
    const role = a.roleId;
    if (role && typeof role === 'object' && role.code) {
      const list = rolesByUser.get(uid);
      if (!list.some((r) => r.code === role.code)) {
        list.push({ code: role.code, name: role.name || role.code });
      }
    }
  }

  return {
    items: items.map((u) => {
      const obj = u.toObject ? u.toObject() : { ...u };
      return { ...obj, roles: rolesByUser.get(String(u._id)) || [] };
    }),
    total,
  };
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

export async function updateUser(id, organizationId, data, updatedBy, actorEmail, actor) {
  const user = await getUser(id, organizationId);
  assertNotSuperAdminTarget(user, actor);
  if (data.firstName) user.firstName = data.firstName;
  if (data.lastName) user.lastName = data.lastName;
  if (data.phone !== undefined) {
    const phone = data.phone ? normalizeMobile(data.phone) : undefined;
    if (phone) {
      const existingPhone = await User.findOne({ phone, isDeleted: false, _id: { $ne: user._id } });
      if (existingPhone) throw new ConflictError('Phone number already in use');
    }
    const previous = user.phone;
    user.phone = phone;
    if (previous !== phone) user.isNumberVerified = false;
  }
  const statusChanged = Boolean(data.status) && data.status !== user.status;
  if (data.status) {
    user.status = data.status;
    // Admin lock is indefinite until explicitly unlocked.
    if (data.status === 'LOCKED') user.lockedUntil = null;
  }
  user.updatedBy = updatedBy;
  await user.save();
  if (statusChanged && data.status !== 'ACTIVE') await revokeAllSessions(user._id);

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
  // Delegations must not outlive the delegator.
  await Delegation.updateMany({ delegatorId: id, status: 'ACTIVE' }, { status: 'REVOKED' });
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

export async function resetPassword(id, organizationId, newPassword, updatedBy, actorEmail, actor) {
  const user = await User.findOne({ _id: id, organizationId, isDeleted: false }).select('+passwordHash');
  if (!user) throw new NotFoundError('User not found');
  assertNotSuperAdminTarget(user, actor);

  user.passwordHash = await User.hashPassword(newPassword);
  user.passwordResetRequired = true;
  user.updatedBy = updatedBy;
  await user.save();
  await revokeAllSessions(user._id);

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

export async function unlockUser(id, organizationId, updatedBy, actorEmail, actor) {
  const user = await getUser(id, organizationId);
  assertNotSuperAdminTarget(user, actor);
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
  // 400, not 401: a wrong current password must not look like an expired session (the SPA signs out on 401).
  if (!valid) throw new BadRequestError('Current password is incorrect');

  user.passwordHash = await User.hashPassword(newPassword);
  user.passwordResetRequired = false;
  await user.save();
  await revokeAllSessions(user._id);

  return { changed: true };
}

export async function createRole(data, createdBy, actorEmail) {
  validatePermissionCodes(data.permissions);
  const role = await Role.create({
    ...pickFields(data, ['code', 'name', 'description', 'permissions']),
    organizationId: data.organizationId,
    isSystem: false,
    isCustom: true,
  });

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

export async function revokeAssignment(assignmentId, organizationId, revokedBy, actorEmail, actor) {
  const assignment = await UserRoleAssignment.findOne({ _id: assignmentId, organizationId }).populate('roleId');
  if (!assignment) throw new NotFoundError('Assignment not found');
  const target = await User.findById(assignment.userId);
  if (target) assertNotSuperAdminTarget(target, actor);
  if (assignment.roleId) await assertCanGrantRole(actor, assignment.roleId, assignment.factoryId);

  const meta = {
    userId: assignment.userId,
    roleId: assignment.roleId?._id || assignment.roleId,
    factoryId: assignment.factoryId,
  };
  await assignment.deleteOne();
  // The delegator may no longer hold what they delegated in that factory.
  await Delegation.updateMany(
    { delegatorId: assignment.userId, factoryId: assignment.factoryId, status: 'ACTIVE' },
    { status: 'REVOKED' },
  );

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
