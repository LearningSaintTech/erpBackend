import { Router } from 'express';
import { authMiddleware } from '../../middleware/auth.js';
import { tenantMiddleware, requireFactory } from '../../middleware/tenant.js';
import { rbac } from '../../middleware/rbac.js';
import { validate } from '../../middleware/errorHandler.js';
import * as ctrl from './notification.controller.js';

const router = Router();
router.use(authMiddleware, tenantMiddleware, requireFactory);

router.get('/notifications/catalog', rbac('notification.read'), ctrl.catalog);
router.get('/notifications/stats', rbac('notification.read'), ctrl.stats);
router.get('/notifications/recent', rbac('notification.read'), ctrl.recent);
router.get('/notifications/unread-count', rbac('notification.read'), ctrl.unreadCount);
router.get('/notifications', rbac('notification.read'), validate(ctrl.listSchema), ctrl.list);
router.patch('/notifications/read-all', rbac('notification.read'), ctrl.markAllRead);
router.patch('/notifications/:id/read', rbac('notification.read'), ctrl.markRead);

export default router;
