import { Router } from 'express';
import { validate } from '../../middleware/errorHandler.js';
import { authMiddleware } from '../../middleware/auth.js';
import { tenantMiddleware, requireFactory } from '../../middleware/tenant.js';
import { rbac } from '../../middleware/rbac.js';
import * as ctrl from './user.controller.js';
import * as authCtrl from '../auth/auth.controller.js';

const router = Router();

router.use(authMiddleware);
router.use(tenantMiddleware);

router.get('/users/me', authCtrl.me);
router.get('/users/me/permissions', ctrl.myPermissions);
router.post('/users/me/change-password', validate(ctrl.changePasswordSchema), ctrl.changePassword);

router.post('/users', rbac('user.create'), validate(ctrl.createUserSchema), ctrl.createUser);
router.get('/users', rbac('user.read'), ctrl.listUsers);
router.get('/users/:id', rbac('user.read'), ctrl.getUser);
router.patch('/users/:id', rbac('user.update'), validate(ctrl.updateUserSchema), ctrl.updateUser);
router.delete('/users/:id', rbac('user.delete'), ctrl.deleteUser);
router.post('/users/:id/reset-password', rbac('user.update'), validate(ctrl.resetPasswordSchema), ctrl.resetPassword);
router.post('/users/:id/unlock', rbac('user.update'), ctrl.unlockUser);

router.get('/users/:id/assignments', rbac('user.read'), ctrl.listUserAssignments);
router.get('/users/:id/delegations', rbac('user.read'), requireFactory, ctrl.listUserDelegations);
router.post('/users/:id/roles', rbac('user.update'), validate(ctrl.assignRoleSchema), ctrl.assignRole);
router.delete('/users/:userId/assignments/:assignmentId', rbac('user.update'), ctrl.revokeAssignment);

router.get('/roles', rbac('role.read'), ctrl.listRoles);
router.get('/permissions', rbac('role.read'), ctrl.listPermissions);
router.get('/roles/:id', rbac('role.read'), ctrl.getRole);
router.get('/roles/:id/members', rbac('role.read'), ctrl.listRoleMembers);
router.post('/roles', rbac('role.create'), validate(ctrl.createRoleSchema), ctrl.createRole);
router.patch('/roles/:id', rbac('role.configure'), validate(ctrl.updateRoleSchema), ctrl.updateRole);
router.delete('/roles/:id', rbac('role.configure'), ctrl.deleteRole);

router.post('/delegations', rbac('user.update'), requireFactory, validate(ctrl.createDelegationSchema), async (req, res, next) => {
  try {
    const del = await import('./delegation.service.js');
    const { success } = await import('../../shared/utils/response.js');
    const { resolveOrganizationId } = await import('./userContext.js');
    const orgId = resolveOrganizationId(req);
    const delegation = await del.createDelegation({
      ...req.body,
      factoryId: req.factoryId,
      organizationId: orgId,
      delegatorId: req.user._id,
    }, req.user._id, req.user.email);
    return success(res, delegation, null, 201);
  } catch (e) { next(e); }
});

router.get('/delegations', rbac('user.read'), requireFactory, async (req, res, next) => {
  try {
    const del = await import('./delegation.service.js');
    const { success } = await import('../../shared/utils/response.js');
    const { resolveOrganizationId } = await import('./userContext.js');
    const orgId = resolveOrganizationId(req);
    const items = await del.listDelegations(req.factoryId, req.user._id, orgId);
    return success(res, items);
  } catch (e) { next(e); }
});

router.post('/delegations/:id/revoke', rbac('user.update'), async (req, res, next) => {
  try {
    const del = await import('./delegation.service.js');
    const { success } = await import('../../shared/utils/response.js');
    const { resolveOrganizationId } = await import('./userContext.js');
    const orgId = resolveOrganizationId(req);
    const delegation = await del.revokeDelegation(
      req.params.id, req.user._id, orgId, req.user.email,
    );
    return success(res, delegation);
  } catch (e) { next(e); }
});

export default router;
