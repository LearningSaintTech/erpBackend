const fs = require('fs');
const p = 'c:/Users/PushkarLS68/erpFactory/backend/src/modules/design/design.model.js';
let s = fs.readFileSync(p, 'utf8');
s = s.replace(
  '  name: { type: String, required: true },\n  description: String,',
  '  code: String,\n  name: { type: String, required: true },\n  description: String,'
);
s = s.replace(
  '  availableQty: Number,\n};',
  '  availableQty: Number,\n  skuCodeInputs: { colour: String },\n  sizes: [{ size: String, sku: String }],\n};'
);
s = s.replace(
  '  skuPrefix: String,\n  title:',
  `  skuPrefix: String,
  styleNumber: String,
  skuCodeInputs: {
    styleNu: String,
    gender: String,
    styleGender: String,
    productType: String,
    productTypeCode: String,
    fitType: String,
    collectionId: { type: mongoose.Schema.Types.ObjectId, ref: 'DesignCollection' },
  },
  title:`
);
s = s.replace(
  'designSchema.index({ tags: 1 });',
  `designSchema.index({ tags: 1 });
designSchema.index({ factoryId: 1, collectionId: 1, styleNumber: 1 }, { unique: true, sparse: true });`
);
fs.writeFileSync(p, s);
console.log('design.model patched');
