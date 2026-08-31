import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { InventoryCode } from './inventoryCode.model.js';
import { SkuFormulaConfig, DEFAULT_SKU_SEGMENT_ORDER } from './skuFormulaConfig.model.js';
import { ConflictError, NotFoundError } from '../../shared/errors/AppError.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function listInventoryCodes({
  type, activeOnly = true, inactiveOnly = false, search, skip = 0, limit = 20,
} = {}) {
  const filter = {};
  if (type) filter.type = type;
  if (inactiveOnly) filter.isActive = false;
  else if (activeOnly) filter.isActive = true;
  if (search?.trim()) {
    const re = new RegExp(escapeRegex(search.trim()), 'i');
    filter.$or = [{ code: re }, { name: re }, { remarks: re }];
  }
  const [items, total] = await Promise.all([
    InventoryCode.find(filter).sort({ sortOrder: 1, name: 1 }).skip(skip).limit(limit),
    InventoryCode.countDocuments(filter),
  ]);
  return { items, total };
}

export async function countInventoryCodesByType({ activeOnly = true } = {}) {
  const match = {};
  if (activeOnly) match.isActive = true;
  const rows = await InventoryCode.aggregate([
    { $match: match },
    { $group: { _id: '$type', count: { $sum: 1 } } },
  ]);
  return Object.fromEntries(rows.map((r) => [r._id, r.count]));
}

export async function getInventoryCode(id) {
  const doc = await InventoryCode.findById(id);
  if (!doc) throw new NotFoundError('Inventory code not found');
  return doc;
}

export async function createInventoryCode(data) {
  const code = data.code?.trim();
  const name = data.name?.trim();
  try {
    return await InventoryCode.create({
      ...data,
      code,
      name,
      updatedAt: new Date(),
    });
  } catch (err) {
    if (err?.code === 11000) {
      throw new ConflictError(`Code "${code}" already exists for this type`);
    }
    throw err;
  }
}

export async function updateInventoryCode(id, data) {
  const doc = await getInventoryCode(id);
  if (data.code !== undefined) doc.code = data.code.trim();
  if (data.name !== undefined) doc.name = data.name.trim();
  if (data.type !== undefined) doc.type = data.type;
  if (data.sortOrder !== undefined) doc.sortOrder = data.sortOrder;
  if (data.isActive !== undefined) doc.isActive = data.isActive;
  if (data.remarks !== undefined) doc.remarks = data.remarks;
  doc.updatedAt = new Date();
  await doc.save();
  return doc;
}

export async function deleteInventoryCode(id) {
  const doc = await getInventoryCode(id);
  await doc.deleteOne();
  return { deleted: true };
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function resolveInventoryCode(type, input) {
  if (!input) return null;
  const raw = String(input).trim();
  if (!raw) return null;

  const byCode = await InventoryCode.findOne({
    type,
    isActive: true,
    code: new RegExp(`^${escapeRegex(raw)}$`, 'i'),
  });
  if (byCode) return byCode.code.toUpperCase().replace(/\s+/g, '');

  const byName = await InventoryCode.findOne({
    type,
    isActive: true,
    name: new RegExp(`^${escapeRegex(raw)}$`, 'i'),
  });
  if (byName) return byName.code.toUpperCase().replace(/\s+/g, '');

  return raw.toUpperCase().replace(/\s+/g, '');
}

export async function seedInventoryCodesFromFile() {
  const seedPath = join(__dirname, '../../data/inventoryCodes.seed.json');
  const rows = JSON.parse(readFileSync(seedPath, 'utf8'));
  for (const row of rows) {
    await InventoryCode.updateOne(
      { type: row.type, code: row.code },
      {
        type: row.type,
        code: row.code,
        name: row.name,
        sortOrder: row.sortOrder ?? 0,
        isActive: row.isActive ?? true,
        remarks: row.remarks || '',
        updatedAt: new Date(),
      },
      { upsert: true },
    );
  }
  return rows.length;
}

export async function getActiveSkuFormulaConfig() {
  return SkuFormulaConfig.findOne({ isActive: true }).sort({ updatedAt: -1 });
}

export async function seedSkuFormulaConfig() {
  let config = await SkuFormulaConfig.findOne({ name: 'Standard SKU (ops sheet)' });
  if (!config) {
    await SkuFormulaConfig.updateMany({ isActive: true }, { isActive: false });
    config = await SkuFormulaConfig.create({
      name: 'Standard SKU (ops sheet)',
      isActive: true,
      skuSegmentOrder: DEFAULT_SKU_SEGMENT_ORDER,
    });
  } else if (!config.isActive) {
    await SkuFormulaConfig.updateMany({ isActive: true }, { isActive: false });
    config.isActive = true;
    if (!config.skuSegmentOrder?.length) config.skuSegmentOrder = DEFAULT_SKU_SEGMENT_ORDER;
    config.updatedAt = new Date();
    await config.save();
  }
  return config;
}

export async function updateSkuFormulaConfig(data) {
  let config = await getActiveSkuFormulaConfig();
  if (!config) {
    return SkuFormulaConfig.create({
      name: data.name || 'Standard SKU (ops sheet)',
      isActive: true,
      skuSegmentOrder: data.skuSegmentOrder || DEFAULT_SKU_SEGMENT_ORDER,
    });
  }
  if (data.name !== undefined) config.name = data.name;
  if (data.skuSegmentOrder !== undefined) config.skuSegmentOrder = data.skuSegmentOrder;
  config.updatedAt = new Date();
  await config.save();
  return config;
}
