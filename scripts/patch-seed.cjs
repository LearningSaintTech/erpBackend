const fs = require('fs');
const p = 'c:/Users/PushkarLS68/erpFactory/backend/src/scripts/seed.js';
let s = fs.readFileSync(p, 'utf8');
if (!s.includes('seedInventoryCodesFromFile')) {
  s = s.replace(
    "} from '../config/systemRoles.js';",
    `} from '../config/systemRoles.js';
import { seedInventoryCodesFromFile, seedSkuFormulaConfig } from '../modules/inventoryCode/inventoryCode.service.js';`
  );
  s = s.replace(
    'async function runSeed() {\n  await seedPermissions();',
    `async function runSeed() {\n  await seedPermissions();\n  const codeCount = await seedInventoryCodesFromFile();\n  console.log(\`Seeded \${codeCount} inventory codes\`);\n  await seedSkuFormulaConfig();\n  console.log('Seeded SKU formula config');`
  );
  fs.writeFileSync(p, s);
  console.log('seed patched');
}
