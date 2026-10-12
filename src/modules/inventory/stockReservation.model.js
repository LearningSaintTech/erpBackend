import mongoose from 'mongoose';
import { tenantFields, auditFields } from '../../shared/utils/schema.js';

export const RESERVATION_REFERENCE_TYPES = ['SAMPLE', 'PRODUCTION_ORDER', 'MANUAL'];

const stockReservationSchema = new mongoose.Schema({
  ...tenantFields,
  materialId: { type: mongoose.Schema.Types.ObjectId, ref: 'Material', required: true },
  quantity: { type: Number, required: true },
  unit: String,
  referenceType: { type: String, enum: RESERVATION_REFERENCE_TYPES, required: true },
  referenceId: { type: mongoose.Schema.Types.ObjectId, required: true },
  status: { type: String, enum: ['ACTIVE', 'RELEASED', 'CONSUMED'], default: 'ACTIVE' },
  /** Free-text purpose for MANUAL holds (referenceId is then a generated id). */
  note: String,
  ...auditFields,
});

stockReservationSchema.index({ referenceType: 1, referenceId: 1 });

export const StockReservation = mongoose.model('StockReservation', stockReservationSchema);
