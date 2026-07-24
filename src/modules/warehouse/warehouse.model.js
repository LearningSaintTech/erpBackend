import mongoose from 'mongoose';
import { tenantFields, auditFields } from '../../shared/utils/schema.js';

const warehouseSchema = new mongoose.Schema({
  ...tenantFields,
  warehouseCode: { type: String, required: true },
  name: { type: String, required: true },
  type: { type: String, enum: ['RAW_MATERIAL', 'WIP', 'FINISHED_GOODS'], default: 'RAW_MATERIAL' },
  address: String,
  isDefault: { type: Boolean, default: false },
  status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
  ...auditFields,
});

warehouseSchema.index({ factoryId: 1, warehouseCode: 1 }, { unique: true });

export const Warehouse = mongoose.model('Warehouse', warehouseSchema);
