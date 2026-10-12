import { WasteRecord } from './wasteRecord.model.js';
import { Material } from '../inventory/material.model.js';
import { Factory } from '../organization/factory.model.js';
import { nextDocumentNumber } from '../../shared/utils/numbering.js';
import { ProductionBatch } from '../production/productionBatch.model.js';
import { Sku } from '../sku/sku.model.js';
import { InventoryBalance } from '../inventory/inventoryBalance.model.js';
import { InventoryTransaction } from '../inventory/inventoryTransaction.model.js';
import { NotFoundError, ConflictError } from '../../shared/errors/AppError.js';
import { csvDocument, humanizeEnum } from '../report/csv.util.js';
import {
  applySoftDeleteFilter, asObjectId, escapeRegex, queryString,
} from '../../shared/utils/schema.js';

/**
 * Lookups for the Record waste form. Waste recorders (production manager, QC) don't hold
 * inventory / SKU read rights, so the form gets its pick lists from here instead.
 */
export async function getWasteFormOptions(factoryId) {
  const [materials, skus, batches] = await Promise.all([
    Material.find({ factoryId, isDeleted: false }).select('materialCode name unit unitCost').sort({ materialCode: 1 }).limit(500).lean(),
    Sku.find({ factoryId, isDeleted: false }).select('skuCode name').sort({ skuCode: 1 }).limit(500).lean(),
    ProductionBatch.find({ factoryId, isDeleted: false }).select('batchNumber status').sort({ createdAt: -1 }).limit(200).lean(),
  ]);
  return { materials, skus, batches };
}

/** Server-owned / workflow fields a client must never set on create. */
const SERVER_FIELDS = [
  '_id', 'isDeleted', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'organizationId', 'factoryId', '__v',
  'wasteCode', 'status', 'recoveryAction', 'totalCost',
];

async function assertInFactory(Model, id, factoryId, label) {
  if (!id) return;
  const exists = await Model.exists({ _id: id, factoryId, isDeleted: false });
  if (!exists) throw new NotFoundError(`${label} not found`);
}

function buildListFilter(factoryId, { search, wasteType, status, from, to } = {}) {
  const filter = applySoftDeleteFilter({ factoryId });
  const typeQ = queryString(wasteType);
  const statusQ = queryString(status);
  const searchQ = queryString(search)?.trim();
  const fromQ = queryString(from);
  const toQ = queryString(to);
  if (typeQ) filter.wasteType = typeQ;
  if (statusQ) filter.status = statusQ;
  if (searchQ) {
    filter.wasteCode = new RegExp(escapeRegex(searchQ), 'i');
  }
  if (fromQ || toQ) {
    filter.createdAt = {};
    if (fromQ) filter.createdAt.$gte = new Date(fromQ);
    if (toQ) filter.createdAt.$lte = new Date(toQ);
  }
  return filter;
}

const POPULATE = [
  { path: 'materialId', select: 'name materialCode unit unitCost' },
  { path: 'batchId', select: 'batchNumber status currentStage' },
  { path: 'skuId', select: 'skuCode name' },
];

export async function createWasteRecord(data, userId) {
  const { factoryId, organizationId } = data;
  const body = { ...data };
  for (const key of SERVER_FIELDS) delete body[key];

  await assertInFactory(ProductionBatch, body.batchId, factoryId, 'Batch');
  await assertInFactory(Material, body.materialId, factoryId, 'Material');
  await assertInFactory(Sku, body.skuId, factoryId, 'SKU');

  const factory = await Factory.findById(factoryId);
  const wasteCode = await nextDocumentNumber(factoryId, 'WASTE', `WST-${factory.code}-`);

  let unitCost = body.unitCost || 0;
  if (body.materialId && !unitCost) {
    const mat = await Material.findOne({ _id: body.materialId, factoryId });
    unitCost = mat?.unitCost || 0;
  }

  return WasteRecord.create({
    ...body,
    factoryId,
    organizationId,
    wasteCode,
    unitCost,
    createdBy: userId,
    updatedBy: userId,
  });
}

