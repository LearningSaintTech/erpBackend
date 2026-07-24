import mongoose from 'mongoose';
import { tenantFields, auditFields } from '../../shared/utils/schema.js';

const materialRequirementSchema = new mongoose.Schema({
  ...tenantFields,
  referenceType: { type: String, enum: ['PRODUCTION_ORDER', 'BOM_PREVIEW'], required: true },
  referenceId: { type: mongoose.Schema.Types.ObjectId, required: true },
  skuId: { type: mongoose.Schema.Types.ObjectId, ref: 'Sku' },
  bomId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bom' },
  orderQuantity: { type: Number, default: 1 },
  lines: [{
    materialId: { type: mongoose.Schema.Types.ObjectId, ref: 'Material' },
    requiredQty: Number,
    availableQty: Number,
    shortageQty: Number,
    unit: String,
    unitCost: Number,
    extendedCost: Number,
  }],
  totalCost: { type: Number, default: 0 },
  hasShortage: { type: Boolean, default: false },
  ...auditFields,
});

export const MaterialRequirement = mongoose.model('MaterialRequirement', materialRequirementSchema);
