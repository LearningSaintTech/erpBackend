const fs = require('fs');
const p = 'c:/Users/PushkarLS68/erpFactory/backend/src/modules/design/design.routes.js';
let s = fs.readFileSync(p, 'utf8');
if (!s.includes('sizes: Joi.array')) {
  s = s.replace(
    /availableQty: Joi\.number\(\)\.min\(0\)\.allow\(null\),\r?\n\}\);/,
    `availableQty: Joi.number().min(0).allow(null),
  sizes: Joi.array().items(Joi.object({
    size: Joi.string().required(),
    sku: Joi.string().allow(''),
  })),
});`
  );
  fs.writeFileSync(p, s);
}
console.log('sizes', s.includes('sizes: Joi.array'));
