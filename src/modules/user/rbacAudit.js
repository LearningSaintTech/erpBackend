import { AuditLog } from '../audit/audit.model.js';

export async function logRbacEvent({
  organizationId,
  factoryId,
  userId,
  userEmail,
  action,
  targetType,
  targetId,
  metadata = {},
}) {
  return AuditLog.create({
    organizationId,
    factoryId: factoryId || null,
    userId,
    userEmail,
    module: 'rbac',
    action,
    metadata: { targetType, targetId, ...metadata },
    timestamp: new Date(),
  });
}
