import { Router } from 'express';
import { authMiddleware } from '../../middleware/auth.js';
import { tenantMiddleware, requireFactory } from '../../middleware/tenant.js';
import { rbac } from '../../middleware/rbac.js';
import { validate } from '../../middleware/errorHandler.js';
import * as ctrl from './chat.controller.js';

const router = Router();
router.use(authMiddleware, tenantMiddleware, requireFactory);

router.get('/chat/catalog', rbac('chat.read'), ctrl.catalog);
router.get('/chat/stats', rbac('chat.read'), ctrl.stats);
router.get('/chat/rooms', rbac('chat.read'), validate(ctrl.listRoomsSchema), ctrl.listRooms);
router.post('/chat/rooms/direct', rbac('chat.send'), validate(ctrl.directRoomSchema), ctrl.createDirectRoom);
router.post('/chat/rooms/group', rbac('chat.group.create'), validate(ctrl.groupRoomSchema), ctrl.createGroupRoom);

router.get('/chat/admin/rooms', rbac('chat.moderate'), validate(ctrl.listRoomsSchema), ctrl.listAdminRooms);
router.get('/chat/admin/rooms/:id/messages', rbac('chat.moderate'), validate(ctrl.listMessagesSchema), ctrl.listAdminMessages);

router.get('/chat/rooms/:id', rbac('chat.read'), ctrl.getRoom);
router.patch('/chat/rooms/:id', rbac('chat.group.manage'), validate(ctrl.updateRoomSchema), ctrl.updateRoom);
router.post('/chat/rooms/:id/members', rbac('chat.group.manage'), validate(ctrl.membersSchema), ctrl.addMembers);
router.delete('/chat/rooms/:id/members/:userId', rbac('chat.group.manage'), ctrl.removeMember);
router.get('/chat/rooms/:id/messages', rbac('chat.read'), validate(ctrl.listMessagesSchema), ctrl.listMessages);
router.post('/chat/rooms/:id/messages', rbac('chat.send'), validate(ctrl.sendMessageSchema), ctrl.sendMessage);
router.patch('/chat/rooms/:id/read', rbac('chat.read'), ctrl.markRead);

export default router;
