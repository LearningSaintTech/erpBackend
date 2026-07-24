import mongoose from 'mongoose';
import { tenantFields, auditFields } from '../../shared/utils/schema.js';

const shiftSchema = new mongoose.Schema({
  ...tenantFields,
  name: { type: String, required: true },
  startTime: { type: String, required: true },
  endTime: { type: String, required: true },
  isActive: { type: Boolean, default: true },
  ...auditFields,
});

export const Shift = mongoose.model('Shift', shiftSchema);
