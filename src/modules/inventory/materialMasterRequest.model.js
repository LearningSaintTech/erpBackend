import mongoose from 'mongoose';
import { tenantFields, auditFields } from '../../shared/utils/schema.js';
import { MATERIAL_CATEGORIES, MATERIAL_UNITS } from './inventory.defaults.js';

const materialMasterRequestSchema = new mongoose.Schema({
  ...tenantFields,
  requestNumber: { type: String, required: true },
  status: {
    type: String,
    enum: ['PENDING', 'APPROVED', 'REJECTED'],
    default: 'PENDING',
    index: true,
  },
  name: { type: String, required: true, trim: true },
  proposedCode: { type: String, trim: true, default: '' },
  category: { type: String, enum: MATERIAL_CATEGORIES, default: 'FABRIC' },
  unit: { type: String, enum: MATERIAL_UNITS, default: 'METERS' },
  unitCost: { type: Number, default: 0 },
  notes: { type: String, default: '' },
  designId: { type: mongoose.Schema.Types.ObjectId, ref: 'Design', index: true },
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reviewedAt: Date,
  reviewNotes: { type: String, default: '' },
  materialId: { type: mongoose.Schema.Types.ObjectId, ref: 'Material' },
  ...auditFields,
});

materialMasterRequestSchema.index({ factoryId: 1, status: 1, createdAt: -1 });
materialMasterRequestSchema.index({ factoryId: 1, requestNumber: 1 }, { unique: true });

export const MaterialMasterRequest = mongoose.model('MaterialMasterRequest', materialMasterRequestSchema);
