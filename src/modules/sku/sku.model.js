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
// Perf (large-dataset audit): list/stats queries filter by factory + soft-delete + status and sort by date.
skuSchema.index({ factoryId: 1, isDeleted: 1, status: 1, createdAt: -1 });
skuSchema.index({ factoryId: 1, isDeleted: 1, createdAt: -1 });
skuSchema.index({ designId: 1 });

export const Sku = mongoose.model('Sku', skuSchema);
