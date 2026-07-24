import mongoose from 'mongoose';
import { tenantFields, auditFields } from '../../shared/utils/schema.js';

const machineSchema = new mongoose.Schema({
  ...tenantFields,
  machineCode: { type: String, required: true },
  name: { type: String, required: true },
  machineType: { type: String, enum: ['CUTTING', 'SEWING', 'PRINTING', 'EMBROIDERY', 'WASHING', 'IRONING', 'OTHER'], default: 'OTHER' },
  productionLineId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductionLine' },
  capacityPerHour: { type: Number, default: 0 },
  status: { type: String, enum: ['ACTIVE', 'MAINTENANCE', 'INACTIVE'], default: 'ACTIVE' },
  ...auditFields,
});

machineSchema.index({ factoryId: 1, machineCode: 1 }, { unique: true });

export const Machine = mongoose.model('Machine', machineSchema);
