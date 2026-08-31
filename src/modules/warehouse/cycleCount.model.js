import mongoose from 'mongoose';
import { tenantFields, auditFields } from '../../shared/utils/schema.js';

const cycleCountSchema = new mongoose.Schema({
  ...tenantFields,
  warehouseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', required: true },
  countNumber: { type: String, required: true },
  status: { type: String, enum: ['DRAFT', 'IN_PROGRESS', 'COMPLETED'], default: 'DRAFT' },
  lines: [{
    materialId: { type: mongoose.Schema.Types.ObjectId, ref: 'Material' },
    skuId: { type: mongoose.Schema.Types.ObjectId, ref: 'Sku' },
    systemQty: Number,
    countedQty: Number,
    variance: Number,
  }],
  ...auditFields,
});

export const CycleCount = mongoose.model('CycleCount', cycleCountSchema);