export async function listWasteRecords(factoryId, { page, limit, skip, search, wasteType, status, from, to }) {
  const filter = buildListFilter(factoryId, { search, wasteType, status, from, to });
  const [items, total] = await Promise.all([
    WasteRecord.find(filter).populate(POPULATE).skip(skip).limit(limit).sort({ createdAt: -1 }),
    WasteRecord.countDocuments(filter),
  ]);
  return { items, total };
}

export async function getWasteRecord(id, factoryId) {
  const record = await WasteRecord.findOne(applySoftDeleteFilter({ _id: id, factoryId })).populate(POPULATE);
  if (!record) throw new NotFoundError('Waste record not found');
  return record;
}

/**
 * Recovery closes a waste record once (atomic RECORDED → RECOVERED claim) and takes the recovered
 * quantity off the matching SCRAP / REJECTED stock row when one exists (clamped at its on-hand).
 */
export async function recordRecovery(id, { recoveryAction }, userId, factoryId) {
  const existing = await WasteRecord.findOne(applySoftDeleteFilter({ _id: id, factoryId }));
  if (!existing) throw new NotFoundError('Waste record not found');

  const record = await WasteRecord.findOneAndUpdate(
    { _id: existing._id, factoryId, isDeleted: false, status: 'RECORDED' },
    { $set: { recoveryAction, status: 'RECOVERED', updatedBy: userId, updatedAt: new Date() } },
    { new: true },
  );
  if (!record) throw new ConflictError('Waste record already recovered');

  if (recoveryAction && recoveryAction !== 'NONE' && (record.quantity || 0) > 0) {
    const stockFilter = { factoryId: record.factoryId, isDeleted: false };
    if (record.materialId) {
      Object.assign(stockFilter, { inventoryType: 'SCRAP', materialId: record.materialId });
    } else if (record.skuId) {
      Object.assign(stockFilter, {
        inventoryType: record.wasteType === 'REJECTED_PIECES' ? 'REJECTED' : 'SCRAP',
        skuId: record.skuId,
      });
    }
    const balance = stockFilter.inventoryType ? await InventoryBalance.findOne(stockFilter) : null;
    const take = Math.min(record.quantity, balance?.onHand || 0);
    if (balance && take > 0) {
      const res = await InventoryBalance.updateOne(
        { _id: balance._id, onHand: { $gte: take } },
        { $inc: { onHand: -take, available: -take }, $set: { updatedBy: userId, updatedAt: new Date() } },
      );
      if (res.modifiedCount) {
        await InventoryTransaction.create({
          organizationId: record.organizationId,
          factoryId: record.factoryId,
          type: 'ISSUE',
          materialId: record.materialId,
          skuId: record.materialId ? undefined : record.skuId,
          quantity: take,
          unit: balance.unit || record.unit,
          referenceType: 'WASTE_RECOVERY',
          referenceId: record._id,
          performedBy: userId,
          createdBy: userId,
        });
      }
    }
  }
  return record.populate(POPULATE);
}

