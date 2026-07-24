import mongoose from 'mongoose';
import { tenantFields, auditFields } from '../../shared/utils/schema.js';

const sizeChartSchema = new mongoose.Schema({
  ...tenantFields,
  name: { type: String, required: true },
  unit: { type: String, default: 'INCHES' },
  sizeLabels: [{ type: String }],
  rows: [{
    measurementName: { type: String, required: true },
    values: { type: Map, of: Number },
  }],
  // legacy fixed columns — kept for backward compatibility
  measurements: [{
    sizeLabel: String,
    chest: Number,
    waist: Number,
    hip: Number,
    length: Number,
    shoulder: Number,
    sleeve: Number,
  }],
  status: { type: String, enum: ['ACTIVE', 'ARCHIVED'], default: 'ACTIVE' },
  ...auditFields,
});

export const SizeChart = mongoose.model('SizeChart', sizeChartSchema);
