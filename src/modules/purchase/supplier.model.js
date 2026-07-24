import mongoose from 'mongoose';
import { tenantFields, auditFields } from '../../shared/utils/schema.js';

const supplierSchema = new mongoose.Schema({
  ...tenantFields,
  supplierCode: { type: String, required: true },
  name: { type: String, required: true },
  contactEmail: String,
  phone: String,
  leadTimeDays: { type: Number, default: 7 },
  paymentTerms: String,
  status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
  ...auditFields,
});

supplierSchema.index({ factoryId: 1, supplierCode: 1 }, { unique: true });

export const Supplier = mongoose.model('Supplier', supplierSchema);
