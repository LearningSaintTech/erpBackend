const fs = require('fs');
const p = 'c:/Users/PushkarLS68/erpFactory/frontend/src/types/api.ts';
let s = fs.readFileSync(p, 'utf8');
s = s.replace(
  /(export interface ColorVariant \{[\s\S]*?availableQty\?: number;)\r?\n\}/,
  '$1\n  sizes?: { size: string; sku?: string }[];\n}'
);
s = s.replace(
  /export interface DesignCollection \{\r?\n  _id: string;\r?\n  name: string;\r?\n\}/,
  'export interface DesignCollection {\n  _id: string;\n  code?: string;\n  name: string;\n}'
);
fs.writeFileSync(p, s);
console.log('sizes', /sizes\?:/.test(s));
