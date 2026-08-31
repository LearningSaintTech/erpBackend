import mongoose from 'mongoose';
import { tenantFields, auditFields } from '../../shared/utils/schema.js';
import { PRODUCTION_PRIORITIES } from '../../config/designLookups.js';

const productionOrderSchema = new mongoose.Schema({
  ...tenantFields,
  orderNumber: { type: String, required: true },
  designId: { type: mongoose.Schema.Types.ObjectId, ref: 'Design' },
  skuId: { type: mongoose.Schema.Types.ObjectId, ref: 'Sku', required: true },
  bomId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bom', required: true },
  plannedQuantity: { type: Number, required: true },
  producedQuantity: { type: Number, default: 0 },
  priority: { type: String, enum: PRODUCTION_PRIORITIES, default: 'NORMAL' },
  status: {
    type: String,
    enum: ['CREATED', 'MRP_DONE', 'MATERIAL_RESERVED', 'APPROVAL_PENDING', 'APPROVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
    default: 'CREATED',
  },
  mrpId: { type: mongoose.Schema.Types.ObjectId, ref: 'MaterialRequirement' },
  suggestedPrId: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseRequisition' },
  rejectionComments: String,
  revisionComments: String,
  deliveryDate: Date,
  plannedStart: Date,
  plannedEnd: Date,
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedAt: Date,
  /** Frozen BOM total × planned qty at order create. */
  standardCostPerPiece: { type: Number, default: 0 },
  standardMaterialCost: { type: Number, default: 0 },
  /** Sum of store issues at batch start (qty × material master rate). */
  actualMaterialCost: { type: Number, default: 0 },
  ...auditFields,
});

productionOrderSchema.index({ factoryId: 1, orderNumber: 1 }, { unique: true });

export const ProductionOrder = mongoose.model('ProductionOrder', productionOrderSchema);
