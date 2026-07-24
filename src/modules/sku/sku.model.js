import mongoose from 'mongoose';
import { tenantFields, auditFields } from '../../shared/utils/schema.js';

const skuSchema = new mongoose.Schema({
  ...tenantFields,
  skuCode: { type: String, required: true },
  name: { type: String, required: true },
  designId: { type: mongoose.Schema.Types.ObjectId, ref: 'Design' },
  sampleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Sample' },
  size: String,
  color: { name: String, hexCode: String },
  barcode: String,
  basePrice: { type: Number, default: 0 },
  currency: { type: String, default: 'INR' },
  status: { type: String, enum: ['DRAFT', 'ACTIVE', 'DISCONTINUED'], default: 'DRAFT' },
  ...auditFields,
});

skuSchema.index({ organizationId: 1, skuCode: 1 }, { unique: true });

export const Sku = mongoose.model('Sku', skuSchema);
