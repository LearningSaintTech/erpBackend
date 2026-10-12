import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import { env } from './config/env.js';
import { apiLimiter } from './middleware/rateLimiter.js';
import { auditMiddleware } from './middleware/audit.js';
import { errorHandler } from './middleware/errorHandler.js';

import authRoutes from './modules/auth/auth.routes.js';
import orgRoutes from './modules/organization/organization.routes.js';
import userRoutes from './modules/user/user.routes.js';
import approvalRoutes from './modules/approval/approval.routes.js';
import auditRoutes from './modules/audit/audit.routes.js';
import designRoutes from './modules/design/design.routes.js';
import sampleRoutes from './modules/sampling/sample.routes.js';
import skuRoutes from './modules/sku/sku.routes.js';
import bomRoutes from './modules/bom/bom.routes.js';
import inventoryRoutes from './modules/inventory/inventory.routes.js';
import purchaseRoutes from './modules/purchase/purchase.routes.js';
import productionRoutes from './modules/production/production.routes.js';
import warehouseRoutes from './modules/warehouse/warehouse.routes.js';
import qualityRoutes from './modules/quality/quality.routes.js';
import notificationRoutes from './modules/notification/notification.routes.js';
import reportRoutes from './modules/report/report.routes.js';
import wasteRoutes from './modules/waste/waste.routes.js';
import machineRoutes from './modules/production/machine.routes.js';
import settingsRoutes from './modules/settings/settings.routes.js';
import inventoryCodeRoutes from './modules/inventoryCode/inventoryCode.routes.js';
import patternRoutes from './modules/pattern/pattern.routes.js';
import chatRoutes from './modules/chat/chat.routes.js';
import { openApiSpec } from './config/openapi.js';
import * as settingsService from './modules/settings/settings.service.js';
import { success } from './shared/utils/response.js';

const app = express();

const DEFAULT_CORS_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:5174',
  'https://erp.khushpehno.com',
  'https://www.erp.khushpehno.com',
];

function allowedCorsOrigins() {
  const fromEnv = env.corsOrigin.split(',').map((o) => o.trim()).filter(Boolean);
  return new Set([...DEFAULT_CORS_ORIGINS, ...fromEnv]);
}

const corsOptions = {
  credentials: true,
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedCorsOrigins().has(origin)) return callback(null, true);
    if (env.nodeEnv !== 'production' && /^http:\/\/localhost:\d+$/.test(origin)) {
      return callback(null, true);
    }
    try {
      const host = new URL(origin).hostname;
      if (origin.startsWith('https://') && (host === 'khushpehno.com' || host.endsWith('.khushpehno.com'))) {
        return callback(null, true);
      }
    } catch { /* ignore invalid Origin */ }
    callback(null, false);
  },
};

export { corsOptions };

app.set('trust proxy', 1);

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(morgan('dev'));
app.use(express.json({ limit: '15mb' }));
app.use(cookieParser());
app.use('/uploads', express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), '../uploads')));
app.use(apiLimiter);
app.use(auditMiddleware);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', uptime: process.uptime() });
});

app.get('/api/v1/health/ready', async (req, res, next) => {
  try {
    success(res, await settingsService.getReadiness());
  } catch (e) { next(e); }
});

app.get('/api/v1/docs/openapi.json', (req, res) => {
  res.json(openApiSpec);
});

/**
 * Feature routers share the `/api/v1` mount and each starts with `router.use(auth, tenant[, requireFactory])`.
 * Without this gate those path-less middlewares run for every request that walks past the router, so
 * e.g. design's `requireFactory` blocked /settings and auth/tenant lookups repeated ~20× per request.
 * Only enter a router when one of its own routes matches the request.
 */
function scoped(router) {
  return (req, res, next) => {
    const method = req.method === 'HEAD' ? 'get' : req.method.toLowerCase();
    const owns = router.stack.some(
      (layer) => layer.route && layer.match(req.path) && layer.route._handles_method(method),
    );
    return owns ? router(req, res, next) : next();
  };
}

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1', scoped(orgRoutes));
app.use('/api/v1', scoped(userRoutes));
app.use('/api/v1', scoped(approvalRoutes));
app.use('/api/v1', scoped(auditRoutes));
app.use('/api/v1', scoped(designRoutes));
app.use('/api/v1', scoped(patternRoutes));
app.use('/api/v1', scoped(sampleRoutes));
app.use('/api/v1', scoped(skuRoutes));
app.use('/api/v1', scoped(bomRoutes));
app.use('/api/v1', scoped(inventoryRoutes));
app.use('/api/v1', scoped(purchaseRoutes));
app.use('/api/v1', scoped(productionRoutes));
app.use('/api/v1', scoped(warehouseRoutes));
app.use('/api/v1', scoped(qualityRoutes));
app.use('/api/v1', scoped(notificationRoutes));
app.use('/api/v1', scoped(reportRoutes));
app.use('/api/v1', scoped(wasteRoutes));
app.use('/api/v1', scoped(machineRoutes));
app.use('/api/v1', scoped(settingsRoutes));
app.use('/api/v1', scoped(inventoryCodeRoutes));
app.use('/api/v1', scoped(chatRoutes));

app.use(errorHandler);

export default app;
