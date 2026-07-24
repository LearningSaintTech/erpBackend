import mongoose from 'mongoose';
import { tenantFields, auditFields } from '../../shared/utils/schema.js';

const productionLineSchema = new mongoose.Schema({
  ...tenantFields,
  lineCode: { type: String, required: true },
  name: { type: String, required: true },
  stages: [String],
  capacityPerDay: { type: Number, default: 0 },
  status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
  ...auditFields,
});

productionLineSchema.index({ factoryId: 1, lineCode: 1 }, { unique: true });

export const ProductionLine = mongoose.model('ProductionLine', productionLineSchema);
