import { ValidationError, ForbiddenError } from '../../shared/errors/AppError.js';

/**
 * Resolve organization scope for the current request.
 * Super admins must pass organizationId via query/body; regular users are pinned to their org.
 */
export function resolveOrganizationId(req, { required = true, fromBody = false } = {}) {
  if (req.user.isSuperAdmin) {
    const orgId =
      (fromBody ? req.body?.organizationId : null) ||
      req.query.organizationId ||
      req.body?.organizationId;
    if (!orgId && required) {
      throw new ValidationError('organizationId is required for super admin operations');
    }
    return orgId;
  }

  if (!req.user.organizationId) {
    throw new ForbiddenError('Organization context required');
  }

  const requested = req.query.organizationId || req.body?.organizationId;
  if (requested && requested.toString() !== req.user.organizationId.toString()) {
    throw new ForbiddenError('Cross-organization access denied');
  }

  return req.user.organizationId;
}
