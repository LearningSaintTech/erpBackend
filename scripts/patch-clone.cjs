const fs = require('fs');
const p = 'c:/Users/PushkarLS68/erpFactory/backend/src/modules/design/design.service.js';
let s = fs.readFileSync(p, 'utf8');
s = s.replace(
  `.populate('collectionId', 'name')\n    .populate('seasonId', 'name year')\n    .populate('sizeChartId')`,
  `.populate('collectionId', 'name code')\n    .populate('seasonId', 'name year')\n    .populate('sizeChartId')`
);
if (!s.includes('styleNumber: undefined')) {
  s = s.replace(
    `    title: \`\${source.title} (Copy)\`,
    status: 'DRAFT',`,
    `    title: \`\${source.title} (Copy)\`,
    styleNumber: undefined,
    skuCodeInputs: undefined,
    colorVariants: (snap.colorVariants || []).map((v) => ({
      ...v,
      sizes: (v.sizes || []).map((row) => ({ size: row.size, sku: '' })),
    })),
    status: 'DRAFT',`
  );
}
fs.writeFileSync(p, s);
console.log('clone patched');
