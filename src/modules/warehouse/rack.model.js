import mongoose from 'mongoose';
import { tenantFields, auditFields } from '../../shared/utils/schema.js';

const rackSchema = new mongoose.Schema({
  ...tenantFields,
  zoneId: { type: mongoose.Schema.Types.ObjectId, ref: 'Zone', required: true },
  rackCode: { type: String, required: true },
  ...auditFields,
});

rackSchema.index({ factoryId: 1, zoneId: 1, rackCode: 1 }, { unique: true });

export const Rack = mongoose.model('Rack', rackSchema);
