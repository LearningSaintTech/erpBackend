import { AuditLog } from '../modules/audit/audit.model.js';

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** First path segment after /api/v1, folded onto the module names the audit filter shows. */
const SEGMENT_MODULES = {
  'purchase-requisitions': 'purchase',
  'purchase-orders': 'purchase',
  'goods-receipts': 'purchase',
  suppliers: 'purchase',
  'production-orders': 'production',
  'production-schedules': 'production',
  batches: 'production',
  machines: 'production',
  'production-lines': 'production',
  shifts: 'production',
  'quality-inspections': 'quality',
  'defect-categories': 'quality',
  'inspection-templates': 'quality',
  capa: 'quality',
  'waste-records': 'waste',
  materials: 'inventory',
  'material-requests': 'inventory',
  'inventory-codes': 'inventory',
  'storage-bins': 'warehouse',
  warehouses: 'warehouse',
  zones: 'warehouse',
  'cycle-counts': 'warehouse',
  designs: 'design',
  collections: 'design',
  seasons: 'design',
  'size-charts': 'design',
  'pattern-developments': 'pattern',
  samples: 'sampling',
  skus: 'sku',
  boms: 'bom',
  'approval-workflows': 'approval',
  approvals: 'approval',
  users: 'user',
  roles: 'user',
  delegations: 'user',
  organizations: 'organization',
  factories: 'organization',
};

export function auditModuleFor(req) {
  const path = (req.originalUrl || '').split('?')[0].replace(/^\/api\/v1\/?/, '');
  const segment = path.split('/')[0] || 'api';
  return SEGMENT_MODULES[segment] || segment;
}

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
          module: auditModuleFor(req),
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
