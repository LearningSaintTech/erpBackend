import mongoose from 'mongoose';
import { tenantFields, auditFields } from '../../shared/utils/schema.js';

const storageBinSchema = new mongoose.Schema({
  ...tenantFields,
  warehouseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', required: true },
  zoneId: { type: mongoose.Schema.Types.ObjectId, ref: 'Zone' },
  rackId: { type: mongoose.Schema.Types.ObjectId, ref: 'Rack' },
  shelfId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shelf' },
  zoneCode: { type: String, default: 'A' },
  binCode: { type: String, required: true },
  barcode: String,
  capacity: Number,
  status: { type: String, enum: ['ACTIVE', 'FROZEN', 'INACTIVE'], default: 'ACTIVE' },
  ...auditFields,
});

storageBinSchema.index({ factoryId: 1, warehouseId: 1, binCode: 1 }, { unique: true });
storageBinSchema.index(
  { factoryId: 1, barcode: 1 },
  { unique: true, partialFilterExpression: { barcode: { $type: 'string' }, isDeleted: false } },
);

export const StorageBin = mongoose.model('StorageBin', storageBinSchema);
