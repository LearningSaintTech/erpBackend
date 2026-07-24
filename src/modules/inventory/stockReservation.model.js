import mongoose from 'mongoose';
import { tenantFields, auditFields } from '../../shared/utils/schema.js';

const stockReservationSchema = new mongoose.Schema({
  ...tenantFields,
  materialId: { type: mongoose.Schema.Types.ObjectId, ref: 'Material', required: true },
  quantity: { type: Number, required: true },
  unit: String,
  referenceType: { type: String, enum: ['SAMPLE', 'PRODUCTION_ORDER'], required: true },
  referenceId: { type: mongoose.Schema.Types.ObjectId, required: true },
  status: { type: String, enum: ['ACTIVE', 'RELEASED', 'CONSUMED'], default: 'ACTIVE' },
  ...auditFields,
});

stockReservationSchema.index({ referenceType: 1, referenceId: 1 });

export const StockReservation = mongoose.model('StockReservation', stockReservationSchema);
