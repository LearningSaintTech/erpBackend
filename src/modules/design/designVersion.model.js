import mongoose from 'mongoose';
import { tenantFields, auditFields } from '../../shared/utils/schema.js';

const designVersionSchema = new mongoose.Schema({
  ...tenantFields,
  designId: { type: mongoose.Schema.Types.ObjectId, ref: 'Design', required: true, index: true },
  version: { type: Number, required: true },
  changeSummary: { type: String, default: 'Updated' },
  released: { type: Boolean, default: false },
  releasedAt: Date,
  snapshot: { type: mongoose.Schema.Types.Mixed, required: true },
  ...auditFields,
});

designVersionSchema.index({ designId: 1, version: 1 }, { unique: true });

export const DesignVersion = mongoose.model('DesignVersion', designVersionSchema);
