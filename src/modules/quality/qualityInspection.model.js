import mongoose from 'mongoose';
import { tenantFields, auditFields } from '../../shared/utils/schema.js';

const defectSchema = {
  code: String,
  description: String,
  quantity: Number,
};

const qualityInspectionSchema = new mongoose.Schema({
  ...tenantFields,
  inspectionNumber: { type: String, required: true },
  inspectionType: {
    type: String,
    enum: ['INCOMING', 'IN_PROCESS', 'FINAL', 'SAMPLING'],
    required: true,
  },
  referenceType: {
    type: String,
    enum: ['GOODS_RECEIPT', 'PRODUCTION_BATCH', 'SAMPLE'],
    required: true,
  },
  referenceId: { type: mongoose.Schema.Types.ObjectId, required: true },
  status: {
    type: String,
    enum: ['PENDING', 'IN_PROGRESS', 'COMPLETED'],
    default: 'PENDING',
  },
  passedQuantity: { type: Number, default: 0 },
  failedQuantity: { type: Number, default: 0 },
  result: { type: String, enum: ['PASS', 'FAIL', 'PARTIAL', 'REWORK', 'REJECT'] },
  disposition: { type: String, enum: ['PASS', 'REWORK', 'REJECT'] },
  stageAtInspection: String,
  storageBinId: { type: mongoose.Schema.Types.ObjectId, ref: 'StorageBin' },
  autoDispatchReady: { type: Boolean, default: false },
  defects: [defectSchema],
  /** Incoming QC: per GRN line decision (accepted + rejected <= received). */
  lineResults: [{
    _id: false,
    grnLineId: mongoose.Schema.Types.ObjectId,
    materialId: { type: mongoose.Schema.Types.ObjectId, ref: 'Material' },
    unit: String,
    receivedQty: Number,
    acceptedQty: Number,
    rejectedQty: Number,
  }],
  /**
   * Incoming QC idempotency: accepted qty already receipted into stock per GRN line. Written right
   * after each receipt, so a retry after a mid-way failure skips (or tops up) posted lines.
   */
  postedLines: [{
    _id: false,
    grnLineId: mongoose.Schema.Types.ObjectId,
    postedQty: Number,
  }],
  inspectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  completedAt: Date,
  /** Set while completeInspection applies side effects — atomic claim against double completes. */
  completingAt: Date,
  ...auditFields,
});

qualityInspectionSchema.index({ factoryId: 1, inspectionNumber: 1 }, { unique: true });

export const QualityInspection = mongoose.model('QualityInspection', qualityInspectionSchema);
