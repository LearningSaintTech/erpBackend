import { ForbiddenError } from '../shared/errors/AppError.js';
import { UserRoleAssignment } from '../modules/user/userRoleAssignment.model.js';

export async function tenantMiddleware(req, res, next) {
  try {
    if (!req.user) return next();

    const factoryId = req.headers['x-factory-id'] || req.query.factoryId;
    req.organizationId = req.user.organizationId;

    if (req.user.isSuperAdmin) {
      req.factoryId = factoryId || null;
      return next();
    }

    if (!factoryId) {
      const assignments = await UserRoleAssignment.find({ userId: req.user._id });
      req.accessibleFactoryIds = assignments.map((a) => a.factoryId.toString());
      return next();
    }

    const hasAccess = await UserRoleAssignment.exists({
      userId: req.user._id,
      factoryId,
    });

    if (!hasAccess && !req.user.isSuperAdmin) {
      throw new ForbiddenError('Factory access denied');
    }

    req.factoryId = factoryId;
    next();
  } catch (err) {
    next(err);
  }
}

export function requireFactory(req, res, next) {
  if (!req.factoryId) {
    return next(new ForbiddenError('X-Factory-Id header required'));
  }
  next();
}
