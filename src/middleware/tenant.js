import mongoose from 'mongoose';
import { BadRequestError, ForbiddenError } from '../shared/errors/AppError.js';
import { UserRoleAssignment } from '../modules/user/userRoleAssignment.model.js';
import { Factory } from '../modules/organization/factory.model.js';

export async function tenantMiddleware(req, res, next) {
  try {
    if (!req.user) return next();

    // Only accept a plain ObjectId string — `?factoryId[$ne]=...` would otherwise become a Mongo operator.
    const raw = req.headers['x-factory-id'] || req.query.factoryId;
    const factoryId = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
    if (raw && !factoryId) throw new BadRequestError('Invalid factory id');
    if (factoryId && !mongoose.isValidObjectId(factoryId)) throw new BadRequestError('Invalid factory id');
    req.organizationId = req.user.organizationId;

    if (req.user.isSuperAdmin) {
      req.factoryId = factoryId || null;
      // A super admin has no organization of their own: work in the selected factory's org
      // (Users & roles, settings…) unless a request names another one explicitly.
      if (factoryId) {
        const factory = await Factory.findById(factoryId).select('organizationId').lean();
        if (factory?.organizationId) req.organizationId = factory.organizationId;
      }
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
