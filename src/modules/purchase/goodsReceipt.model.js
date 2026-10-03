import mongoose from 'mongoose';
import { tenantFields, auditFields } from '../../shared/utils/schema.js';

const grnLineSchema = {
  materialId: { type: mongoose.Schema.Types.ObjectId, ref: 'Material', required: true },
  receivedQty: { type: Number, required: true },
  acceptedQty: { type: Number, default: 0 },
  rejectedQty: { type: Number, default: 0 },
  unit: String,
};

const goodsReceiptSchema = new mongoose.Schema({
  ...tenantFields,
  grnNumber: { type: String, required: true },
  poId: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseOrder', required: true },
  lines: [grnLineSchema],
  status: {
    type: String,
    enum: ['DRAFT', 'PENDING_QC', 'COMPLETED'],
    default: 'DRAFT',
  },
  qcInspectionId: { type: mongoose.Schema.Types.ObjectId, ref: 'QualityInspection' },
  receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  receipts: [{
    url: { type: String, required: true },
    fileName: { type: String, default: '' },
  }],
  ...auditFields,
});

goodsReceiptSchema.index({ factoryId: 1, grnNumber: 1 }, { unique: true });

export const GoodsReceipt = mongoose.model('GoodsReceipt', goodsReceiptSchema);
