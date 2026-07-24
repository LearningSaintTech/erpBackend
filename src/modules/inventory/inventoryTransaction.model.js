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
  unit: String,
  referenceType: String,
  referenceId: mongoose.Schema.Types.ObjectId,
  performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  ...auditFields,
});

export const InventoryTransaction = mongoose.model('InventoryTransaction', inventoryTransactionSchema);
