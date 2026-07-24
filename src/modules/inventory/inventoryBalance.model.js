import mongoose from 'mongoose';
import { tenantFields, auditFields } from '../../shared/utils/schema.js';

const inventoryBalanceSchema = new mongoose.Schema({
  ...tenantFields,
  inventoryType: {
    type: String,
    enum: ['RAW_MATERIAL', 'WIP', 'FINISHED_GOODS', 'SCRAP', 'REJECTED'],
    default: 'RAW_MATERIAL',
  },
  materialId: { type: mongoose.Schema.Types.ObjectId, ref: 'Material' },
  skuId: { type: mongoose.Schema.Types.ObjectId, ref: 'Sku' },
  /** @deprecated use storageBinId — kept for legacy reads */
  locationId: { type: mongoose.Schema.Types.ObjectId, default: null },
  storageBinId: { type: mongoose.Schema.Types.ObjectId, ref: 'StorageBin', default: null },
  dispatchStatus: {
    type: String,
    enum: ['STAGED', 'READY_FOR_DISPATCH', 'DISPATCHED'],
    default: null,
  },
  onHand: { type: Number, default: 0 },
  reserved: { type: Number, default: 0 },
  available: { type: Number, default: 0 },
  unit: String,
  ...auditFields,
});

inventoryBalanceSchema.pre('save', function (next) {
  this.available = Math.max(0, (this.onHand || 0) - (this.reserved || 0));
  next();
});

// Unallocated RM pool (one row per material per factory)
inventoryBalanceSchema.index(
  { factoryId: 1, materialId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      inventoryType: 'RAW_MATERIAL',
      storageBinId: null,
      isDeleted: false,
    },
  },
);

// Per-bin RM stock
inventoryBalanceSchema.index(
  { factoryId: 1, materialId: 1, storageBinId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      inventoryType: 'RAW_MATERIAL',
      storageBinId: { $type: 'objectId' },
      isDeleted: false,
    },
  },
);

// Finished goods — one balance row per SKU per factory
inventoryBalanceSchema.index(
  { factoryId: 1, skuId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      inventoryType: 'FINISHED_GOODS',
      skuId: { $exists: true },
      isDeleted: false,
    },
  },
);

export const InventoryBalance = mongoose.model('InventoryBalance', inventoryBalanceSchema);
