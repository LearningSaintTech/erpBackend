import mongoose from 'mongoose';
import { tenantFields, auditFields } from '../../shared/utils/schema.js';

const wasteRecordSchema = new mongoose.Schema({
  ...tenantFields,
  wasteCode: { type: String, required: true },
  wasteType: {
    type: String,
    enum: ['FABRIC_SCRAP', 'THREAD_WASTE', 'ACCESSORY_WASTE', 'REWORK', 'REJECTED_PIECES', 'PACKAGING_WASTE', 'MACHINE_TIME', 'LABOUR_HOURS', 'PRODUCTION_SCRAP'],
    required: true,
  },
  batchId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductionBatch' },
  stage: String,
  materialId: { type: mongoose.Schema.Types.ObjectId, ref: 'Material' },
  skuId: { type: mongoose.Schema.Types.ObjectId, ref: 'Sku' },
  quantity: { type: Number, required: true },
  unit: String,
  weight: Number,
  unitCost: { type: Number, default: 0 },
  totalCost: { type: Number, default: 0 },
  reasonCode: String,
  recoveryAction: { type: String, enum: ['NONE', 'RECYCLE', 'REUSE', 'DISPOSE'], default: 'NONE' },
  status: { type: String, enum: ['RECORDED', 'RECOVERED'], default: 'RECORDED' },
  ...auditFields,
});

wasteRecordSchema.pre('save', function (next) {
  this.totalCost = (this.quantity || 0) * (this.unitCost || 0);
  next();
});

wasteRecordSchema.index({ factoryId: 1, wasteCode: 1 }, { unique: true });

export const WasteRecord = mongoose.model('WasteRecord', wasteRecordSchema);
