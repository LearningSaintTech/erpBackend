import mongoose from 'mongoose';
import { AppSettings } from './appSettings.model.js';
import {
  mergeSettings, maskIntegrationSecrets, applyIntegrationSecrets,
} from './settings.defaults.js';

export async function getSettings({ organizationId, factoryId, category }) {
  const doc = await AppSettings.findOne({
    organizationId,
    factoryId: factoryId || null,
    category,
  });
  const stored = doc?.settings || {};
  const merged = mergeSettings(category, stored);
  if (category === 'INTEGRATIONS') return maskIntegrationSecrets(stored);
  return merged;
}

export async function updateSettings({ organizationId, factoryId, category, settings }, userId) {
  const filter = { organizationId, factoryId: factoryId || null, category };
  const existing = await AppSettings.findOne(filter);
  const current = existing?.settings || {};
  const next = mergeSettings(category, { ...current, ...settings });

  const doc = await AppSettings.findOneAndUpdate(
    filter,
    {
      settings: next,
      updatedBy: userId,
      organizationId,
      factoryId: factoryId || null,
      category,
      ...(existing ? {} : { createdBy: userId }),
    },
    { upsert: true, new: true },
  );
  if (category === 'INTEGRATIONS') return maskIntegrationSecrets(doc.settings);
  return mergeSettings(category, doc.settings);
}

export async function updateIntegrations(organizationId, patch, userId) {
  const filter = { organizationId, factoryId: null, category: 'INTEGRATIONS' };
  const existing = await AppSettings.findOne(filter);
  const current = existing?.settings || {};
  const next = applyIntegrationSecrets(current, patch);

  const doc = await AppSettings.findOneAndUpdate(
    filter,
    {
      settings: next,
      updatedBy: userId,
      organizationId,
      factoryId: null,
      category: 'INTEGRATIONS',
      ...(existing ? {} : { createdBy: userId }),
    },
    { upsert: true, new: true },
  );
  return maskIntegrationSecrets(doc.settings);
}

export async function getFeatureFlags(organizationId, factoryId) {
  return getSettings({ organizationId, factoryId, category: 'FEATURE_FLAGS' });
}

export async function getIntegrations(organizationId) {
  return getSettings({ organizationId, factoryId: null, category: 'INTEGRATIONS' });
}

export async function getReadiness() {
  let database = 'ok';
  try {
    if (mongoose.connection.readyState !== 1) database = 'disconnected';
  } catch {
    database = 'error';
  }
  return {
    status: database === 'ok' ? 'ready' : 'degraded',
    checks: {
      database,
      redis: process.env.REDIS_URL ? 'configured' : 'optional',
      twofactor: process.env.TWOFACTOR_API_KEY ? 'configured' : 'optional',
      smtp: process.env.SMTP_HOST ? 'configured' : 'optional',
      s3: process.env.S3_BUCKET ? 'configured' : 'optional',
    },
  };
}
