import { ForbiddenError } from '../shared/errors/AppError.js';
import { getUserPermissions } from '../modules/user/user.service.js';

export function rbac(...requiredPermissions) {
  return async (req, res, next) => {
    try {
      if (req.user?.isSuperAdmin) {
        req.permissions = ['*'];
        return next();
      }

      const factoryId = req.factoryId || req.headers['x-factory-id'];
      const permissions = await getUserPermissions(req.user._id, factoryId);

      const hasAll = requiredPermissions.every((p) => permissions.includes(p));
      if (!hasAll) {
        throw new ForbiddenError('Insufficient permissions');
      }
      req.permissions = permissions;
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function rbacAny(...requiredPermissions) {
  return async (req, res, next) => {
    try {
      if (req.user?.isSuperAdmin) {
        req.permissions = ['*'];
        return next();
      }

      const factoryId = req.factoryId || req.headers['x-factory-id'];
      const permissions = await getUserPermissions(req.user._id, factoryId);

      const hasOne = requiredPermissions.some((p) => permissions.includes(p));
      if (!hasOne) {
        throw new ForbiddenError('Insufficient permissions');
      }
      req.permissions = permissions;
      next();
    } catch (err) {
      next(err);
    }
  };
}
