import { Router } from 'express';
import { authMiddleware } from '../../middleware/auth.js';
import { rbac } from '../../middleware/rbac.js';
import { AuditLog } from './audit.model.js';
import { success, paginate, buildMeta } from '../../shared/utils/response.js';
import { escapeRegex, queryString } from '../../shared/utils/schema.js';
import { UserRoleAssignment } from '../user/userRoleAssignment.model.js';
import { ForbiddenError } from '../../shared/errors/AppError.js';

const router = Router();

router.use(authMiddleware);

router.get('/audit-logs', rbac('audit.read'), async (req, res, next) => {
  try {
    const { page, limit, skip } = paginate(req.query);
    const filter = {};
    if (req.user.organizationId) filter.organizationId = req.user.organizationId;
    const moduleName = queryString(req.query.module);
    const factoryId = queryString(req.query.factoryId);
    const action = queryString(req.query.action);
    const userEmail = queryString(req.query.userEmail);
    if (moduleName) filter.module = moduleName;
    if (!req.user.isSuperAdmin) {
      // Auditors only see logs for factories they are assigned to.
      const assigned = (await UserRoleAssignment.find({ userId: req.user._id }).distinct('factoryId'))
        .map(String);
      if (factoryId && !assigned.includes(factoryId)) throw new ForbiddenError('Factory access denied');
      filter.factoryId = factoryId || { $in: [...assigned, null] }; // null = org-level events
    } else if (factoryId) {
      filter.factoryId = factoryId;
    }
    if (action) filter.action = new RegExp(escapeRegex(action), 'i');
    if (userEmail) filter.userEmail = new RegExp(escapeRegex(userEmail), 'i');
    if (req.query.from || req.query.to) {
      filter.timestamp = {};
      if (req.query.from) filter.timestamp.$gte = new Date(req.query.from);
      if (req.query.to) {
        const to = new Date(req.query.to);
        to.setHours(23, 59, 59, 999);
        filter.timestamp.$lte = to;
      }
    }

    const [items, total] = await Promise.all([
      AuditLog.find(filter).skip(skip).limit(limit).sort({ timestamp: -1 }),
      AuditLog.countDocuments(filter),
    ]);
    return success(res, items, buildMeta(page, limit, total));
  } catch (err) {
    next(err);
  }
});

router.get('/audit-logs/modules', rbac('audit.read'), async (req, res, next) => {
  try {
    const filter = {};
    if (req.user.organizationId) filter.organizationId = req.user.organizationId;
    const modules = await AuditLog.distinct('module', filter);
    return success(res, modules.filter(Boolean).sort());
  } catch (err) {
    next(err);
  }
});

export default router;
