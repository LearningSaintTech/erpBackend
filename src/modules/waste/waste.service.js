import { WasteRecord } from './wasteRecord.model.js';
import { Material } from '../inventory/material.model.js';
import { Factory } from '../organization/factory.model.js';
import { nextDocumentNumber } from '../../shared/utils/numbering.js';
import { NotFoundError } from '../../shared/errors/AppError.js';
import { applySoftDeleteFilter } from '../../shared/utils/schema.js';

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildListFilter(factoryId, { search, wasteType, status, from, to } = {}) {
  const filter = applySoftDeleteFilter({ factoryId });
  if (wasteType) filter.wasteType = wasteType;
  if (status) filter.status = status;
  if (search?.trim()) {
    filter.wasteCode = new RegExp(escapeRegex(search.trim()), 'i');
  }
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = new Date(from);
    if (to) filter.createdAt.$lte = new Date(to);
  }
  return filter;
}

const POPULATE = [
  { path: 'materialId', select: 'name materialCode unit unitCost' },
  { path: 'batchId', select: 'batchNumber status currentStage' },
  { path: 'skuId', select: 'skuCode name' },
];

export async function createWasteRecord(data, userId) {
  const factory = await Factory.findById(data.factoryId);
  const wasteCode = await nextDocumentNumber(data.factoryId, 'WASTE', `WST-${factory.code}-`);

  let unitCost = data.unitCost || 0;
  if (data.materialId && !unitCost) {
    const mat = await Material.findById(data.materialId);
    unitCost = mat?.unitCost || 0;
  }

  return WasteRecord.create({
    ...data,
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

export async function recordRecovery(id, { recoveryAction }, userId, factoryId) {
  const record = await WasteRecord.findOne(applySoftDeleteFilter({ _id: id, factoryId }));
  if (!record) throw new NotFoundError('Waste record not found');
  record.recoveryAction = recoveryAction;
  record.status = 'RECOVERED';
  record.updatedBy = userId;
  await record.save();
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
      { $match: { factoryId, isDeleted: false } },
      { $group: { _id: null, totalCost: { $sum: '$totalCost' }, recoveredCost: { $sum: { $cond: [{ $eq: ['$status', 'RECOVERED'] }, '$totalCost', 0] } } } },
    ]),
    WasteRecord.aggregate([
      { $match: { factoryId, isDeleted: false } },
      { $group: { _id: '$wasteType', quantity: { $sum: '$quantity' }, cost: { $sum: '$totalCost' } } },
    ]),
    WasteRecord.aggregate([
      { $match: { factoryId, isDeleted: false } },
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
    { $match: { factoryId, isDeleted: false, createdAt: { $gte: last7 } } },
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
  const lines = ['wasteCode,wasteType,quantity,unit,totalCost,status,recoveryAction,reasonCode,createdAt'];
  for (const r of items) {
    lines.push([
      r.wasteCode,
      r.wasteType,
      r.quantity,
      r.unit || '',
      r.totalCost,
      r.status,
      r.recoveryAction || '',
      r.reasonCode || '',
      r.createdAt?.toISOString?.() || '',
    ].join(','));
  }
  return lines.join('\n');
}

export async function createQcWasteRecord({
  factoryId, organizationId, wasteType, batchId, stage, skuId, materialId, quantity, unit, reasonCode, userId,
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
