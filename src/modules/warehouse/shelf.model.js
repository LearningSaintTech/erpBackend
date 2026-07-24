import mongoose from 'mongoose';
import { tenantFields, auditFields } from '../../shared/utils/schema.js';

const shelfSchema = new mongoose.Schema({
  ...tenantFields,
  rackId: { type: mongoose.Schema.Types.ObjectId, ref: 'Rack', required: true },
  shelfCode: { type: String, required: true },
  ...auditFields,
});

shelfSchema.index({ factoryId: 1, rackId: 1, shelfCode: 1 }, { unique: true });

export const Shelf = mongoose.model('Shelf', shelfSchema);
