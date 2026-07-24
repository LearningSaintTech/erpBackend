import mongoose from 'mongoose';
import { tenantFields, auditFields } from '../../shared/utils/schema.js';
import { DESIGN_ASSET_TYPES } from '../../config/designLookups.js';

const designAssetSchema = new mongoose.Schema({
  ...tenantFields,
  designId: { type: mongoose.Schema.Types.ObjectId, ref: 'Design', required: true, index: true },
  assetType: { type: String, enum: DESIGN_ASSET_TYPES, required: true },
  fileName: { type: String, required: true },
  mimeType: String,
  sizeBytes: Number,
  url: { type: String, required: true },
  ...auditFields,
});

export const DesignAsset = mongoose.model('DesignAsset', designAssetSchema);
