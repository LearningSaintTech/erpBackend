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
  /** Good pieces handed to final QC = plannedQuantity − rejectedQuantity (set on line completion). */
  producedQuantity: { type: Number, default: 0 },
  /** Pieces rejected by in-process QC (reduce the good quantity before final QC). */
  rejectedQuantity: { type: Number, default: 0 },
  /** Final QC outcome for this batch (accumulated; REWORK inspections post nothing). */
  passedQuantity: { type: Number, default: 0 },
  finalRejectedQuantity: { type: Number, default: 0 },
  /** Stage list frozen at batch creation — later settings edits cannot strand the batch. */
  stages: { type: [String], default: undefined },
  /** Why a batch was CANCELLED (e.g. ALL_PIECES_REJECTED when in-process QC rejected every piece). */
  closedReason: String,
  currentStage: {
    type: String,
    default: 'CUTTING',
  },
  status: {
    type: String,
    enum: ['CREATED', 'IN_PROGRESS', 'COMPLETED', 'REWORK', 'CANCELLED'],
    default: 'CREATED',
  },
  /** Set while startBatch is issuing materials — atomic claim against double starts. */
  startingAt: Date,
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
// Perf (large-dataset audit): list/stats queries filter by factory + soft-delete + status and sort by date.
productionBatchSchema.index({ factoryId: 1, isDeleted: 1, status: 1, createdAt: -1 });
productionBatchSchema.index({ factoryId: 1, currentStage: 1, isDeleted: 1, createdAt: 1 });
productionBatchSchema.index({ productionOrderId: 1 });
productionBatchSchema.index({ factoryId: 1, isDeleted: 1, status: 1, updatedAt: -1 });

export const ProductionBatch = mongoose.model('ProductionBatch', productionBatchSchema);
