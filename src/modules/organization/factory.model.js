import mongoose from 'mongoose';
import { tenantFields, auditFields } from '../../shared/utils/schema.js';

const factorySchema = new mongoose.Schema({
  ...tenantFields,
  code: { type: String, required: true, uppercase: true, trim: true },
  name: { type: String, required: true },
  address: mongoose.Schema.Types.Mixed,
  contact: mongoose.Schema.Types.Mixed,
  capacity: { dailyUnits: Number, lines: Number },
  status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
  settingsId: { type: mongoose.Schema.Types.ObjectId, ref: 'FactorySettings' },
  ...auditFields,
});

factorySchema.index({ organizationId: 1, code: 1 }, { unique: true });

export const Factory = mongoose.model('Factory', factorySchema);
