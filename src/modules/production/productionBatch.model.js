import mongoose from 'mongoose';
import { tenantFields, auditFields } from '../../shared/utils/schema.js';

const stageHistorySchema = {
  stage: String,
  startedAt: Date,
  completedAt: Date,
  completedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
};

const productionBatchSchema = new mongoose.Schema({
  ...tenantFields,
  batchNumber: { type: String, required: true },
  productionOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductionOrder', required: true },
  plannedQuantity: { type: Number, required: true },
  producedQuantity: { type: Number, default: 0 },
  currentStage: {
    type: String,
    default: 'CUTTING',
  },
  status: {
    type: String,
    enum: ['CREATED', 'IN_PROGRESS', 'COMPLETED', 'REWORK'],
    default: 'CREATED',
  },
  stageHistory: [stageHistorySchema],
  machineId: { type: mongoose.Schema.Types.ObjectId, ref: 'Machine' },
  shiftId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shift' },
  workerIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  stageQcPassed: { type: Map, of: Boolean, default: {} },
  machineHours: { type: Number, default: 0 },
  labourHours: { type: Number, default: 0 },
  qcInspectionId: { type: mongoose.Schema.Types.ObjectId, ref: 'QualityInspection' },
  actualMaterialCost: { type: Number, default: 0 },
  issuedMaterials: [{
    _id: false,
    materialId: { type: mongoose.Schema.Types.ObjectId, ref: 'Material' },
    quantity: Number,
    unit: String,
    unitCost: Number,
    extendedCost: Number,
  }],
  ...auditFields,
});

productionBatchSchema.index({ factoryId: 1, batchNumber: 1 }, { unique: true });

export const ProductionBatch = mongoose.model('ProductionBatch', productionBatchSchema);
