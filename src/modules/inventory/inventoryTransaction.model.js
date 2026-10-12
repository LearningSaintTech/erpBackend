import mongoose from 'mongoose';
import { tenantFields, auditFields } from '../../shared/utils/schema.js';

const inventoryTransactionSchema = new mongoose.Schema({
  ...tenantFields,
  type: {
    type: String,
    enum: ['RECEIPT', 'ISSUE', 'TRANSFER', 'ADJUSTMENT', 'RESERVATION', 'RESERVATION_RELEASE'],
    required: true,
  },
  materialId: { type: mongoose.Schema.Types.ObjectId, ref: 'Material' },
  skuId: { type: mongoose.Schema.Types.ObjectId, ref: 'Sku' },
  quantity: { type: Number, required: true },
  /** For ADJUSTMENT rows: IN = stock added, OUT = stock removed (quantity is always positive). */
  direction: { type: String, enum: ['IN', 'OUT'] },
  unit: String,
  referenceType: String,
  referenceId: mongoose.Schema.Types.ObjectId,
  /** RM bin the movement hit (null = receiving dock / unallocated, or spread over several rows). */
  storageBinId: { type: mongoose.Schema.Types.ObjectId, ref: 'StorageBin', default: null },
  /** Purchase cost per unit on RECEIPT rows (drives Material.unitCost moving average). */
  unitCost: Number,
  note: String,
  performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  ...auditFields,
});

// Perf (large-dataset audit): list/stats queries filter by factory + soft-delete + status and sort by date.
inventoryTransactionSchema.index({ factoryId: 1, isDeleted: 1, createdAt: -1 });
inventoryTransactionSchema.index({ factoryId: 1, materialId: 1, createdAt: -1 });
inventoryTransactionSchema.index({ referenceType: 1, referenceId: 1 });

export const InventoryTransaction = mongoose.model('InventoryTransaction', inventoryTransactionSchema);
