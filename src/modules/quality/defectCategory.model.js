import mongoose from 'mongoose';
import { tenantFields, auditFields } from '../../shared/utils/schema.js';

const defectCategorySchema = new mongoose.Schema({
  ...tenantFields,
  code: { type: String, required: true },
  name: { type: String, required: true },
  severity: { type: String, enum: ['MINOR', 'MAJOR', 'CRITICAL'], default: 'MINOR' },
  ...auditFields,
});

export const DefectCategory = mongoose.model('DefectCategory', defectCategorySchema);
