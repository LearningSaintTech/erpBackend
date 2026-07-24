const fs = require('fs');
const p = 'c:/Users/PushkarLS68/erpFactory/frontend/src/types/api.ts';
let s = fs.readFileSync(p, 'utf8');
if (!s.includes('sizes?:')) {
  s = s.replace(
    '  availableQty?: number;\n}\n\nexport interface FabricConsumption',
    '  availableQty?: number;\n  sizes?: { size: string; sku?: string }[];\n}\n\nexport interface FabricConsumption'
  );
}
if (!s.includes('code?: string;\n  name: string;\n}')) {
  s = s.replace(
    'export interface DesignCollection {\n  _id: string;\n  name: string;\n}',
    'export interface DesignCollection {\n  _id: string;\n  code?: string;\n  name: string;\n}'
  );
}
fs.writeFileSync(p, s);
console.log('fixed types', s.includes('sizes?:'));
