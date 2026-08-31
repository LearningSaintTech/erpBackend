/**
 * Upload raw-materials.import.json and place all opening stock in
 * Zone 2 → R-1 → S-1 → single bin (RM warehouse).
 *
 * Usage: node src/scripts/upsert-raw-materials-z2.js
 */
import mongoose from 'mongoose';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { connectDatabase } from '../config/database.js';
import { Organization } from '../modules/organization/organization.model.js';
import { Factory } from '../modules/organization/factory.model.js';
import { User } from '../modules/user/user.model.js';
import { Warehouse } from '../modules/warehouse/warehouse.model.js';
import { Zone } from '../modules/warehouse/zone.model.js';
import { Rack } from '../modules/warehouse/rack.model.js';
import { Shelf } from '../modules/warehouse/shelf.model.js';
import { StorageBin } from '../modules/warehouse/storageBin.model.js';
import { Material } from '../modules/inventory/material.model.js';
import { Supplier } from '../modules/purchase/supplier.model.js';
import * as warehouseService from '../modules/warehouse/warehouse.service.js';
import * as warehouseExtended from '../modules/warehouse/warehouseExtended.service.js';
import * as inventoryService from '../modules/inventory/inventory.service.js';
import { applySoftDeleteFilter } from '../shared/utils/schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, '../data/raw-materials.import.json');

function normalizeVendorKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

async function ensureRmZ2Bin(org, factory, admin) {
  let wh = await Warehouse.findOne(applySoftDeleteFilter({
    factoryId: factory._id,
    warehouseCode: 'WH-RM-01',
  }));
  if (!wh) {
    wh = await warehouseService.createWarehouse({
      organizationId: org._id,
      factoryId: factory._id,
      warehouseCode: 'WH-RM-01',
      name: 'Raw Material Store',
      type: 'RAW_MATERIAL',
      isDefault: true,
    }, admin._id);
    console.log('Created WH-RM-01');
  } else {
    console.log('Using WH-RM-01');
  }

  let zone = await Zone.findOne(applySoftDeleteFilter({
    factoryId: factory._id,
    warehouseId: wh._id,
    zoneCode: 'Z2',
  }));
  if (!zone) {
    zone = await warehouseExtended.createZone({
      organizationId: org._id,
      factoryId: factory._id,
      warehouseId: wh._id,
      zoneCode: 'Z2',
      name: 'Zone 2',
    }, admin._id);
    console.log('Created Zone 2');
  }

  let rack = await Rack.findOne(applySoftDeleteFilter({
    factoryId: factory._id,
    zoneId: zone._id,
    rackCode: 'R-1',
  }));
  if (!rack) {
    rack = await warehouseExtended.createRack({
      organizationId: org._id,
      factoryId: factory._id,
      zoneId: zone._id,
      rackCode: 'R-1',
    }, admin._id);
    console.log('Created R-1');
  }

  let shelf = await Shelf.findOne(applySoftDeleteFilter({
    factoryId: factory._id,
    rackId: rack._id,
    shelfCode: 'S-1',
  }));
  if (!shelf) {
    shelf = await warehouseExtended.createShelf({
      organizationId: org._id,
      factoryId: factory._id,
      rackId: rack._id,
      shelfCode: 'S-1',
    }, admin._id);
    console.log('Created S-1');
  }

  const binCode = 'R-1-S-1';
  let bin = await StorageBin.findOne(applySoftDeleteFilter({
    factoryId: factory._id,
    warehouseId: wh._id,
    binCode,
  }));
  if (!bin) {
    bin = await warehouseService.createStorageBin({
      organizationId: org._id,
      factoryId: factory._id,
      warehouseId: wh._id,
      zoneId: zone._id,
      rackId: rack._id,
      shelfId: shelf._id,
      zoneCode: 'Z2',
      binCode,
      barcode: 'WH-RM-Z2-R-1-S-1',
    }, admin._id);
    console.log('Created bin R-1-S-1');
  }

  return { wh, zone, bin };
}

