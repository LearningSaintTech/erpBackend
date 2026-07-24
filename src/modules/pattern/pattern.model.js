import mongoose from 'mongoose';
import { tenantFields, auditFields } from '../../shared/utils/schema.js';

const markerSchema = new mongoose.Schema({
  fileName: String,
  url: String,
  mimeType: String,
  length: Number,
  width: Number,
  fabricWidth: Number,
  piecesPerMarker: Number,
  efficiencyPercent: Number,
  notes: String,
  uploadedAt: Date,
}, { _id: false });

const gradingSchema = new mongoose.Schema({
  baseSize: String,
  gradedSizes: [String],
  notes: String,
}, { _id: false });

const calculatedConsumptionSchema = new mongoose.Schema({
  metersPerGarment: Number,
  wastagePercent: Number,
  derivedFromMarker: { type: Boolean, default: false },
  notes: String,
}, { _id: false });

const patternDevelopmentSchema = new mongoose.Schema({
  ...tenantFields,
  patternDevelopmentCode: { type: String, trim: true },
  designId: { type: mongoose.Schema.Types.ObjectId, ref: 'Design', required: true, index: true },
  patternMasterId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  status: {
    type: String,
    enum: ['ASSIGNED', 'IN_PROGRESS', 'COMPLETED'],
    default: 'ASSIGNED',
  },
  marker: markerSchema,
  grading: gradingSchema,
  calculatedConsumption: calculatedConsumptionSchema,
  patternNotes: String,
  sizeChartVerified: { type: Boolean, default: false },
  consumptionVerified: { type: Boolean, default: false },
  sampleBomVerified: { type: Boolean, default: false },
  assignedAt: Date,
  completedAt: Date,
  ...auditFields,
});

patternDevelopmentSchema.index({ factoryId: 1, designId: 1 }, { unique: true });
patternDevelopmentSchema.index({ factoryId: 1, patternDevelopmentCode: 1 }, { unique: true, sparse: true });

export const PatternDevelopment = mongoose.model('PatternDevelopment', patternDevelopmentSchema);

export const PATTERN_STATUS_LIST = ['ASSIGNED', 'IN_PROGRESS', 'COMPLETED'];
