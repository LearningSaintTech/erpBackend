import mongoose from 'mongoose';
import { tenantFields, auditFields } from '../../shared/utils/schema.js';

const prLineSchema = {
  materialId: { type: mongoose.Schema.Types.ObjectId, ref: 'Material', required: true },
  requiredQty: { type: Number, required: true },
  unit: String,
  estimatedUnitCost: { type: Number, default: 0 },
};

const purchaseRequisitionSchema = new mongoose.Schema({
  ...tenantFields,
  prNumber: { type: String, required: true },
  sourceType: { type: String, enum: ['MRP', 'MANUAL'], default: 'MANUAL' },
  mrpId: { type: mongoose.Schema.Types.ObjectId, ref: 'MaterialRequirement' },
  lines: [prLineSchema],
  status: {
    type: String,
    enum: ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CONVERTED'],
    default: 'DRAFT',
  },
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedAt: Date,
  rejectionComments: String,
  ...auditFields,
});

purchaseRequisitionSchema.index({ factoryId: 1, prNumber: 1 }, { unique: true });

export const PurchaseRequisition = mongoose.model('PurchaseRequisition', purchaseRequisitionSchema);
