import mongoose from 'mongoose';
import { tenantFields, auditFields } from '../../shared/utils/schema.js';

const appSettingsSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization' },
  factoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Factory' },
  category: { type: String, enum: ['GENERAL', 'INTEGRATIONS', 'FEATURE_FLAGS'], required: true },
  settings: { type: mongoose.Schema.Types.Mixed, default: {} },
  ...auditFields,
});

appSettingsSchema.index({ organizationId: 1, factoryId: 1, category: 1 }, { unique: true });

export const AppSettings = mongoose.model('AppSettings', appSettingsSchema);
