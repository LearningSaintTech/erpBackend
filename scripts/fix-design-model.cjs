const fs = require('fs');
const p = 'c:/Users/PushkarLS68/erpFactory/backend/src/modules/design/design.model.js';
let s = fs.readFileSync(p, 'utf8');
s = s.replace(/designSchema\.index\(\{ factoryId: 1, collectionId: 1, styleNumber: 1 \}, \{ unique: true, sparse: true \}\);\s*/g, '');
if (!s.includes('styleNumber: String')) {
  const insert = `  skuPrefix: String,
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
  title:`;
  s = s.replace(/  skuPrefix: String,\s+title:/, insert);
}
if (!s.includes('code: String')) {
  s = s.replace('  ...tenantFields,\n  name: { type: String, required: true },', '  ...tenantFields,\n  code: String,\n  name: { type: String, required: true },');
}
if (!s.includes('collectionId: 1, styleNumber: 1')) {
  s = s.replace('designSchema.index({ tags: 1 });', `designSchema.index({ tags: 1 });
designSchema.index({ factoryId: 1, collectionId: 1, styleNumber: 1 }, { unique: true, sparse: true });`);
}
fs.writeFileSync(p, s);
console.log('fixed', s.includes('styleNumber: String'));
