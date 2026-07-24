import mongoose from 'mongoose';
import { tenantFields, auditFields } from '../../shared/utils/schema.js';

const zoneSchema = new mongoose.Schema({
  ...tenantFields,
  warehouseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', required: true },
  zoneCode: { type: String, required: true },
  name: String,
  ...auditFields,
});

zoneSchema.index({ factoryId: 1, warehouseId: 1, zoneCode: 1 }, { unique: true });

export const Zone = mongoose.model('Zone', zoneSchema);
