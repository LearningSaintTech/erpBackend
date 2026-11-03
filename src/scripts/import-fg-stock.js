/**
 * Load opening finished-goods stock from the store's inventory sheet.
 *
 *   node src/scripts/import-fg-stock.js --uri="mongodb+srv://…/erpBackend" \
 *     --stock="INVENTORY SHEET.xlsx" --split="Untitled spreadsheet.xlsx" [--report=fg-import-report.csv] [--apply]
 *
 * Dry run by default (writes nothing). Never reads .env — pass the database explicitly.
 *
 * Stock sheet ("Stock"): a product row (STYLE CODE, SKU NUMBER, PRODUCT NAME, XS…XXXL, TOTAL) followed by a
 * "RACK NO" row with each size's location (R-25-S-4). "Remark" rows (and their own RACK NO row) are extra notes.
 * Split sheet: STYLE, PRODUCT, SIZE, STOCK, RACK NO. — the quantity per shelf for sizes kept on two shelves.
 *
 * What is loaded / skipped (agreed with the store, 3 Nov 2026):
 *  - Skipped: rows with no style code, the KHP091 and KHP065 code clashes, DEAD STOCK, every Remark row's stock
 *    (IN RAYON, "(In Red)" …), sizes split over shelves unless the split sheet adds up and names the same shelves.
 *  - SKU code: the sheet's SKU number for that size when present, else STYLE-COLOUR-SIZE (or STYLE-SIZE).
 *  - Warehouse: a FINISHED_GOODS warehouse (FG-01, zone FG) with the racks R01…R48 × shelves S1…S5 the sheet uses;
 *    each shelf has its whole-shelf bin (R25-S4). Stock is posted per bin as an opening-stock receipt.
 *  - Refuses to load if any of these SKUs already has finished-goods stock (no double loading).
 */
import fs from 'fs';
import mongoose from 'mongoose';
import ExcelJS from 'exceljs';
import { Warehouse } from '../modules/warehouse/warehouse.model.js';
import { Zone } from '../modules/warehouse/zone.model.js';
import { Rack } from '../modules/warehouse/rack.model.js';
import { Shelf } from '../modules/warehouse/shelf.model.js';
import { StorageBin } from '../modules/warehouse/storageBin.model.js';
import { Sku } from '../modules/sku/sku.model.js';
import { Factory } from '../modules/organization/factory.model.js';
import { User } from '../modules/user/user.model.js';
import { InventoryBalance } from '../modules/inventory/inventoryBalance.model.js';
import { ensureInventoryBalanceIndexes } from '../modules/inventory/inventoryStock.service.js';
import * as warehouseService from '../modules/warehouse/warehouse.service.js';
import * as warehouseExt from '../modules/warehouse/warehouseExtended.service.js';
import * as inventoryService from '../modules/inventory/inventory.service.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.length ? v.join('=') : true];
}));
const uri = args.uri || process.env.IMPORT_URI;
if (!uri || !args.stock) {
  console.error('Usage: --uri=… --stock=<inventory sheet.xlsx> [--split=<split sheet.xlsx>] [--report=out.csv] [--apply]  (never reads .env)');
  process.exit(1);
}
const APPLY = args.apply === true;
const WH_CODE = args.warehouse || 'FG-01';
const ZONE_CODE = args.zone || 'FG';
const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'];
const SKIP_CODES = new Set(['KHP091', 'KHP065', 'DEADSTOCK']);
const COLOURS = ['yellow', 'brown', 'black', 'red', 'white', 'blue', 'pink', 'purple', 'beige', 'green', 'maroon', 'mint', 'grey', 'gray',
  'olive', 'wine', 'navy', 'cream', 'ivory', 'orange', 'lilac', 'peach', 'mustard', 'sky blue', 'off white', 'denim', 'rust', 'khaki', 'teal', 'lavender'];

const text = (v) => {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((r) => r.text).join('');
    if (v.text != null) return String(v.text);
    if (v.result != null) return String(v.result);
    if (v instanceof Date) return v.toISOString();
  }
  return String(v);
};
const num = (v) => {
  const t = typeof v === 'object' && v?.result != null ? v.result : v;
  const n = typeof t === 'number' ? t : Number(String(t ?? '').trim());
  return Number.isFinite(n) ? n : 0;
};
const norm = (s) => text(s).replace(/\s+/g, '').toUpperCase();
const slug = (s) => text(s).toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '');

