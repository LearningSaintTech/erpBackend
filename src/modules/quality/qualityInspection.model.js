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
  inspectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  completedAt: Date,
  ...auditFields,
});

qualityInspectionSchema.index({ factoryId: 1, inspectionNumber: 1 }, { unique: true });

export const QualityInspection = mongoose.model('QualityInspection', qualityInspectionSchema);
