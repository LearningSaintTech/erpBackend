import mongoose from 'mongoose';
import { tenantFields, auditFields } from '../../shared/utils/schema.js';

const poLineSchema = {
  materialId: { type: mongoose.Schema.Types.ObjectId, ref: 'Material', required: true },
  orderedQty: { type: Number, required: true },
  receivedQty: { type: Number, default: 0 },
  unit: String,
  unitPrice: { type: Number, default: 0 },
  extendedPrice: { type: Number, default: 0 },
};

const purchaseOrderSchema = new mongoose.Schema({
  ...tenantFields,
  poNumber: { type: String, required: true },
  supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true },
  prId: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseRequisition' },
  lines: [poLineSchema],
  totalAmount: { type: Number, default: 0 },
  status: {
    type: String,
    enum: ['DRAFT', 'APPROVED', 'SENT', 'PARTIAL', 'RECEIVED', 'CANCELLED'],
    default: 'DRAFT',
  },
  expectedDeliveryDate: Date,
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedAt: Date,
  paymentStatus: {
    type: String,
    enum: ['UNPAID', 'PAID'],
    default: 'UNPAID',
  },
  paidAt: Date,
  paidBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  receipts: [{
    url: { type: String, required: true },
    fileName: { type: String, default: '' },
  }],
  ...auditFields,
});

purchaseOrderSchema.pre('save', function (next) {
  let total = 0;
  for (const line of this.lines || []) {
    line.extendedPrice = (line.orderedQty || 0) * (line.unitPrice || 0);
    total += line.extendedPrice;
  }
  this.totalAmount = total;
  next();
});

purchaseOrderSchema.index({ factoryId: 1, poNumber: 1 }, { unique: true });

export const PurchaseOrder = mongoose.model('PurchaseOrder', purchaseOrderSchema);
