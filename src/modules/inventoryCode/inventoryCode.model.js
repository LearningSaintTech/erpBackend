import mongoose from 'mongoose';

const INVENTORY_CODE_TYPES = ['CATEGORY', 'FIT', 'COLOR', 'SECTION'];

const inventoryCodeSchema = new mongoose.Schema({
  type: { type: String, enum: INVENTORY_CODE_TYPES, required: true, index: true },
  code: { type: String, required: true, trim: true },
  name: { type: String, required: true, trim: true },
  sortOrder: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
  remarks: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

inventoryCodeSchema.index({ type: 1, code: 1 }, { unique: true });
inventoryCodeSchema.index({ type: 1, name: 1 });

export const INVENTORY_CODE_TYPE_LIST = INVENTORY_CODE_TYPES;
export const InventoryCode = mongoose.model('InventoryCode', inventoryCodeSchema);
