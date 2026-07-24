import mongoose from 'mongoose';

const segmentSchema = new mongoose.Schema({
  key: { type: String, required: true },
  optional: { type: Boolean, default: false },
}, { _id: false });

const skuFormulaConfigSchema = new mongoose.Schema({
  name: { type: String, required: true },
  isActive: { type: Boolean, default: false, index: true },
  skuSegmentOrder: [segmentSchema],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

export const SkuFormulaConfig = mongoose.model('SkuFormulaConfig', skuFormulaConfigSchema);

export const DEFAULT_SKU_SEGMENT_ORDER = [
  { key: 'styleGender', optional: false },
  { key: 'productType', optional: false },
  { key: 'fitType', optional: false },
  { key: 'colour', optional: false },
  { key: 'size', optional: false },
  { key: 'skuUid', optional: true },
];
