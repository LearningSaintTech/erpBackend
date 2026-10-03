import mongoose from 'mongoose';
import { tenantFields, auditFields } from '../../shared/utils/schema.js';

const materialSchema = new mongoose.Schema({
  ...tenantFields,
  materialCode: { type: String, required: true },
  name: { type: String, required: true },
  category: {
    type: String,
    enum: ['FABRIC', 'THREAD', 'BUTTON', 'LABEL', 'ZIPPER', 'PACKAGING', 'ACCESSORY', 'OTHER'],
    default: 'FABRIC',
  },
  unit: { type: String, enum: ['METERS', 'YARDS', 'PIECES', 'CONES', 'KG'], default: 'METERS' },
  unitCost: { type: Number, default: 0 },
  reorderLevel: { type: Number, default: 0 },
  supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier' },
  images: [{
    url: { type: String, required: true },
    fileName: { type: String, default: '' },
  }],
  ...auditFields,
});

materialSchema.index({ factoryId: 1, materialCode: 1 }, { unique: true });

export const Material = mongoose.model('Material', materialSchema);
