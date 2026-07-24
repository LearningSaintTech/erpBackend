import mongoose from 'mongoose';
import { tenantFields, auditFields } from '../../shared/utils/schema.js';
import { SAMPLE_TYPE_LIST } from './sample.defaults.js';

const sampleSchema = new mongoose.Schema({
  ...tenantFields,
  sampleCode: { type: String, required: true },
  designId: { type: mongoose.Schema.Types.ObjectId, ref: 'Design', required: true },
  designVersion: { type: Number, default: 1 },
  iteration: { type: Number, default: 1 },
  status: {
    type: String,
    enum: [
      'CREATED', 'REVISION_REQUESTED',
      'MATERIAL_REQUEST_PENDING', 'MATERIAL_REQUEST_APPROVED', 'MATERIAL_RESERVED',
      'CUTTING', 'IN_PROGRESS',
      'QC_PENDING', 'QC_FAILED', 'FIT_TRIAL',
      'PENDING_APPROVAL', 'QC_PASSED',
      'APPROVED', 'REJECTED',
      // legacy
      'COMPLETED',
    ],
    default: 'CREATED',
  },
  materialRequirements: [{
    materialId: { type: mongoose.Schema.Types.ObjectId, ref: 'Material' },
    requiredQty: Number,
    unit: String,
    reservedQty: { type: Number, default: 0 },
    issuedQty: { type: Number, default: 0 },
    unitCost: { type: Number, default: 0 },
    cost: { type: Number, default: 0 },
  }],
  laborHours: { type: Number, default: 0 },
  laborRate: { type: Number, default: 0 },
  totalCost: { type: Number, default: 0 },
  sampleType: {
    type: String,
    enum: SAMPLE_TYPE_LIST,
    default: 'PROTOTYPE',
  },
  comments: String,
  sewingNotes: String,
  approvedImageAssetIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'DesignAsset' }],
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedAt: Date,
  rejectionComments: String,
  revisionComments: String,
  qcComments: String,
  qcMeasurements: [{
    point: String,
    required: String,
    actual: String,
    tolerance: String,
    pass: Boolean,
  }],
  fitAnalysis: {
    evaluatedOn: { type: String, enum: ['MANNEQUIN', 'LIVE_MODEL', 'FLAT_MEASURE', 'DRESS_FORM', 'CUSTOMER_REP'] },
    overallResult: { type: String, enum: ['PASS', 'MINOR_ISSUES', 'MAJOR_ISSUES', 'FAIL'] },
    issues: [{
      area: String,
      severity: { type: String, enum: ['MINOR', 'MAJOR', 'CRITICAL'] },
      description: String,
    }],
    patternRevisionRequired: { type: Boolean, default: false },
    notes: String,
    evaluatedAt: Date,
    evaluatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  timeline: [{
    at: { type: Date, default: Date.now },
    action: String,
    fromStatus: String,
    toStatus: String,
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    note: String,
  }],
  ...auditFields,
});

sampleSchema.index({ factoryId: 1, sampleCode: 1 }, { unique: true });

export const Sample = mongoose.model('Sample', sampleSchema);
