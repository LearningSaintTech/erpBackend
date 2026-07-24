import { Router } from 'express';
import { authMiddleware } from '../../middleware/auth.js';
import { tenantMiddleware } from '../../middleware/tenant.js';
import { rbac } from '../../middleware/rbac.js';
import { validate } from '../../middleware/errorHandler.js';
import * as ctrl from './settings.controller.js';

const router = Router();

router.use(authMiddleware, tenantMiddleware);

router.get('/settings/general', rbac('settings.configure'), ctrl.getGeneral);
router.put('/settings/general', rbac('settings.configure'), validate(ctrl.generalSettingsSchema), ctrl.updateGeneral);

router.get('/settings/integrations', rbac('settings.configure'), ctrl.getIntegrations);
router.put('/settings/integrations', rbac('settings.configure'), validate(ctrl.integrationsSettingsSchema), ctrl.updateIntegrations);

router.get('/settings/feature-flags', rbac('settings.configure'), ctrl.getFeatureFlags);
router.put('/settings/feature-flags', rbac('settings.configure'), validate(ctrl.featureFlagsSchema), ctrl.updateFeatureFlags);
router.get('/settings/feature-flags/catalog', rbac('settings.configure'), ctrl.getFeatureFlagCatalog);

router.get('/settings/readiness', rbac('settings.configure'), ctrl.getReadiness);

export default router;
