import mongoose from 'mongoose';
import { tenantFields, auditFields } from '../../shared/utils/schema.js';

const rfqLineSchema = {
  materialId: { type: mongoose.Schema.Types.ObjectId, ref: 'Material', required: true },
  quantity: { type: Number, required: true },
  unit: String,
};

const rfqSchema = new mongoose.Schema({
  ...tenantFields,
  rfqNumber: { type: String, required: true },
  prId: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseRequisition' },
  supplierIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Supplier' }],
  lines: [rfqLineSchema],
  status: { type: String, enum: ['DRAFT', 'SENT', 'CLOSED'], default: 'DRAFT' },
  sentAt: Date,
  ...auditFields,
});

rfqSchema.index({ factoryId: 1, rfqNumber: 1 }, { unique: true });

export const Rfq = mongoose.model('Rfq', rfqSchema);
