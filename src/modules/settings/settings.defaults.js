/** Default settings shapes and feature-flag catalog for org/factory configuration */

export const GENERAL_DEFAULTS = {
  timezone: 'Asia/Kolkata',
  currency: 'INR',
  dateFormat: 'DD/MM/YYYY',
  locale: 'en-IN',
  fiscalYearStartMonth: 4,
  lowStockAlertDays: 7,
  defaultUom: 'PIECES',
};

export const INTEGRATIONS_DEFAULTS = {
  email: {
    enabled: false,
    host: '',
    port: 587,
    secure: false,
    user: '',
    fromName: '',
    fromEmail: '',
    password: '',
  },
  sms: {
    enabled: false,
    provider: 'twilio',
    apiKey: '',
    senderId: '',
  },
  webhook: {
    enabled: false,
    url: '',
    secret: '',
    events: ['design.approved', 'production.completed'],
  },
};

export const FEATURE_FLAG_CATALOG = [
  { key: 'advancedQuality', label: 'Advanced QC', description: 'Enable in-process QC gates on production stages.' },
  { key: 'rfqModule', label: 'RFQ module', description: 'Request-for-quotation workflow in purchase.' },
  { key: 'wasteTracking', label: 'Waste tracking', description: 'Track material waste and scrap in production.' },
  { key: 'batchBarcode', label: 'Batch barcodes', description: 'Generate barcodes for production batches.' },
  { key: 'strictInventoryLock', label: 'Strict inventory lock', description: 'Block issues when stock is below reserved quantity.' },
  { key: 'autoSkuGeneration', label: 'Auto SKU generation', description: 'Generate SKUs from design matrix on release.' },
  { key: 'multiFactoryReports', label: 'Multi-factory reports', description: 'Consolidated reports across factories.' },
  { key: 'emailNotifications', label: 'Email notifications', description: 'Send transactional emails when SMTP is configured.' },
];

export const FEATURE_FLAGS_DEFAULTS = Object.fromEntries(
  FEATURE_FLAG_CATALOG.map((f) => [f.key, false]),
);

export const NUMBERING_PREFIX_DEFAULTS = {
  design: 'DSN',
  sku: 'SKU',
  purchaseOrder: 'PO',
  productionOrder: 'PRD',
  batch: 'BAT',
  sample: 'SMP',
};

export const SECRET_MASK = '••••••••';

const CATEGORY_DEFAULTS = {
  GENERAL: GENERAL_DEFAULTS,
  INTEGRATIONS: INTEGRATIONS_DEFAULTS,
  FEATURE_FLAGS: FEATURE_FLAGS_DEFAULTS,
};

export function getDefaultsForCategory(category) {
  return CATEGORY_DEFAULTS[category] || {};
}

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object') return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

export function mergeSettings(category, stored = {}) {
  return deepMerge(getDefaultsForCategory(category), stored);
}

export function maskIntegrationSecrets(settings) {
  const merged = mergeSettings('INTEGRATIONS', settings);
  if (merged.email?.password) merged.email.password = SECRET_MASK;
  if (merged.sms?.apiKey) merged.sms.apiKey = SECRET_MASK;
  if (merged.webhook?.secret) merged.webhook.secret = SECRET_MASK;
  return merged;
}

export function applyIntegrationSecrets(existing, incoming) {
  const merged = mergeSettings('INTEGRATIONS', { ...existing, ...incoming });
  if (incoming.email?.password === SECRET_MASK) {
    merged.email.password = existing.email?.password || '';
  }
  if (incoming.sms?.apiKey === SECRET_MASK) {
    merged.sms.apiKey = existing.sms?.apiKey || '';
  }
  if (incoming.webhook?.secret === SECRET_MASK) {
    merged.webhook.secret = existing.webhook?.secret || '';
  }
  return merged;
}
