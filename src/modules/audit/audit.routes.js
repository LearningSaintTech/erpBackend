import { Router } from 'express';
import { authMiddleware } from '../../middleware/auth.js';
import { rbac } from '../../middleware/rbac.js';
import { AuditLog } from './audit.model.js';
import { success, paginate, buildMeta } from '../../shared/utils/response.js';

const router = Router();

router.use(authMiddleware);

router.get('/audit-logs', rbac('audit.read'), async (req, res, next) => {
  try {
    const { page, limit, skip } = paginate(req.query);
    const filter = {};
    if (req.user.organizationId) filter.organizationId = req.user.organizationId;
    if (req.query.module) filter.module = req.query.module;
    if (req.query.factoryId) filter.factoryId = req.query.factoryId;
    if (req.query.action) filter.action = new RegExp(req.query.action, 'i');
    if (req.query.userEmail) filter.userEmail = new RegExp(req.query.userEmail, 'i');
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
