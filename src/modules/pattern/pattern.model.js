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

const sizeChartDataSchema = new mongoose.Schema({
  unit: { type: String, default: 'INCHES' },
  sizeLabels: [{ type: String }],
  rows: [{
    _id: false,
    measurementName: String,
    values: { type: Map, of: Number },
  }],
}, { _id: false });

const fabricConsumptionSchema = new mongoose.Schema({
  materialId: { type: mongoose.Schema.Types.ObjectId, ref: 'Material' },
  color: String,
  gsm: Number,
  consumption: { type: Number, default: 0 },
  unit: String,
  wastagePercent: { type: Number, default: 0 },
  supplierName: String,
  fabricCost: { type: Number, default: 0 },
  leadTimeDays: Number,
  minOrderQty: Number,
  approvedVendor: { type: Boolean, default: false },
}, { _id: false });

const bomLineSchema = new mongoose.Schema({
  materialId: { type: mongoose.Schema.Types.ObjectId, ref: 'Material' },
  materialName: String,
  quantity: { type: Number, default: 0 },
  unit: String,
  category: String,
  notes: String,
}, { _id: false });

const accessorySchema = new mongoose.Schema({
  accessoryType: String,
  materialId: { type: mongoose.Schema.Types.ObjectId, ref: 'Material' },
  color: String,
  size: String,
  supplierName: String,
  consumption: { type: Number, default: 1 },
  unit: String,
  unitCost: { type: Number, default: 0 },
  approved: { type: Boolean, default: false },
}, { _id: false });

/** Fabric technicals the pattern master confirms against the actual sourced cloth. */
const fabricSpecsSchema = new mongoose.Schema({
  fabricGsm: Number,
  fabricWidth: String,
  fabricFinish: String,
  shrinkagePercent: Number,
}, { _id: false });

const qualityNotesSchema = new mongoose.Schema({
  allowedDefects: String,
  colorTolerance: String,
  shrinkagePercent: Number,
  measurementTolerance: String,
  checklist: [{ _id: false, item: String, required: { type: Boolean, default: true } }],
}, { _id: false });

const manufacturingNotesSchema = new mongoose.Schema({
  specialStitch: String,
  needleType: String,
  machineType: String,
  threadColor: String,
  packingInstructions: String,
  foldingInstructions: String,
  ironInstructions: String,
  barcodePosition: String,
  labelPosition: String,
}, { _id: false });

const costingSchema = new mongoose.Schema({
  fabricCost: { type: Number, default: 0 },
  accessoriesCost: { type: Number, default: 0 },
  printingCost: { type: Number, default: 0 },
  embroideryCost: { type: Number, default: 0 },
  laborCost: { type: Number, default: 0 },
  packingCost: { type: Number, default: 0 },
  overhead: { type: Number, default: 0 },
  actualCost: { type: Number, default: 0 },
}, { _id: false });

const productionInfoSchema = new mongoose.Schema({
  sampleRequired: { type: Boolean, default: false },
  sampleDeadline: Date,
  expectedProductionQty: Number,
  productionPriority: { type: String, default: 'NORMAL' },
  remarks: String,
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
  // Production tech pack — owned by the pattern master, not the designer.
  sizeChartData: sizeChartDataSchema,
  fabricConsumption: [fabricConsumptionSchema],
  bomLines: [bomLineSchema],
  accessories: [accessorySchema],
  fabricSpecs: fabricSpecsSchema,
  qualityNotes: qualityNotesSchema,
  manufacturingNotes: manufacturingNotesSchema,
  costing: costingSchema,
  productionInfo: productionInfoSchema,
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
