import mongoose from 'mongoose';
import { tenantFields, auditFields } from '../../shared/utils/schema.js';

const inspectionTemplateSchema = new mongoose.Schema({
  ...tenantFields,
  name: { type: String, required: true },
  inspectionType: { type: String, enum: ['INCOMING', 'SAMPLING', 'IN_PROCESS', 'FINAL'], required: true },
  checklist: [{ item: String, required: Boolean }],
  isActive: { type: Boolean, default: true },
  ...auditFields,
});

export const InspectionTemplate = mongoose.model('InspectionTemplate', inspectionTemplateSchema);
