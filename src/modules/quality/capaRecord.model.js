import mongoose from 'mongoose';
import { tenantFields, auditFields } from '../../shared/utils/schema.js';

const capaRecordSchema = new mongoose.Schema({
  ...tenantFields,
  capaNumber: { type: String, required: true },
  inspectionId: { type: mongoose.Schema.Types.ObjectId, ref: 'QualityInspection' },
  defectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Defect' },
  type: { type: String, enum: ['CORRECTIVE', 'PREVENTIVE'], required: true },
  description: { type: String, required: true },
  rootCause: String,
  actionPlan: String,
  status: { type: String, enum: ['OPEN', 'IN_PROGRESS', 'CLOSED'], default: 'OPEN' },
  dueDate: Date,
  ...auditFields,
});

capaRecordSchema.index({ factoryId: 1, capaNumber: 1 }, { unique: true });

export const CapaRecord = mongoose.model('CapaRecord', capaRecordSchema);
