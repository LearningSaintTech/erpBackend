import mongoose from 'mongoose';
import { tenantFields, auditFields } from '../../shared/utils/schema.js';

const bomLineSchema = {
  materialId: { type: mongoose.Schema.Types.ObjectId, ref: 'Material', required: true },
  materialCategory: String,
  quantityPerPiece: { type: Number, required: true },
  unit: String,
  wastagePercent: { type: Number, default: 0 },
  effectiveQuantity: { type: Number, default: 0 },
  unitCost: { type: Number, default: 0 },
  extendedCost: { type: Number, default: 0 },
  isOptional: { type: Boolean, default: false },
};

const bomSchema = new mongoose.Schema({
  ...tenantFields,
  bomCode: { type: String, required: true },
  skuId: { type: mongoose.Schema.Types.ObjectId, ref: 'Sku', required: true },
  version: { type: Number, default: 1 },
  status: {
    type: String,
    enum: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'ACTIVE', 'OBSOLETE'],
    default: 'DRAFT',
  },
  lines: [bomLineSchema],
  totalCostPerPiece: { type: Number, default: 0 },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedAt: Date,
  ...auditFields,
});

bomSchema.pre('save', function (next) {
  let total = 0;
  for (const line of this.lines || []) {
    line.effectiveQuantity = line.quantityPerPiece * (1 + (line.wastagePercent || 0) / 100);
    line.extendedCost = line.effectiveQuantity * (line.unitCost || 0);
    total += line.extendedCost;
  }
  this.totalCostPerPiece = total;
  next();
});

bomSchema.index({ factoryId: 1, bomCode: 1 }, { unique: true });
bomSchema.index({ skuId: 1, status: 1 });

export const Bom = mongoose.model('Bom', bomSchema);
