const fs = require('fs');
const p = 'c:/Users/PushkarLS68/erpFactory/backend/src/modules/design/design.routes.js';
let s = fs.readFileSync(p, 'utf8');
if (!s.includes('collectionId: req.query.collectionId')) {
  s = s.replace(
    '      category: req.query.category,\n      tags: req.query.tags,',
    '      category: req.query.category,\n      collectionId: req.query.collectionId,\n      tags: req.query.tags,'
  );
  fs.writeFileSync(p, s);
}
console.log('ok');
