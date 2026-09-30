/**
 * Import the Khush Pehno fabric sheet into material master + opening stock.
 * Usage: node src/scripts/feed-raw-materials.js
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import { connectDatabase } from '../config/database.js';
import { Factory } from '../modules/organization/factory.model.js';
import { User } from '../modules/user/user.model.js';
import { Supplier } from '../modules/purchase/supplier.model.js';
import { applySoftDeleteFilter } from '../shared/utils/schema.js';
import { bulkImportMaterials } from '../modules/inventory/inventory.service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const csvPath = join(__dirname, '../data/raw-materials.sheet.csv');
const csvPath2 = join(__dirname, '../data/raw-materials.sheet2.csv');

const UNIT_MAP = {
  m: 'METERS',
  meter: 'METERS',
  meters: 'METERS',
  kg: 'KG',
  kilo: 'KG',
  yard: 'YARDS',
  yards: 'YARDS',
};

const VENDOR_MAP = {
  'sharma brothers': { code: 'V-SHARMA', name: 'Sharma Brothers' },
  surplus: { code: 'V-SURPLUS', name: 'Surplus' },
  'gandhi nagar agrwal textliles': { code: 'V-GN-AGG', name: 'Gandhi Nagar Aggarwal Textiles' },
  'aggrawal textiles': { code: 'V-AGGARWAL', name: 'Aggarwal Textiles' },
  'darshani enterprises': { code: 'V-DARSHANI', name: 'Darshani Enterprises' },
  'dharsani enterprise': { code: 'V-DARSHANI', name: 'Darshani Enterprises' },
  'gmr hoisery': { code: 'V-GMR', name: 'GMR Hosiery' },
  'geeta textfare': { code: 'V-GEETA', name: 'Geeta Textfare' },
  'gandhi nagar': { code: 'V-GN', name: 'Gandhi Nagar' },
  'vikas textiles': { code: 'V-VIKAS', name: 'Vikas Textiles' },
  'amit impex': { code: 'V-AMIT', name: 'Amit Impex' },
};

function parseCsv(text) {
  return text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length)
    .map(parseCsvLine);
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

function numbers(text) {
  return [...String(text || '').replace(/,/g, '').matchAll(/(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
}

function mapUnit(raw) {
  const key = String(raw || '').toLowerCase().replace(/[^a-z]/g, '');
  return UNIT_MAP[key] || 'METERS';
}

function parseRate(text) {
  const nums = numbers(text);
  return nums[0] || 0;
}

function parseKgQty(text) {
  const s = String(text || '').toLowerCase().replace(/,/g, ' ');
  const kgG = s.match(/(\d+(?:\.\d+)?)\s*kg\s*(\d+(?:\.\d+)?)\s*g/);
  if (kgG) return Number(kgG[1]) + Number(kgG[2]) / 1000;
  const kgDec = s.match(/(\d+(?:\.\d+)?)\s*kg\s*(\d{2,3})\b/);
  if (kgDec) return Number(kgDec[1]) + Number(kgDec[2]) / 1000;
  const nums = numbers(s);
  if (!nums.length) return 0;
  let q = nums[0];
  if (q >= 1000) q /= 1000;
  return Math.round(q * 1000) / 1000;
}

function parseQty(text, unit) {
  if (unit === 'KG') return parseKgQty(text);
  const nums = numbers(text);
  if (!nums.length) return 0;
  return nums[0];
}

function accessoryCategory(name) {
  const n = String(name || '').toLowerCase();
  if (/zip/.test(n)) return 'ZIPPER';
  if (/button/.test(n)) return 'BUTTON';
  if (/label|sticker|tag|patch/.test(n)) return 'LABEL';
  if (/thread|cone/.test(n)) return 'THREAD';
  if (/polybag|paper|hanger/.test(n)) return 'PACKAGING';
  return 'ACCESSORY';
}

function accessoryUnit(name, qtyText) {
  const blob = `${name} ${qtyText}`.toLowerCase();
  if (/cone/.test(blob)) return 'CONES';
  return 'PIECES';
}

function parseAccessoryQty(text) {
  const s = String(text || '').toLowerCase().trim();
  if (!s) return 0;
  if (/mm/.test(s) && !/\d+\s*(pic|pc|pcs|box|packet|roll|pack)/.test(s)) return 1;
  const mul = s.match(/(\d+(?:\.\d+)?)\s*\*\s*(\d+(?:\.\d+)?)/);
  if (mul) return Number(mul[1]) * Number(mul[2]);
  if (/^1\s*\/\s*2$/.test(s) || s === '1/2') return 0.5;
  const nums = numbers(s);
  return nums[0] || 0;
}

function parseOpening(length, requirement, unit) {
  const req = String(requirement || '').toLowerCase().trim();
  const len = String(length || '').toLowerCase();
  const reqNums = numbers(req);
  const availableWord = /avail|avaial|\bav\b/.test(req);

  if (reqNums.length) return parseQty(req, unit);

  const stock = len.match(/(\d+(?:\.\d+)?)\s*(m|kg|g)?\s*stock/);
  if (stock) return parseQty(stock[0], unit);

  if (req === 'nr' || req === 'used' || /\bused\b/.test(req)) return 0;

  if (availableWord) {
    if (len.includes('/')) {
      const ns = numbers(len);
      if (ns.length >= 2) return ns[ns.length - 1];
    }
    return parseQty(len, unit);
  }

  if (/\bused\b/.test(len) && !/stock/.test(len)) return 0;
  return parseQty(len, unit);
}

function titleName(name) {
  return String(name)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bGhigham\b/i, 'Gingham')
    .replace(/\bGhignam\b/i, 'Gingham')
    .replace(/\bGhugham\b/i, 'Gingham')
    .replace(/\bGignam\b/i, 'Gingham')
    .replace(/\bEmboidery\b/i, 'Embroidery')
    .replace(/\bCamric\b/i, 'Cambric')
    .replace(/\bSefli\b/i, 'Selfi')
    .replace(/\bColr\b/i, 'Color')
    .replace(/\bMarron\b/i, 'Maroon')
    .replace(/\bStripw\b/i, 'Stripe')
    .replace(/\bLiaca\b/i, 'Lycra')
    .replace(/\bChine\b/i, 'Chiffon')
    .replace(/\bCreem\b/i, 'Cream')
    .replace(/\bCofee\b/i, 'Coffee')
    .replace(/\bCrape\b/i, 'Crepe')
    .replace(/\bBiscos\b/i, 'Viscose')
    .replace(/\bChamose\b/i, 'Chamois')
    .replace(/\bVoil\b/i, 'Voile')
    .replace(/\bAsharfi\b/i, 'Asharfi');
}

function vendorOf(raw) {
  const key = String(raw || '').trim().toLowerCase();
  if (!key || key === 'fabric' || key === '/') return null;
  return VENDOR_MAP[key] || {
    code: `V-${key.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').toUpperCase().slice(0, 18)}`,
    name: titleName(raw),
  };
}

function parseFabricRows() {
  const table = parseCsv(readFileSync(csvPath, 'utf8'));
  const header = table[0].map((h) => h.toLowerCase());
  const idx = (name) => header.findIndex((h) => h === name);
  const iName = idx('fabric');
  const iLen = idx('length');
  const iRate = idx('rate');
  const iReq = idx('requirement');
  const iVendor = idx('vendor');
  const iUnit = idx('unit of measurement');

  const seen = new Map();
  const items = [];
  let n = 0;

  for (const row of table.slice(1)) {
    const rawName = row[iName];
    if (!rawName) continue;
    n += 1;
    const unit = mapUnit(row[iUnit]);
    let name = titleName(rawName);
    const count = (seen.get(name.toLowerCase()) || 0) + 1;
    seen.set(name.toLowerCase(), count);
    if (count > 1) name = `${name} (${count})`;

    const vendor = vendorOf(row[iVendor]);
    items.push({
      materialCode: `FAB-${String(n).padStart(3, '0')}`,
      name,
      category: 'FABRIC',
      unit,
      unitCost: parseRate(row[iRate]),
      openingQty: parseOpening(row[iLen], row[iReq], unit),
      vendorName: vendor?.name || '',
      vendorCode: vendor?.code || '',
    });
  }
  return items;
}

function parseAccessoryRows() {
  const table = parseCsv(readFileSync(csvPath2, 'utf8'));
  const items = [];
  const seen = new Map();
  let n = 0;
  for (const row of table.slice(1)) {
    const rawName = row[0];
    if (!rawName) continue;
    n += 1;
    const qtyText = row[1] || '';
    const color = String(row[3] || '').trim();
    let name = titleName(rawName);
    if (color) name = `${name} - ${titleName(color)}`;
    const count = (seen.get(name.toLowerCase()) || 0) + 1;
    seen.set(name.toLowerCase(), count);
    if (count > 1) name = `${name} (${count})`;

    items.push({
      materialCode: `ACC-${String(n).padStart(3, '0')}`,
      name,
      category: accessoryCategory(rawName),
      unit: accessoryUnit(rawName, qtyText),
      unitCost: parseRate(row[2]),
      openingQty: parseAccessoryQty(qtyText),
      vendorName: '',
      vendorCode: '',
    });
  }
  return items;
}

async function ensureVendors(factory, userId, items) {
  const unique = new Map();
  for (const item of items) {
    if (!item.vendorCode || !item.vendorName) continue;
    unique.set(item.vendorCode, item.vendorName);
  }

  for (const [code, name] of unique) {
    const existing = await Supplier.findOne(applySoftDeleteFilter({
      factoryId: factory._id,
      $or: [{ supplierCode: code }, { name }],
    }));
    if (existing) {
      console.log(`Vendor exists ${existing.supplierCode} ${existing.name}`);
      continue;
    }
    await Supplier.create({
      organizationId: factory.organizationId,
      factoryId: factory._id,
      supplierCode: code,
      name,
      materialsSupplied: 'FABRIC',
      status: 'ACTIVE',
      createdBy: userId,
      updatedBy: userId,
    });
    console.log(`Created vendor ${code} ${name}`);
  }
}

async function feed() {
  const fabrics = parseFabricRows();
  const accessories = parseAccessoryRows();
  const items = [...fabrics, ...accessories];
  console.log(`Parsed ${fabrics.length} fabrics (Sheet1) + ${accessories.length} accessories (Sheet2)`);

  await connectDatabase();
  const factory = await Factory.findOne({ code: 'F01' }) || await Factory.findOne();
  if (!factory) throw new Error('No factory found. Seed RBAC first.');
  const admin = await User.findOne({ email: 'admin@demo.local' })
    || await User.findOne({ email: 'inventory@demo.local' })
    || await User.findOne({ isSuperAdmin: true });
  if (!admin) throw new Error('No admin user found.');

  await ensureVendors(factory, admin._id, items);
  const summary = await bulkImportMaterials({
    factoryId: factory._id,
    organizationId: factory.organizationId,
    items,
    postOpeningStock: true,
  }, admin._id);

  const withStock = items.filter((i) => i.openingQty > 0).length;
  console.log('\n=== Raw material feed ===');
  console.log(`Factory: ${factory.code}`);
  console.log(`Sheet1 fabrics: ${fabrics.length}`);
  console.log(`Sheet2 accessories: ${accessories.length}`);
  console.log(`Created: ${summary.created}`);
  console.log(`Skipped: ${summary.skipped}`);
  console.log(`Opening stock posted: ${summary.stockPosted} / ${withStock} with qty`);
  if (summary.errors.length) {
    console.log('Errors:');
    for (const err of summary.errors.slice(0, 20)) {
      console.log(`  row ${err.row}: ${err.name || ''} ${err.message}`);
    }
  }
  await mongoose.disconnect();
}

feed().catch((err) => {
  console.error(err);
  process.exit(1);
});
