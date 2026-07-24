import { Router } from 'express';
import { validate } from '../../middleware/errorHandler.js';
import { authMiddleware } from '../../middleware/auth.js';
import { rbac } from '../../middleware/rbac.js';
import { success } from '../../shared/utils/response.js';
import * as ctrl from './organization.controller.js';
import * as orgService from './organization.service.js';
import { factorySettingsSchema } from '../settings/settings.controller.js';

const router = Router();

router.use(authMiddleware);

router.post('/organizations', rbac('organization.create'), validate(ctrl.createOrgSchema), ctrl.createOrganization);
router.get('/organizations', rbac('organization.read'), ctrl.listOrganizations);
router.get('/organizations/:id', rbac('organization.read'), ctrl.getOrganization);
router.post('/organizations/:orgId/factories', rbac('factory.create'), validate(ctrl.createFactorySchema), ctrl.createFactory);
router.get('/organizations/:orgId/factories', rbac('factory.read'), ctrl.listFactories);
router.get('/factories/:id', rbac('factory.read'), ctrl.getFactory);
router.get('/factories/:id/settings', rbac('factory.configure'), async (req, res, next) => {
  try {
    const settings = await orgService.getFactorySettings(req.params.id);
    return success(res, settings);
  } catch (e) { next(e); }
});
router.put('/factories/:id/settings', rbac('factory.configure'), validate(factorySettingsSchema), async (req, res, next) => {
  try {
    const settings = await orgService.updateFactorySettings(req.params.id, req.body, req.user._id);
    return success(res, settings);
  } catch (e) { next(e); }
});
router.post('/organizations/:orgId/financial-years', rbac('organization.configure'), ctrl.createFinancialYear);
router.get('/organizations/:orgId/financial-years', rbac('organization.read'), ctrl.listFinancialYears);

export default router;