/** "R-25-S-4", "R-26-S-3,S2", "R-24-S-5,R22-S5", "R-23-S-2-S-3" → [{rack:25, shelf:4}, …] */
function parseLocations(cell) {
  const out = []; let rack = null;
  for (const part of text(cell).split(',')) {
    const r = part.match(/R\s*-*\s*(\d+)/i);
    if (r) rack = Number(r[1]);
    const shelves = [...part.matchAll(/S\s*-*\s*(\d+)/gi)].map((m) => Number(m[1]));
    for (const s of shelves) if (rack) out.push({ rack, shelf: s });
  }
  return out;
}
const locKey = (l) => `R${l.rack}S${l.shelf}`;

function colourOf(name) {
  const paren = text(name).match(/\(([^)]+)\)\s*$/);
  if (paren) return paren[1].trim();
  const lower = ` ${text(name).toLowerCase()} `;
  return COLOURS.find((c) => lower.includes(` ${c} `)) || '';
}

/** The sheet's SKU number for one size, from the multi-line SKU NUMBER cell. */
function sheetSkuFor(cell, size) {
  const lines = text(cell).split(/\r?\n/).map((l) => l.trim().replace(/^["'`]+|["'`.\s]+$/g, '')).filter(Boolean);
  const want = size === 'XXL' ? ['XXL', '2XL'] : [size];
  return lines.find((l) => want.some((w) => l.toUpperCase().endsWith(`-${w}`))) || '';
}

async function readStockSheet(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet('Stock') || wb.worksheets[0];
  const header = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (c, i) => { header[i] = text(c.value).trim().toUpperCase(); });
  const col = (name) => header.findIndex((h) => h === name);
  const C = { style: col('STYLE CODE'), sku: col('SKU NUMBER'), name: col('PRODUCT NAME'), total: col('TOTAL') };
  SIZES.forEach((s) => { C[s] = col(s); });
  const products = []; let cur = null;
  for (let r = 2; r <= ws.rowCount; r += 1) {
    const row = ws.getRow(r);
    const v = (i) => (i > 0 ? row.getCell(i).value : null);
    const first = text(v(C.style)).trim().toUpperCase();
    const sizesRaw = SIZES.map((s) => v(C[s]));
    if (!first && !text(v(C.name)).trim() && sizesRaw.every((x) => !text(x).trim())) continue;
    if (first.startsWith('RACK')) {
      const locs = sizesRaw.map((x) => text(x).trim());
      if (cur && !cur.rackRow) { cur.locations = locs; cur.rackRow = r; } else if (cur?.remarks?.length && !cur.remarks.at(-1).locations) cur.remarks.at(-1).locations = locs;
      continue;
    }
    if (first.startsWith('REMARK')) {
      if (cur) cur.remarks.push({ row: r, text: [v(C.name), ...sizesRaw].map(text).filter(Boolean).join(' / ') });
      continue;
    }
    cur = {
      row: r, style: text(v(C.style)).trim(), skuCell: v(C.sku), name: text(v(C.name)).replace(/\s+/g, ' ').trim(),
      qty: sizesRaw.map(num), total: num(v(C.total)), locations: [], rackRow: null, remarks: [],
    };
    products.push(cur);
  }
  return products;
}

async function readSplitSheet(file) {
  if (!file) return new Map();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.worksheets[0];
  const groups = new Map();
  for (let r = 2; r <= ws.rowCount; r += 1) {
    const row = ws.getRow(r);
    const style = norm(row.getCell(1).value); const product = text(row.getCell(2).value);
    const size = text(row.getCell(3).value).trim().toUpperCase(); const qty = num(row.getCell(4).value);
    const loc = parseLocations(row.getCell(5).value)[0];
    if (!style || !size || !loc) continue;
    const key = `${style}|${size}|${product.toLowerCase().replace(/[^a-z]/g, '').replace(/dress$/, '')}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ row: r, qty, loc });
  }
  return groups;
}
function splitFor(groups, p, size) {
  const pk = p.name.toLowerCase().split('(')[0].replace(/[^a-z]/g, '').replace(/dress$/, '');
  for (const [key, items] of groups) {
    const [st, sz, prod] = key.split('|');
    if (st === norm(p.style) && sz === size && (prod.includes(pk) || pk.includes(prod))) return items;
  }
  return null;
}

async function main() {
  const products = await readStockSheet(args.stock);
  const splits = await readSplitSheet(args.split);

  const plan = []; const skipped = []; const skuCodes = new Map();
  const skip = (p, size, reason, qty = '') => skipped.push({ row: p.row, style: p.style, product: p.name, size, qty, reason });
  for (const p of products) {
    const code = norm(p.style);
    const productQty = p.qty.reduce((a, b) => a + b, 0);
    for (const r of p.remarks) if (/\d/.test(r.text)) skip(p, '', `remark stock not loaded: ${r.text}`);
    if (!productQty) continue;
    if (!code) { skip(p, '', 'no style code', productQty); continue; }
    if (SKIP_CODES.has(code)) { skip(p, '', `${code === 'DEADSTOCK' ? 'DEAD STOCK' : `code ${code} is shared by different products`} — waiting for the store`, productQty); continue; }
    SIZES.forEach((size, i) => {
      const qty = p.qty[i];
      if (qty <= 0) return;
      const locs = parseLocations(p.locations[i]);
      let parts;
      if (!locs.length) return skip(p, size, 'no location', qty);
      if (locs.length === 1) {
        const sp = splitFor(splits, p, size);
        if (sp && sp.length > 1) return skip(p, size, `stock sheet has one shelf (${p.locations[i]}) but the split sheet has ${sp.length}`, qty);
        parts = [{ loc: locs[0], qty }];
      } else {
        const sp = splitFor(splits, p, size);
        if (!sp) return skip(p, size, `kept on ${p.locations[i]} — quantity per shelf missing`, qty);
        const sum = sp.reduce((a, b) => a + b.qty, 0);
        const same = [...sp.map((x) => locKey(x.loc))].sort().join() === [...locs.map(locKey)].sort().join();
        if (sum !== qty || !same) return skip(p, size, `split sheet ${sp.map((x) => `${x.qty}@R${x.loc.rack}-S${x.loc.shelf}`).join(' + ')} = ${sum} does not match ${qty} @ ${p.locations[i]}`, qty);
        parts = sp.map((x) => ({ loc: x.loc, qty: x.qty }));
      }
      const colour = colourOf(p.name);
      const generated = [code, slug(colour), size].filter(Boolean).join('-');
      let skuCode = sheetSkuFor(p.skuCell, size);
      // A sheet SKU naming another variant (KHP024-S1… on the KHP024-S2 row) or already used by another row is a
      // copy-paste slip — use the generated code instead.
      const variant = skuCode.toUpperCase().match(/^(KHP\d+)(-F)?(-S\d+)/);
      if (skuCode && variant && `${variant[1]}${variant[3]}` !== code.replace(/-F(?=-S\d)/, '')) skuCode = '';
      if (skuCode && skuCodes.has(skuCode) && skuCodes.get(skuCode) !== `${p.row}`) skuCode = '';
      if (!skuCode) skuCode = generated;
      if (skuCodes.has(skuCode) && skuCodes.get(skuCode) !== `${p.row}`) skuCode = `${code}-${slug(p.name).slice(0, 24)}-${size}`;
      skuCodes.set(skuCode, `${p.row}`);
      plan.push({ row: p.row, style: code, name: p.name, size, colour, skuCode, parts, qty });
    });
  }

  await mongoose.connect(uri);
  const factories = await Factory.find({ isDeleted: { $ne: true } });
  const factory = args.factory ? factories.find((f) => f.code === args.factory) : (factories.length === 1 ? factories[0] : null);
  if (!factory) throw new Error(`Pass --factory=<code>; factories: ${factories.map((f) => f.code).join(', ')}`);
  const admin = await User.findOne({ organizationId: factory.organizationId, isDeleted: { $ne: true } }).sort({ createdAt: 1 });
  const base = { factoryId: factory._id, organizationId: factory.organizationId };
  const userId = admin?._id;

  const existingSkus = await Sku.find({ ...base, skuCode: { $in: plan.map((x) => x.skuCode) }, isDeleted: { $ne: true } });
  const skuIds = existingSkus.map((s) => s._id);
  const alreadyStocked = skuIds.length ? await InventoryBalance.countDocuments({ factoryId: factory._id, skuId: { $in: skuIds }, inventoryType: 'FINISHED_GOODS', onHand: { $gt: 0 }, isDeleted: false }) : 0;
  const racksNeeded = new Map();
  for (const x of plan) for (const pt of x.parts) racksNeeded.set(pt.loc.rack, Math.max(racksNeeded.get(pt.loc.rack) || 0, pt.loc.shelf));
  const maxRack = Math.max(...racksNeeded.keys()); const maxShelf = Math.max(...racksNeeded.values());

  const pieces = plan.reduce((a, b) => a + b.qty, 0);
  const sheetPieces = products.reduce((a, p) => a + p.qty.reduce((x, y) => x + y, 0), 0);
  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN (nothing is written)'} — factory ${factory.name || factory.code}`);
  console.log(`  warehouse ${WH_CODE} / zone ${ZONE_CODE}: racks R01–R${String(maxRack).padStart(2, '0')} × shelves S1–S${maxShelf} (whole-shelf bins)`);
  console.log(`  SKUs to create: ${plan.length - existingSkus.length} (already exist: ${existingSkus.length})`);
  console.log(`  stock rows (SKU × bin): ${plan.reduce((a, b) => a + b.parts.length, 0)}; pieces to load: ${pieces} of ${sheetPieces} in the sheet`);
  console.log(`  skipped: ${skipped.length} item(s), ${skipped.reduce((a, b) => a + (Number(b.qty) || 0), 0)} pieces`);
  if (alreadyStocked) console.log(`  !! ${alreadyStocked} finished-goods stock rows already exist for these SKUs — refusing to load again`);
  if (args.report) {
    const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const lines = ['status,row,style,product,size,qty,sku,bins,reason'];
    for (const x of plan) lines.push(['LOAD', x.row, x.style, x.name, x.size, x.qty, x.skuCode, x.parts.map((pt) => `${pt.qty}@R${String(pt.loc.rack).padStart(2, '0')}-S${pt.loc.shelf}`).join(' + '), ''].map(esc).join(','));
    for (const s of skipped) lines.push(['SKIP', s.row, s.style, s.product, s.size, s.qty, '', '', s.reason].map(esc).join(','));
    fs.writeFileSync(args.report, lines.join('\n'));
    console.log(`  report: ${args.report}`);
  }
  if (!APPLY || alreadyStocked) {
    console.log(APPLY ? '\nNothing written.' : '\nNothing written. Re-run with --apply to load.');
    await mongoose.disconnect();
    return;
  }

  // One SKU per bin row needs the multi-bin FG index (drops the old one-row-per-SKU index).
  await ensureInventoryBalanceIndexes();

  let wh = await Warehouse.findOne({ ...base, warehouseCode: WH_CODE, isDeleted: { $ne: true } });
  if (!wh) {
    const hasDefaultFg = await Warehouse.exists({ ...base, type: 'FINISHED_GOODS', isDefault: true, isDeleted: { $ne: true } });
    wh = await warehouseService.createWarehouse({ ...base, warehouseCode: WH_CODE, name: 'Finished Goods Store', type: 'FINISHED_GOODS', isDefault: !hasDefaultFg }, userId);
  }
  let zone = await Zone.findOne({ ...base, warehouseId: wh._id, zoneCode: ZONE_CODE, isDeleted: { $ne: true } });
  if (!zone) zone = await warehouseExt.createZone({ ...base, warehouseId: wh._id, zoneCode: ZONE_CODE, name: 'Finished goods' }, userId);
  const binByLoc = new Map();
  for (let r = 1; r <= maxRack; r += 1) {
    const rackCode = `R${String(r).padStart(2, '0')}`;
    let rack = await Rack.findOne({ ...base, zoneId: zone._id, rackCode, isDeleted: { $ne: true } });
    if (!rack) rack = await warehouseExt.createRack({ ...base, zoneId: zone._id, rackCode, name: `Rack ${rackCode}` }, userId);
    for (let s = 1; s <= maxShelf; s += 1) {
      const shelfCode = `${rackCode}-S${s}`;
      let shelf = await Shelf.findOne({ ...base, rackId: rack._id, shelfCode, isDeleted: { $ne: true } });
      if (!shelf) { await warehouseExt.createShelf({ ...base, rackId: rack._id, shelfCode }, userId); shelf = await Shelf.findOne({ ...base, rackId: rack._id, shelfCode }); }
      let bin = await StorageBin.findOne({ ...base, shelfId: shelf._id, isShelfBin: true, isDeleted: { $ne: true } });
      if (!bin) bin = await warehouseExt.ensureShelfBin(shelf, rack, userId);
      binByLoc.set(`R${r}S${s}`, bin);
    }
  }

  let created = 0; let rows = 0;
  for (const x of plan) {
    let sku = await Sku.findOne({ ...base, skuCode: x.skuCode, isDeleted: { $ne: true } });
    if (!sku) {
      sku = await Sku.create({ ...base, skuCode: x.skuCode, name: x.name, size: x.size, ...(x.colour ? { color: { name: x.colour } } : {}), status: 'ACTIVE', createdBy: userId, updatedBy: userId });
      created += 1;
    }
    for (const pt of x.parts) {
      const bin = binByLoc.get(locKey(pt.loc));
      await inventoryService.receiptFinishedGoods({
        ...base, skuId: sku._id, quantity: pt.qty, locationId: wh._id, storageBinId: bin._id, userId, referenceType: 'OPENING_STOCK',
      });
      rows += 1;
    }
  }
  console.log(`\nDone: ${created} SKUs created, ${rows} stock rows posted, ${pieces} pieces in ${WH_CODE}.`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('Import failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
