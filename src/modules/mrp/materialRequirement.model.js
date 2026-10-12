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
    /** Physical shortage: max(0, required - available). Drives hasShortage / production gating. */
    shortageQty: Number,
    /** Already requested / ordered / awaiting QC across the factory (purchase.onOrder). */
    onOrderQty: { type: Number, default: 0 },
    /** Still to purchase: max(0, required - available - onOrderQty). */
    netShortageQty: { type: Number, default: 0 },
    unit: String,
    unitCost: Number,
    extendedCost: Number,
  }],
  totalCost: { type: Number, default: 0 },
  hasShortage: { type: Boolean, default: false },
  ...auditFields,
});

export const MaterialRequirement = mongoose.model('MaterialRequirement', materialRequirementSchema);