export async function getWasteStats(factoryId) {
  const base = applySoftDeleteFilter({ factoryId });
  const [
    totalRecords,
    recordedCount,
    recoveredCount,
    costAgg,
    byTypeRows,
    byStatusRows,
  ] = await Promise.all([
    WasteRecord.countDocuments(base),
    WasteRecord.countDocuments({ ...base, status: 'RECORDED' }),
    WasteRecord.countDocuments({ ...base, status: 'RECOVERED' }),
    WasteRecord.aggregate([
      { $match: { factoryId: asObjectId(factoryId), isDeleted: false } },
      { $group: { _id: null, totalCost: { $sum: '$totalCost' }, recoveredCost: { $sum: { $cond: [{ $eq: ['$status', 'RECOVERED'] }, '$totalCost', 0] } } } },
    ]),
    WasteRecord.aggregate([
      { $match: { factoryId: asObjectId(factoryId), isDeleted: false } },
      { $group: { _id: '$wasteType', quantity: { $sum: '$quantity' }, cost: { $sum: '$totalCost' } } },
    ]),
    WasteRecord.aggregate([
      { $match: { factoryId: asObjectId(factoryId), isDeleted: false } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
  ]);

  const byType = {};
  const costByType = {};
  let topType = null;
  let topQty = 0;
  for (const row of byTypeRows) {
    byType[row._id] = row.quantity;
    costByType[row._id] = Math.round(row.cost || 0);
    if (row.quantity > topQty) {
      topQty = row.quantity;
      topType = row._id;
    }
  }

  const now = new Date();
  const last7 = new Date(now.getTime() - 7 * 86400000);
  const periodCost7d = await WasteRecord.aggregate([
    { $match: { factoryId: asObjectId(factoryId), isDeleted: false, createdAt: { $gte: last7 } } },
    { $group: { _id: null, total: { $sum: '$totalCost' } } },
  ]);

  return {
    totalRecords,
    recordedCount,
    recoveredCount,
    totalCost: Math.round(costAgg[0]?.totalCost || 0),
    recoveredCost: Math.round(costAgg[0]?.recoveredCost || 0),
    byType,
    costByType,
    byStatus: Object.fromEntries(byStatusRows.map((r) => [r._id, r.count])),
    topType,
    periodCost7d: Math.round(periodCost7d[0]?.total || 0),
  };
}

export async function getWasteSummary(factoryId) {
  const stats = await getWasteStats(factoryId);
  return {
    byType: stats.byType,
    totalCost: stats.totalCost,
    count: stats.totalRecords,
    recovered: stats.recoveredCount,
  };
}

export async function exportWasteCsv(factoryId, filters = {}) {
  const { items } = await listWasteRecords(factoryId, { page: 1, limit: 5000, skip: 0, ...filters });
  const headers = [
    'Code', 'Type', 'Material / SKU', 'Batch', 'Stage', 'Quantity', 'Unit', 'Unit cost', 'Total cost',
    'Status', 'Recovery action', 'Reason', 'Recorded at (UTC)',
  ];
  const round2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : '');
  const source = (r) => {
    if (r.materialId && typeof r.materialId === 'object') return [r.materialId.materialCode, r.materialId.name].filter(Boolean).join(' — ');
    if (r.skuId && typeof r.skuId === 'object') return [r.skuId.skuCode, r.skuId.name].filter(Boolean).join(' — ');
    return '';
  };
  const rows = items.map((r) => [
    r.wasteCode,
    humanizeEnum(r.wasteType),
    source(r),
    r.batchId && typeof r.batchId === 'object' ? r.batchId.batchNumber || '' : '',
    humanizeEnum(r.stage),
    r.quantity ?? '',
    r.unit || '',
    round2(r.unitCost ?? 0),
    round2(r.totalCost ?? 0),
    r.status === 'RECORDED' ? 'Awaiting recovery' : humanizeEnum(r.status),
    r.status === 'RECORDED' ? '' : humanizeEnum(r.recoveryAction),
    humanizeEnum(r.reasonCode),
    r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 16).replace('T', ' ') : '',
  ]);
  return csvDocument(headers, rows);
}

/**
 * @param {number} [unitCost] cost per piece for SKU-level rejects (no materialId) — e.g. the batch's
 *   actual material cost per piece; materialId-based records fall back to the material master rate.
 */
export async function createQcWasteRecord({
  factoryId, organizationId, wasteType, batchId, stage, skuId, materialId, quantity, unit, reasonCode,
  unitCost, userId,
}) {
  return createWasteRecord({
    factoryId,
    organizationId,
    wasteType: wasteType || 'REJECTED_PIECES',
    batchId,
    stage,
    skuId,
    materialId,
    quantity,
    unit: unit || 'PIECES',
    unitCost: unitCost > 0 ? unitCost : undefined,
    reasonCode: reasonCode || 'QC_REJECT',
  }, userId);
}

export async function createProductionScrap({
  factoryId, organizationId, batchId, stage, materialId, skuId, quantity, unit, wasteType, userId,
}) {
  const record = await createWasteRecord({
    factoryId,
    organizationId,
    wasteType: wasteType || 'FABRIC_SCRAP',
    batchId,
    stage,
    materialId,
    skuId,
    quantity,
    unit: unit || 'METERS',
    reasonCode: 'STAGE_COMPLETE',
  }, userId);

  const inventoryService = await import('../inventory/inventory.service.js');
  await inventoryService.receiptScrap({
    factoryId,
    organizationId,
    materialId,
    skuId,
    quantity,
    unit: unit || (materialId ? 'METERS' : 'PIECES'),
    userId,
  });

  return record;
}
