import mongoose from 'mongoose';
import { tenantFields, auditFields } from '../../shared/utils/schema.js';

const seasonSchema = new mongoose.Schema({
  ...tenantFields,
  code: { type: String, trim: true },
  name: { type: String, required: true },
  year: { type: Number, required: true },
  startDate: Date,
  endDate: Date,
  status: { type: String, enum: ['ACTIVE', 'ARCHIVED'], default: 'ACTIVE' },
  ...auditFields,
});

seasonSchema.index({ organizationId: 1, name: 1, year: 1 });

export const Season = mongoose.model('Season', seasonSchema);
