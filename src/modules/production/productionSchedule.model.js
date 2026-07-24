import mongoose from 'mongoose';
import { tenantFields, auditFields } from '../../shared/utils/schema.js';

const productionScheduleSchema = new mongoose.Schema({
  ...tenantFields,
  productionOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductionOrder', required: true },
  batchId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductionBatch' },
  stage: String,
  productionLineId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductionLine' },
  machineId: { type: mongoose.Schema.Types.ObjectId, ref: 'Machine' },
  shiftId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shift' },
  workerIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  plannedStart: Date,
  plannedEnd: Date,
  status: {
    type: String,
    enum: ['PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
    default: 'PLANNED',
  },
  notes: String,
  ...auditFields,
});

productionScheduleSchema.index({ factoryId: 1, productionOrderId: 1 });
productionScheduleSchema.index({ factoryId: 1, plannedStart: 1 });

export const ProductionSchedule = mongoose.model('ProductionSchedule', productionScheduleSchema);
