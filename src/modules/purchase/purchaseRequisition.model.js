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
    enum: ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CONVERTED', 'CANCELLED'],
    default: 'DRAFT',
  },
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedAt: Date,
  rejectionComments: String,
  /** Approver's "request changes" note — PR is back in DRAFT for the requester to revise. */
  revisionComments: String,
  revisionRequestedAt: Date,
  revisionRequestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  cancelledAt: Date,
  cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  ...auditFields,
});

purchaseRequisitionSchema.index({ factoryId: 1, prNumber: 1 }, { unique: true });
// Perf (large-dataset audit): list/stats queries filter by factory + soft-delete + status and sort by date.
purchaseRequisitionSchema.index({ factoryId: 1, isDeleted: 1, status: 1, createdAt: -1 });
purchaseRequisitionSchema.index({ factoryId: 1, isDeleted: 1, createdAt: -1 });

export const PurchaseRequisition = mongoose.model('PurchaseRequisition', purchaseRequisitionSchema);
