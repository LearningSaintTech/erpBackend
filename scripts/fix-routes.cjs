const fs = require('fs');
const p = 'c:/Users/PushkarLS68/erpFactory/backend/src/modules/design/design.routes.js';
let s = fs.readFileSync(p, 'utf8');
if (!s.includes('styleNumber')) {
  s = s.replace(
    "  skuPrefix: Joi.string().allow(''),",
    "  skuPrefix: Joi.string().allow(''),\n  styleNumber: Joi.string().allow(''),"
  );
  fs.writeFileSync(p, s);
}
console.log('styleNumber', s.includes('styleNumber'));