async function resolveSupplierId(factoryId, vendorName, supplierByKey) {
  const key = normalizeVendorKey(vendorName);
  if (!key) return null;
  if (supplierByKey.has(key)) return supplierByKey.get(key);

  // fuzzy: vendor key contained in supplier name or vice versa
  for (const [sKey, id] of supplierByKey.entries()) {
    if (sKey.includes(key) || key.includes(sKey)) return id;
  }
  return null;
}

async function main() {
  await connectDatabase();

  const org = await Organization.findOne({ code: 'DEMO' });
  if (!org) throw new Error('Organization DEMO not found');
  const factory = await Factory.findOne({ organizationId: org._id, code: 'F01' });
  if (!factory) throw new Error('Factory F01 not found');
  const admin = await User.findOne({ email: 'admin@demo.local' })
    || await User.findOne({ organizationId: org._id });
  if (!admin) throw new Error('No admin user found');

  const rows = JSON.parse(readFileSync(DATA_PATH, 'utf8'));
  if (!Array.isArray(rows) || !rows.length) throw new Error('No materials in import file');

  const { bin } = await ensureRmZ2Bin(org, factory, admin);

  const suppliers = await Supplier.find(applySoftDeleteFilter({ factoryId: factory._id }))
    .select('_id name')
    .lean();
  const supplierByKey = new Map(suppliers.map((s) => [normalizeVendorKey(s.name), s._id]));

  let created = 0;
  let updated = 0;
  let stockPosted = 0;
  let skipped = 0;
  const errors = [];

  console.log(`\nImporting ${rows.length} materials → Z2 / R-1 / S-1 / ${bin.binCode}\n`);

  for (const row of rows) {
    const materialCode = String(row.materialCode || '').trim();
    const name = String(row.name || '').trim();
    if (!materialCode || !name) {
      skipped += 1;
      errors.push({ materialCode, message: 'Missing code or name' });
      continue;
    }

    try {
      const supplierId = await resolveSupplierId(factory._id, row.vendorName, supplierByKey);
      let material = await Material.findOne(applySoftDeleteFilter({
        factoryId: factory._id,
        materialCode,
      }));

      if (!material) {
        material = await Material.create({
          organizationId: org._id,
          factoryId: factory._id,
          materialCode,
          name,
          category: row.category || 'FABRIC',
          unit: row.unit || 'METERS',
          unitCost: Number(row.unitCost) || 0,
          ...(supplierId ? { supplierId } : {}),
          createdBy: admin._id,
          updatedBy: admin._id,
        });
        created += 1;
        console.log(`Created ${materialCode} — ${name}`);
      } else {
        material.name = name;
        material.category = row.category || material.category;
        material.unit = row.unit || material.unit;
        material.unitCost = Number(row.unitCost) || material.unitCost || 0;
        if (supplierId) material.supplierId = supplierId;
        material.updatedBy = admin._id;
        await material.save();
        updated += 1;
        console.log(`Updated ${materialCode} — ${name}`);
      }

      const qty = Number(row.openingQty) || 0;
      if (qty > 0) {
        await inventoryService.receiptMaterial({
          factoryId: factory._id,
          organizationId: org._id,
          materialId: material._id,
          quantity: qty,
          unit: material.unit,
          userId: admin._id,
          storageBinId: bin._id,
          referenceType: 'OPENING_STOCK',
        });
        stockPosted += 1;
      }
    } catch (err) {
      skipped += 1;
      errors.push({ materialCode, message: err.message || 'failed' });
      console.log(`ERROR ${materialCode}: ${err.message}`);
    }
  }

  const total = await Material.countDocuments({ factoryId: factory._id, isDeleted: { $ne: true } });
  console.log(`\nDone.`);
  console.log(`  created=${created} updated=${updated} stockPosted=${stockPosted} skipped=${skipped}`);
  console.log(`  totalMaterials=${total}`);
  console.log(`  location: WH-RM-01 → Zone 2 → R-1 → S-1 → bin R-1-S-1`);
  if (errors.length) {
    console.log(`  errors (${errors.length}):`, errors.slice(0, 10));
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
