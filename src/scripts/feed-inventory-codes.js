/**
 * Upsert the full inventory-code catalog (existing seed + new designer types).
 * Usage: node src/scripts/feed-inventory-codes.js
 */
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import { connectDatabase } from '../config/database.js';
import { seedInventoryCodesFromFile, seedSkuFormulaConfig } from '../modules/inventoryCode/inventoryCode.service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const seedPath = join(__dirname, '../data/inventoryCodes.seed.json');

function row(type, code, name, sortOrder) {
  return { type, code, name, sortOrder, isActive: true, remarks: '' };
}

const EXTRA = [
  ...[
    ['FORMAL', 'Formal'], ['CASUAL', 'Casual'], ['PARTY', 'Party'], ['ETHNIC', 'Ethnic'],
    ['WESTERN', 'Western'], ['SPORTS', 'Sportswear'], ['LOUNGE', 'Lounge'], ['RESORT', 'Resort'],
    ['WORK', 'Workwear'], ['BRIDAL', 'Bridal'],
  ].map(([code, name], i) => row('SUB_CATEGORY', code, name, i + 1)),

  ...['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', '28', '30', '32', '34', '36', '38', '40', '42', 'FREE']
    .map((code, i) => row('SIZE', code, code === 'FREE' ? 'Free size' : code, i + 1)),

  ...[
    ['MEN', 'Men'], ['WOMEN', 'Women'], ['UNISEX', 'Unisex'],
    ['BOYS', 'Boys'], ['GIRLS', 'Girls'], ['KIDS', 'Kids'],
  ].map(([code, name], i) => row('GENDER', code, name, i + 1)),

  ...[
    ['INFANT', 'Infant'], ['TODDLER', 'Toddler'], ['KIDS', 'Kids'],
    ['TEEN', 'Teen'], ['ADULT', 'Adult'], ['SENIOR', 'Senior'],
  ].map(([code, name], i) => row('AGE_GROUP', code, name, i + 1)),

  ...[
    ['FULL', 'Full sleeve'], ['HALF', 'Half sleeve'], ['34', 'Three-quarter'],
    ['SLVLS', 'Sleeveless'], ['CAP', 'Cap sleeve'], ['BELL', 'Bell sleeve'], ['PUFF', 'Puff sleeve'],
  ].map(([code, name], i) => row('SLEEVE', code, name, i + 1)),

  ...[
    ['ROUND', 'Round neck'], ['V', 'V-neck'], ['COLLAR', 'Collar'], ['MAND', 'Mandarin'],
    ['HALTER', 'Halter'], ['BOAT', 'Boat neck'], ['TURTLE', 'Turtle neck'], ['SQUARE', 'Square neck'],
  ].map(([code, name], i) => row('NECK', code, name, i + 1)),

  ...[
    ['SOLID', 'Solid'], ['STRIPE', 'Stripe'], ['CHECK', 'Check'], ['PRINT', 'Print'],
    ['FLORAL', 'Floral'], ['ABSTRACT', 'Abstract'], ['EMB', 'Embroidered'],
  ].map(([code, name], i) => row('PATTERN', code, name, i + 1)),

  ...[
    ['CASUAL', 'Casual'], ['FORMAL', 'Formal'], ['PARTY', 'Party'], ['FESTIVE', 'Festive'],
    ['WORK', 'Work'], ['WEDDING', 'Wedding'], ['RESORT', 'Resort'],
  ].map(([code, name], i) => row('OCCASION', code, name, i + 1)),

  ...[
    ['CTN', 'Cotton'], ['POLY', 'Polyester'], ['LINEN', 'Linen'], ['SILK', 'Silk'],
    ['WOOL', 'Wool'], ['DENIM', 'Denim'], ['VIS', 'Viscose'], ['RAYON', 'Rayon'],
    ['NYL', 'Nylon'], ['BLEND', 'Blend'],
  ].map(([code, name], i) => row('MATERIAL', code, name, i + 1)),

  ...[
    ['SCREEN', 'Screen print'], ['DIGITAL', 'Digital print'], ['BLOCK', 'Block print'],
    ['EMB', 'Embroidery'], ['SUB', 'Sublimation'], ['FOIL', 'Foil'], ['NONE', 'None'],
  ].map(([code, name], i) => row('PRINTING_TYPE', code, name, i + 1)),

  ...[
    ['SUMMER', 'Summer'], ['PREM', 'Premium'], ['COTTON', 'Cotton'], ['EXPORT', 'Export'],
    ['KIDS', 'Kids'], ['FORMAL', 'Formal'], ['CASUAL', 'Casual'], ['WINTER', 'Winter'],
    ['ECO', 'Eco'], ['LTD', 'Limited'],
  ].map(([code, name], i) => row('TAG', code, name, i + 1)),

  ...[
    ['INR', 'INR'], ['USD', 'USD'], ['EUR', 'EUR'], ['GBP', 'GBP'], ['AED', 'AED'],
  ].map(([code, name], i) => row('CURRENCY', code, name, i + 1)),

  ...[
    ['SS26', 'Spring Summer 2026'], ['AW26', 'Autumn Winter 2026'],
    ['CORE', 'Core'], ['ESS', 'Essentials'], ['HOL', 'Holiday'],
  ].map(([code, name], i) => row('COLLECTION', code, name, i + 1)),

  ...[
    ['SUMMER', 'Summer'], ['WINTER', 'Winter'], ['SPRING', 'Spring'],
    ['AUTUMN', 'Autumn'], ['MONSOON', 'Monsoon'], ['RESORT', 'Resort'],
  ].map(([code, name], i) => row('SEASON', code, name, i + 1)),

  ...[
    ['CM', 'cm'], ['IN', 'in'], ['M', 'm'], ['YD', 'Yard'],
    ['PC', 'pc'], ['PIECES', 'Pieces'], ['METERS', 'Meters'],
    ['KG', 'kg'], ['CONE', 'Cone'],
  ].map(([code, name], i) => row('UNIT', code, name, i + 1)),

  ...[
    ['BUTTON', 'Button'], ['ZIPPER', 'Zipper'], ['LABEL', 'Label'], ['THREAD', 'Thread'],
    ['ELASTIC', 'Elastic'], ['HOOK', 'Hook'], ['TAG', 'Hangtag'], ['OTHER', 'Other'],
  ].map(([code, name], i) => row('ACCESSORY', code, name, i + 1)),

  ...[
    ['BIO', 'Bio wash'], ['ENZYME', 'Enzyme'], ['PEACH', 'Peach'],
    ['MERC', 'Mercerized'], ['NONE', 'None'],
  ].map(([code, name], i) => row('FABRIC_FINISH', code, name, i + 1)),

  ...[
    ['FABRIC', 'Fabric'], ['TRIM', 'Trim'], ['PACKING', 'Packing'],
    ['THREAD', 'Thread'], ['INTERLINING', 'Interlining'],
  ].map(([code, name], i) => row('MATERIAL_GROUP', code, name, i + 1)),

  ...[
    ['CHEST', 'Chest'], ['WAIST', 'Waist'], ['HIP', 'Hip'], ['SHOULDER', 'Shoulder'],
    ['SLEEVE', 'Sleeve'], ['LENGTH', 'Length'], ['NECK', 'Neck'], ['INSEAM', 'Inseam'],
  ].map(([code, name], i) => row('MEASUREMENT', code, name, i + 1)),

  ...[
    ['SNL', 'Single needle'], ['DBL', 'Double needle'], ['OVL', 'Overlock'], ['CVR', 'Coverstitch'],
  ].map(([code, name], i) => row('STITCH', code, name, i + 1)),

  ...[
    ['N9', 'Needle 9'], ['N11', 'Needle 11'], ['N14', 'Needle 14'], ['N16', 'Needle 16'],
  ].map(([code, name], i) => row('NEEDLE', code, name, i + 1)),

  ...[
    ['LOCK', 'Lockstitch'], ['OVERLOCK', 'Overlock'], ['FLATLOCK', 'Flatlock'], ['BH', 'Buttonhole'],
  ].map(([code, name], i) => row('MACHINE', code, name, i + 1)),
];

function mergeSeed() {
  const existing = JSON.parse(readFileSync(seedPath, 'utf8'));
  const keys = new Set(existing.map((r) => `${r.type}::${r.code}`));
  let added = 0;
  for (const row of EXTRA) {
    const key = `${row.type}::${row.code}`;
    if (keys.has(key)) continue;
    existing.push(row);
    keys.add(key);
    added += 1;
  }
  writeFileSync(seedPath, `${JSON.stringify(existing, null, 2)}\n`);
  return { total: existing.length, added };
}

async function feed() {
  const merged = mergeSeed();
  console.log(`Seed file: ${merged.total} rows (${merged.added} new types appended)`);
  await connectDatabase();
  const count = await seedInventoryCodesFromFile();
  await seedSkuFormulaConfig();
  const byType = await mongoose.connection.db.collection('inventorycodes').aggregate([
    { $group: { _id: '$type', n: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]).toArray();
  console.log(`Upserted ${count} inventory codes`);
  for (const t of byType) console.log(`  ${t._id.padEnd(16)} ${t.n}`);
  await mongoose.disconnect();
}

feed().catch((err) => {
  console.error(err);
  process.exit(1);
});
