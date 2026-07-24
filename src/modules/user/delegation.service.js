import { Delegation } from './delegation.model.js';
import { User } from './user.model.js';
import {
  NotFoundError, ValidationError, ForbiddenError,
} from '../../shared/errors/AppError.js';
import { applySoftDeleteFilter } from '../../shared/utils/schema.js';
import { validatePermissionCodes } from './permissionUtils.js';
import { getUserPermissions } from './user.service.js';
import { logRbacEvent } from './rbacAudit.js';

export async function createDelegation(data, userId, actorEmail) {
  if (data.delegatorId.toString() === data.delegateId) {
    throw new ValidationError('Cannot delegate to yourself');
  }

  validatePermissionCodes(data.permissions);

  const delegate = await User.findOne({
    _id: data.delegateId,
    organizationId: data.organizationId,
    isDeleted: false,
    status: 'ACTIVE',
  });
  if (!delegate) throw new NotFoundError('Delegate user not found');

  const delegatorPerms = await getUserPermissions(data.delegatorId, data.factoryId);
  const invalid = data.permissions.filter((p) => !delegatorPerms.includes(p));
  if (invalid.length) {
    throw new ForbiddenError(`Cannot delegate permissions you do not hold: ${invalid.join(', ')}`);
  }

  const delegation = await Delegation.create({ ...data, createdBy: userId, updatedBy: userId });

  await logRbacEvent({
    organizationId: data.organizationId,
    factoryId: data.factoryId,
    userId,
    userEmail: actorEmail,
    action: 'delegation.create',
    targetType: 'delegation',
    targetId: delegation._id,
    metadata: { delegateId: data.delegateId, permissions: data.permissions },
  });

  return delegation;
}

export async function listDelegations(factoryId, userId, organizationId) {
  return Delegation.find({
    factoryId,
    organizationId,
    $or: [{ delegatorId: userId }, { delegateId: userId }],
    status: 'ACTIVE',
    isDeleted: false,
  }).populate('delegatorId', 'firstName lastName email')
    .populate('delegateId', 'firstName lastName email')
    .sort({ createdAt: -1 });
}

export async function revokeDelegation(id, userId, organizationId, actorEmail) {
  const d = await Delegation.findOne(applySoftDeleteFilter({ _id: id, organizationId }));
  if (!d) throw new NotFoundError('Delegation not found');

  const isDelegator = d.delegatorId.toString() === userId.toString();
  if (!isDelegator) {
    const perms = await getUserPermissions(userId, d.factoryId);
    if (!perms.includes('user.update')) {
      throw new ForbiddenError('Only the delegator or an admin can revoke this delegation');
    }
  }

  d.status = 'REVOKED';
  d.updatedBy = userId;
  await d.save();

  await logRbacEvent({
    organizationId,
    factoryId: d.factoryId,
    userId,
    userEmail: actorEmail,
    action: 'delegation.revoke',
    targetType: 'delegation',
    targetId: d._id,
  });

  return d;
}
