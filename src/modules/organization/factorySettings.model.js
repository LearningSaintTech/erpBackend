import mongoose from 'mongoose';
import { tenantFields, auditFields } from '../../shared/utils/schema.js';

const factorySettingsSchema = new mongoose.Schema({
  ...tenantFields,
  shifts: [{ name: String, startTime: String, endTime: String }],
  workingDays: [Number],
  productionStages: [String],
  defaultWarehouses: mongoose.Schema.Types.Mixed,
  numberingPrefixes: mongoose.Schema.Types.Mixed,
  updatedAt: { type: Date, default: Date.now },
});

factorySettingsSchema.index({ factoryId: 1 }, { unique: true });

export const FactorySettings = mongoose.model('FactorySettings', factorySettingsSchema);
