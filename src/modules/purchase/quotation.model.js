import mongoose from 'mongoose';
import { tenantFields, auditFields } from '../../shared/utils/schema.js';

const quoteLineSchema = {
  materialId: { type: mongoose.Schema.Types.ObjectId, ref: 'Material', required: true },
  quantity: Number,
  unit: String,
  unitPrice: { type: Number, required: true },
  extendedPrice: { type: Number, default: 0 },
};

const quotationSchema = new mongoose.Schema({
  ...tenantFields,
  rfqId: { type: mongoose.Schema.Types.ObjectId, ref: 'Rfq', required: true },
  supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true },
  lines: [quoteLineSchema],
  totalAmount: { type: Number, default: 0 },
  status: { type: String, enum: ['SUBMITTED', 'SELECTED', 'REJECTED'], default: 'SUBMITTED' },
  validUntil: Date,
  ...auditFields,
});

quotationSchema.pre('save', function (next) {
  let total = 0;
  for (const line of this.lines || []) {
    line.extendedPrice = (line.quantity || 0) * (line.unitPrice || 0);
    total += line.extendedPrice;
  }
  this.totalAmount = total;
  next();
});

export const Quotation = mongoose.model('Quotation', quotationSchema);
