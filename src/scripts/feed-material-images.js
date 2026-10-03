/**
 * Attach optional fabric images from an xlsx "images" column onto existing materials.
 * Usage: node src/scripts/feed-material-images.js [path-to.xlsx]
 */
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import JSZip from 'jszip';
import mongoose from 'mongoose';
import { connectDatabase } from '../config/database.js';
import { Factory } from '../modules/organization/factory.model.js';
import { Material } from '../modules/inventory/material.model.js';
import { applySoftDeleteFilter } from '../shared/utils/schema.js';
import { saveMaterialImageBuffer } from '../shared/services/localFiles.service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_PATHS = [
  process.argv[2],
  'C:/Users/PushkarLS68/Downloads/excel_images_in_images_column.xlsx',
  join(__dirname, '../../../excel_images_in_images_column.xlsx'),
].filter(Boolean);

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

function nameKey(value) {
  return titleName(value)
    .toLowerCase()
    .replace(/\s*\(\d+\)\s*$/, '')
    .replace(/[^a-z0-9]+/g, '');
}

function colLettersToIndex(col) {
  let n = 0;
  for (const ch of String(col).toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseSheetCells(xml) {
  const rows = new Map();
  const rowRe = /<row r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch;
  while ((rowMatch = rowRe.exec(xml))) {
    const excelRow = Number(rowMatch[1]);
    const cells = {};
    const cellRe = /<c r="([A-Z]+)(\d+)"([^>]*)>([\s\S]*?)<\/c>/g;
    let cellMatch;
    while ((cellMatch = cellRe.exec(rowMatch[2]))) {
      const col = colLettersToIndex(cellMatch[1]);
      const inline = cellMatch[4].match(/<t[^>]*>([\s\S]*?)<\/t>/);
      const num = cellMatch[4].match(/<v>([\s\S]*?)<\/v>/);
      const text = inline ? decodeXml(inline[1]) : (num ? decodeXml(num[1]) : '');
      cells[col] = text.trim();
    }
    rows.set(excelRow, cells);
  }
  return rows;
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function extractImageMap(zip) {
  const drawing = await zip.file('xl/drawings/drawing1.xml')?.async('string');
  const rels = await zip.file('xl/drawings/_rels/drawing1.xml.rels')?.async('string');
  if (!drawing || !rels) return new Map();

  const ridToPath = {};
  for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const attrs = m[1];
    const id = (attrs.match(/\bId="(rId\d+)"/) || [])[1];
    const target = (attrs.match(/\bTarget="([^"]+)"/) || [])[1];
    if (!id || !target) continue;
    let p = target.replace(/^\//, '').replace(/^\.\.\//, 'xl/');
    if (!p.startsWith('xl/')) p = `xl/media/${p.split('/').pop()}`;
    ridToPath[id] = p;
  }

  const map = new Map();
  const blocks = drawing.split(/<oneCellAnchor>|<twoCellAnchor[^>]*>/).slice(1);
  for (const block of blocks) {
    const row = Number((block.match(/<row>(\d+)<\/row>/) || [])[1]);
    const rid = (block.match(/r:embed="(rId\d+)"/) || [])[1];
    if (!Number.isFinite(row) || !rid || !ridToPath[rid]) continue;
    const excelRow = row + 1;
    const list = map.get(excelRow) || [];
    list.push(ridToPath[rid]);
    map.set(excelRow, list);
  }
  return map;
}

function findMaterial(materials, { code, name }) {
  if (code) {
    const hit = materials.find((m) => m.materialCode.toUpperCase() === code.toUpperCase());
    if (hit) return hit;
  }
  const key = nameKey(name);
  if (!key) return null;
  const exact = materials.filter((m) => nameKey(m.name) === key);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    return exact.find((m) => !(m.images || []).length) || exact[0];
  }
  return materials.find((m) => nameKey(m.name).startsWith(key) || key.startsWith(nameKey(m.name))) || null;
}

async function main() {
  const xlsxPath = DEFAULT_PATHS.find((p) => existsSync(p));
  if (!xlsxPath) throw new Error('Excel file not found. Pass a path: node src/scripts/feed-material-images.js <file.xlsx>');

  await connectDatabase();
  const factory = await Factory.findOne(applySoftDeleteFilter({ code: 'F01' }));
  if (!factory) throw new Error('Factory F01 not found');

  const materials = await Material.find(applySoftDeleteFilter({ factoryId: factory._id, category: 'FABRIC' }));
  const zip = await JSZip.loadAsync(readFileSync(xlsxPath));
  const sheetXml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  const rows = parseSheetCells(sheetXml);
  const imagesByRow = await extractImageMap(zip);

  let updated = 0;
  let skipped = 0;
  let missing = 0;
  let fabricIndex = 0;

  const excelRows = [...rows.keys()].sort((a, b) => a - b).filter((r) => r > 1);
  for (const excelRow of excelRows) {
    const cells = rows.get(excelRow) || {};
    const rawName = cells[0];
    if (!rawName) continue;
    fabricIndex += 1;
    const name = titleName(rawName);
    const code = String(cells[7] || '').trim() || `FAB-${String(fabricIndex).padStart(3, '0')}`;
    const imagePaths = imagesByRow.get(excelRow) || [];
    if (!imagePaths.length) {
      skipped += 1;
      continue;
    }

    const material = findMaterial(materials, { code, name });
    if (!material) {
      missing += 1;
      console.log(`  [miss] row ${excelRow} ${code} ${name}`);
      continue;
    }

    const saved = [];
    for (const zipPath of imagePaths) {
      const file = zip.file(zipPath) || zip.file(zipPath.replace(/^xl\//, ''));
      if (!file) continue;
      const buffer = await file.async('nodebuffer');
      const stored = await saveMaterialImageBuffer({
        buffer,
        contentType: 'image/jpeg',
        fileName: zipPath.split('/').pop(),
        materialCode: material.materialCode,
      });
      saved.push(stored);
    }
    if (!saved.length) {
      skipped += 1;
      continue;
    }
    material.images = saved;
    await material.save();
    updated += 1;
  }

  console.log(`\nImages from ${xlsxPath}`);
  console.log(`  drawing matches ${imagesByRow.size}  updated ${updated}  skipped ${skipped}  unmatched ${missing}  fabrics in sheet ${fabricIndex}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
