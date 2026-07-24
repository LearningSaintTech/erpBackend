import mongoose from 'mongoose';
import { tenantFields, auditFields } from '../../shared/utils/schema.js';

const defectSchema = new mongoose.Schema({
  ...tenantFields,
  inspectionId: { type: mongoose.Schema.Types.ObjectId, ref: 'QualityInspection', required: true },
  categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'DefectCategory' },
  description: String,
  quantity: { type: Number, default: 1 },
  severity: { type: String, enum: ['MINOR', 'MAJOR', 'CRITICAL'], default: 'MINOR' },
  ...auditFields,
});

export const Defect = mongoose.model('Defect', defectSchema);
