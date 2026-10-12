import mongoose from 'mongoose';
import { tenantFields, auditFields } from '../../shared/utils/schema.js';

const grnLineSchema = {
  materialId: { type: mongoose.Schema.Types.ObjectId, ref: 'Material', required: true },
  /** PO line this receipt line draws down (set at GRN creation). */
  poLineId: { type: mongoose.Schema.Types.ObjectId },
  receivedQty: { type: Number, required: true },
  acceptedQty: { type: Number, default: 0 },
  rejectedQty: { type: Number, default: 0 },
  unit: String,
  /** PO line unit price at GRN creation — lets QC value the receipt. */
  unitPrice: { type: Number, default: 0 },
};

const goodsReceiptSchema = new mongoose.Schema({
  ...tenantFields,
  grnNumber: { type: String, required: true },
  poId: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseOrder', required: true },
  lines: [grnLineSchema],
  status: {
    type: String,
    enum: ['DRAFT', 'PENDING_QC', 'COMPLETED', 'CANCELLED'],
    default: 'DRAFT',
  },
  /** Set once incoming QC accepted/rejected qty was written back to the PO (idempotency guard). */
  poSyncedAt: { type: Date, default: null },
  cancelledAt: Date,
  cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  qcInspectionId: { type: mongoose.Schema.Types.ObjectId, ref: 'QualityInspection' },
  receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  receipts: [{
    url: { type: String, required: true },
    fileName: { type: String, default: '' },
  }],
  ...auditFields,
});

goodsReceiptSchema.index({ factoryId: 1, grnNumber: 1 }, { unique: true });
// Perf (large-dataset audit): list/stats queries filter by factory + soft-delete + status and sort by date.
goodsReceiptSchema.index({ factoryId: 1, isDeleted: 1, status: 1, createdAt: -1 });
goodsReceiptSchema.index({ factoryId: 1, isDeleted: 1, createdAt: -1 });
goodsReceiptSchema.index({ poId: 1 });

export const GoodsReceipt = mongoose.model('GoodsReceipt', goodsReceiptSchema);
