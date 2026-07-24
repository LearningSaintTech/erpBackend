import { AuditLog } from '../modules/audit/audit.model.js';

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function auditMiddleware(req, res, next) {
  if (!MUTATION_METHODS.has(req.method)) return next();

  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode < 400 && req.user) {
      setImmediate(() => {
        AuditLog.create({
          organizationId: req.organizationId || req.user.organizationId,
          factoryId: req.factoryId || null,
          userId: req.user._id,
          userEmail: req.user.email,
          module: req.baseUrl?.split('/').pop() || 'api',
          action: `${req.method}_${req.path}`,
          metadata: {
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
            method: req.method,
            path: req.originalUrl,
          },
          timestamp: new Date(),
        }).catch((err) => console.error('Audit log failed:', err.message));
      });
    }
    return originalJson(body);
  };
  next();
}
