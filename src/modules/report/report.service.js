import { Design } from '../design/design.model.js';
import { Sample } from '../sampling/sample.model.js';
import { Sku } from '../sku/sku.model.js';
import { Bom } from '../bom/bom.model.js';
import { Material } from '../inventory/material.model.js';
import { InventoryBalance } from '../inventory/inventoryBalance.model.js';
import { PurchaseRequisition } from '../purchase/purchaseRequisition.model.js';
import { PurchaseOrder } from '../purchase/purchaseOrder.model.js';
import { GoodsReceipt } from '../purchase/goodsReceipt.model.js';
import { ProductionOrder } from '../production/productionOrder.model.js';
import { ProductionBatch } from '../production/productionBatch.model.js';
import { QualityInspection } from '../quality/qualityInspection.model.js';
import { Defect } from '../quality/defect.model.js';
import { ApprovalInstance } from '../approval/approvalInstance.model.js';
import { WasteRecord } from '../waste/wasteRecord.model.js';
import { Machine } from '../production/machine.model.js';
import { UserRoleAssignment } from '../user/userRoleAssignment.model.js';
import { applySoftDeleteFilter } from '../../shared/utils/schema.js';
import * as productionService from '../production/production.service.js';
import * as inventoryService from '../inventory/inventory.service.js';
import * as purchaseService from '../purchase/purchase.service.js';
import * as qualityService from '../quality/quality.service.js';
import * as warehouseService from '../warehouse/warehouse.service.js';
import * as wasteService from '../waste/waste.service.js';

export function resolveDateRange({ preset, from, to } = {}) {
  const now = new Date();
  if (from || to) {
    return {
      from: from ? new Date(from) : new Date(0),
      to: to ? new Date(to) : now,
    };
  }
  switch (preset) {
    case 'mtd':
      return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: now };
    case 'ytd':
      return { from: new Date(now.getFullYear(), 0, 1), to: now };
    case 'last7':
      return { from: new Date(now.getTime() - 7 * 86400000), to: now };
    case 'last30':
      return { from: new Date(now.getTime() - 30 * 86400000), to: now };
    case 'last90':
      return { from: new Date(now.getTime() - 90 * 86400000), to: now };
    default:
      return null;
  }
}

function dateMatch(range, field = 'createdAt') {
  if (!range) return {};
  return { [field]: { $gte: range.from, $lte: range.to } };
}

async function countByStatus(Model, factoryId, statusField = 'status', extra = {}) {
  const rows = await Model.aggregate([
    { $match: { factoryId, isDeleted: false, ...extra } },
    { $group: { _id: `$${statusField}`, count: { $sum: 1 } } },
  ]);
  return Object.fromEntries(rows.map((r) => [r._id, r.count]));
}

export async function getReportStats(factoryId, filters = {}) {
  const range = resolveDateRange(filters);
  const [
    production,
    inventory,
    purchase,
    quality,
    warehouse,
    waste,
  ] = await Promise.all([
    productionService.getProductionStats(factoryId),
    inventoryService.getInventoryStats(factoryId),
    purchaseService.getPurchaseStats(factoryId),
    qualityService.getQualityStats(factoryId),
    warehouseService.getWarehouseStats(factoryId),
    wasteService.getWasteSummary(factoryId),
  ]);

  let periodSpend = purchase.openPoValue;
  if (range) {
    const spend = await PurchaseOrder.aggregate([
      { $match: { factoryId, isDeleted: false, ...dateMatch(range) } },
      { $group: { _id: null, total: { $sum: '$totalAmount' } } },
    ]);
    periodSpend = spend[0]?.total || 0;
  }

  return {
    period: range ? { from: range.from, to: range.to } : null,
    production: {
      ordersTotal: production.ordersTotal,
      batchesInProgress: production.batchesInProgress,
      fulfillmentPct: production.fulfillmentPct,
      overdueOrders: production.overdueOrders,
    },
    inventory: {
      materialCount: inventory.materialCount,
      stockValue: inventory.stockValue,
      lowStock: inventory.lowStock,
      outOfStock: inventory.outOfStock,
    },
    purchase: {
      poOpen: purchase.poOpen,
      grnPendingQc: purchase.grnPendingQc,
      openPoValue: purchase.openPoValue,
      periodSpend: Math.round(periodSpend),
    },
    quality: {
      firstPassYield: quality.firstPassYield,
      openCapa: quality.openCapa,
      pending: quality.pending,
      defectsLogged: quality.defectsLogged,
    },
    warehouse: {
      dispatchReady: warehouse.dispatchReady,
      binsActive: warehouse.binsActive,
    },
    waste: {
      totalCost: Math.round(waste.totalCost),
      count: waste.count,
    },
  };
}

export async function getFactoryDashboard(factoryId, filters = {}) {
  const range = resolveDateRange(filters);
  const [
    designsByStatus,
    samplesByStatus,
    productionByStatus,
    pendingApprovals,
    openPRs,
    openPOs,
    qcQueue,
    lowStock,
    productionStats,
    qualityStats,
    purchaseStats,
  ] = await Promise.all([
    countByStatus(Design, factoryId),
    countByStatus(Sample, factoryId),
    countByStatus(ProductionOrder, factoryId),
    ApprovalInstance.countDocuments({ factoryId, status: 'PENDING' }),
    PurchaseRequisition.countDocuments({ factoryId, status: { $in: ['SUBMITTED', 'DRAFT'] }, isDeleted: false }),
    PurchaseOrder.countDocuments({ factoryId, status: { $in: ['APPROVED', 'SENT', 'PARTIAL'] }, isDeleted: false }),
    QualityInspection.countDocuments({ factoryId, status: { $in: ['PENDING', 'IN_PROGRESS'] }, isDeleted: false }),
    InventoryBalance.aggregate([
      { $match: { factoryId, inventoryType: 'RAW_MATERIAL', isDeleted: false } },
      { $lookup: { from: 'materials', localField: 'materialId', foreignField: '_id', as: 'mat' } },
      { $unwind: '$mat' },
      { $match: { $expr: { $lte: ['$available', '$mat.reorderLevel'] } } },
      { $count: 'count' },
    ]),
    productionService.getProductionStats(factoryId),
    qualityService.getQualityStats(factoryId),
    purchaseService.getPurchaseStats(factoryId),
  ]);

  const skuCount = await Sku.countDocuments({ factoryId, isDeleted: false });
  const activeBoms = await Bom.countDocuments({ factoryId, status: 'ACTIVE', isDeleted: false });

  let periodOrders = productionStats.ordersTotal;
  if (range) {
    periodOrders = await ProductionOrder.countDocuments({
      factoryId, isDeleted: false, ...dateMatch(range),
    });
  }

  return {
    period: range ? { from: range.from, to: range.to } : null,
    summary: {
      totalDesigns: Object.values(designsByStatus).reduce((a, b) => a + b, 0),
      approvedDesigns: designsByStatus.APPROVED || 0,
      activeSamples: (samplesByStatus.IN_PROGRESS || 0) + (samplesByStatus.MATERIAL_RESERVED || 0),
      skuCount,
      activeBoms,
      batchesInProgress: productionStats.batchesInProgress,
      pendingApprovals,
      openPRs,
      openPOs,
      qcQueue,
      lowStockAlerts: lowStock[0]?.count || 0,
      fulfillmentPct: productionStats.fulfillmentPct,
      firstPassYield: qualityStats.firstPassYield,
      openPoValue: purchaseStats.openPoValue,
      periodOrders,
    },
    designsByStatus,
    productionByStatus,
    samplesByStatus,
  };
}

export async function getProductionDashboard(factoryId, filters = {}) {
  const range = resolveDateRange(filters);
  const stats = await productionService.getProductionStats(factoryId);
  const byStatus = await countByStatus(ProductionOrder, factoryId, 'status', dateMatch(range));
  const batchesByStage = await ProductionBatch.aggregate([
    { $match: { factoryId, isDeleted: false, status: 'IN_PROGRESS' } },
    { $group: { _id: '$currentStage', count: { $sum: 1 } } },
  ]);
  const qtyAgg = await ProductionOrder.aggregate([
    { $match: { factoryId, isDeleted: false, ...dateMatch(range) } },
    { $group: { _id: null, qty: { $sum: '$plannedQuantity' }, produced: { $sum: '$producedQuantity' } } },
  ]);
  return {
    period: range ? { from: range.from, to: range.to } : null,
    ordersByStatus: byStatus,
    batchesByStage: Object.fromEntries(batchesByStage.map((r) => [r._id, r.count])),
    totalPlannedQty: qtyAgg[0]?.qty || 0,
    totalProducedQty: qtyAgg[0]?.produced || 0,
    fulfillmentPct: stats.fulfillmentPct,
    overdueOrders: stats.overdueOrders,
    batchesInProgress: stats.batchesInProgress,
    batchesCompleted: stats.batchesCompleted,
    batchesRework: stats.batchesRework,
    machineCount: stats.machineCount,
    totalCapacityPerHour: stats.totalCapacityPerHour,
  };
}

export async function getInventoryDashboard(factoryId) {
  const stats = await inventoryService.getInventoryStats(factoryId);
  const whStats = await warehouseService.getWarehouseStats(factoryId);
  const fgAgg = await InventoryBalance.aggregate([
    { $match: { factoryId, inventoryType: 'FINISHED_GOODS', isDeleted: false } },
    { $group: { _id: null, onHand: { $sum: '$onHand' }, reserved: { $sum: '$reserved' } } },
  ]);
  return {
    materialCount: stats.materialCount,
    balanceCount: stats.balanceCount,
    rmOnHand: stats.totalOnHand,
    fgOnHand: fgAgg[0]?.onHand || 0,
    totalReserved: (fgAgg[0]?.reserved || 0) + stats.activeReservations,
    stockValue: stats.stockValue,
    lowStock: stats.lowStock,
    outOfStock: stats.outOfStock,
    activeReservations: stats.activeReservations,
    dispatchReady: whStats.dispatchReady,
    stagedFg: whStats.stagedFg,
  };
}

export async function getPurchaseDashboard(factoryId, filters = {}) {
  const range = resolveDateRange(filters);
  const stats = await purchaseService.getPurchaseStats(factoryId);
  const prByStatus = await countByStatus(PurchaseRequisition, factoryId, 'status', dateMatch(range));
  const poByStatus = await countByStatus(PurchaseOrder, factoryId, 'status', dateMatch(range));
  const spendAgg = await PurchaseOrder.aggregate([
    { $match: { factoryId, isDeleted: false, ...dateMatch(range) } },
    { $group: { _id: null, total: { $sum: '$totalAmount' } } },
  ]);
  return {
    period: range ? { from: range.from, to: range.to } : null,
    prByStatus,
    poByStatus,
    grnPendingQc: stats.grnPendingQc,
    spendMtd: spendAgg[0]?.total || 0,
    suppliers: stats.suppliers,
    poOpen: stats.poOpen,
    openPoValue: stats.openPoValue,
    rfqOpen: stats.rfqOpen,
  };
}

export async function getQualityDashboard(factoryId, filters = {}) {
  const range = resolveDateRange(filters);
  const stats = await qualityService.getQualityStats(factoryId);
  let periodCompleted = stats.completed;
  if (range) {
    periodCompleted = await QualityInspection.countDocuments({
      factoryId, isDeleted: false, status: 'COMPLETED', ...dateMatch(range, 'completedAt'),
    });
  }
  const byType = await QualityInspection.aggregate([
    { $match: { factoryId, isDeleted: false, ...dateMatch(range) } },
    { $group: { _id: '$inspectionType', count: { $sum: 1 } } },
  ]);
  return {
    period: range ? { from: range.from, to: range.to } : null,
    pending: stats.pending,
    inProgress: stats.inProgress,
    passed: stats.passed,
    failed: stats.failed,
    partial: stats.partial,
    rework: stats.rework,
    firstPassYield: stats.firstPassYield,
    totalInspections: stats.totalInspections,
    openCapa: stats.openCapa,
    defectsLogged: stats.defectsLogged,
    pendingGrns: stats.pendingGrns,
    periodCompleted,
    inspectionsByType: Object.fromEntries(byType.map((r) => [r._id, r.count])),
  };
}

export async function getWasteDashboard(factoryId, filters = {}) {
  const range = resolveDateRange(filters);
  const match = { factoryId, isDeleted: false, ...dateMatch(range) };
  const records = await WasteRecord.find(match);
  const byType = {};
  let totalCost = 0;
  let recovered = 0;
  for (const r of records) {
    byType[r.wasteType] = (byType[r.wasteType] || 0) + r.quantity;
    totalCost += r.totalCost || 0;
    if (r.status === 'RECOVERED') recovered += 1;
  }
  return {
    period: range ? { from: range.from, to: range.to } : null,
    byType,
    totalCost: Math.round(totalCost),
    count: records.length,
    recovered,
  };
}

export async function getMachineDashboard(factoryId) {
  const stats = await productionService.getProductionStats(factoryId);
  const machines = await Machine.find(applySoftDeleteFilter({ factoryId }));
  const byStatus = await countByStatus(Machine, factoryId);
  const active = machines.filter((m) => m.status === 'ACTIVE').length;
  const maintenance = machines.filter((m) => m.status === 'MAINTENANCE').length;
  const totalCapacity = machines.reduce((s, m) => s + (m.capacityPerHour || 0), 0);
  const utilizationPct = totalCapacity > 0 && stats.batchesInProgress > 0
    ? Math.min(100, Math.round((stats.batchesInProgress / machines.length) * 100))
    : 0;
  return {
    total: machines.length,
    active,
    maintenance,
    totalCapacityPerHour: totalCapacity,
    machinesByStatus: byStatus,
    batchesInProgress: stats.batchesInProgress,
    utilizationPct,
    lineCount: stats.lineCount,
  };
}

export async function getEmployeeDashboard(factoryId) {
  const assignments = await UserRoleAssignment.find({ factoryId }).populate('userId', 'firstName lastName status email');
  const active = assignments.filter((a) => a.userId?.status === 'ACTIVE').length;
  const byRole = {};
  for (const a of assignments) {
    const role = a.roleCode || a.roleId?.toString() || 'UNASSIGNED';
    byRole[role] = (byRole[role] || 0) + 1;
  }
  return {
    assignedUsers: assignments.length,
    activeUsers: active,
    inactiveUsers: assignments.length - active,
    usersByRole: byRole,
  };
}

export async function getFinancialDashboard(factoryId, filters = {}) {
  const range = resolveDateRange(filters) || resolveDateRange({ preset: 'mtd' });
  const spendAgg = await PurchaseOrder.aggregate([
    { $match: { factoryId, isDeleted: false, ...dateMatch(range) } },
    { $group: { _id: null, total: { $sum: '$totalAmount' } } },
  ]);
  const wasteAgg = await WasteRecord.aggregate([
    { $match: { factoryId, isDeleted: false, ...dateMatch(range) } },
    { $group: { _id: null, total: { $sum: '$totalCost' } } },
  ]);
  const invStats = await inventoryService.getInventoryStats(factoryId);
  return {
    period: { from: range.from, to: range.to },
    purchaseSpend: Math.round(spendAgg[0]?.total || 0),
    purchaseSpendMtd: Math.round(spendAgg[0]?.total || 0),
    wasteCostTotal: Math.round(wasteAgg[0]?.total || 0),
    stockValue: invStats.stockValue,
    netExposure: Math.round((spendAgg[0]?.total || 0) + (wasteAgg[0]?.total || 0)),
  };
}

export async function getApprovalDashboard(factoryId, filters = {}) {
  const range = resolveDateRange(filters);
  const dateFilter = dateMatch(range);
  const [pending, approved, rejected, changesRequested] = await Promise.all([
    ApprovalInstance.countDocuments({ factoryId, status: 'PENDING' }),
    ApprovalInstance.countDocuments({ factoryId, status: 'APPROVED', ...dateFilter }),
    ApprovalInstance.countDocuments({ factoryId, status: 'REJECTED', ...dateFilter }),
    ApprovalInstance.countDocuments({ factoryId, status: 'CHANGES_REQUESTED', ...dateFilter }),
  ]);
  const byType = await ApprovalInstance.aggregate([
    { $match: { factoryId, status: 'PENDING' } },
    { $group: { _id: '$documentType', count: { $sum: 1 } } },
  ]);
  return {
    period: range ? { from: range.from, to: range.to } : null,
    pending,
    approved,
    rejected,
    changesRequested,
    pendingByType: Object.fromEntries(byType.map((r) => [r._id, r.count])),
    approvalRate: approved + rejected > 0 ? Math.round((approved / (approved + rejected)) * 100) : 0,
  };
}

export async function listLowStockItems(factoryId, { page, limit, skip }) {
  const balances = await InventoryBalance.find({
    factoryId,
    inventoryType: 'RAW_MATERIAL',
    isDeleted: false,
  }).populate('materialId', 'materialCode name reorderLevel unit unitCost');

  const lowItems = balances
    .filter((b) => {
      const reorder = b.materialId?.reorderLevel ?? 0;
      return reorder > 0 && (b.available ?? 0) <= reorder;
    })
    .map((b) => ({
      materialId: b.materialId?._id,
      materialCode: b.materialId?.materialCode,
      name: b.materialId?.name,
      onHand: b.onHand,
      available: b.available,
      reorderLevel: b.materialId?.reorderLevel,
      unit: b.materialId?.unit,
      stockValue: Math.round((b.onHand || 0) * (b.materialId?.unitCost || 0)),
    }))
    .sort((a, b) => (a.available ?? 0) - (b.available ?? 0));

  const total = lowItems.length;
  const items = lowItems.slice(skip, skip + limit);
  return { items, total };
}

export async function listPendingApprovals(factoryId, { page, limit, skip }) {
  const filter = { factoryId, status: 'PENDING' };
  const [items, total] = await Promise.all([
    ApprovalInstance.find(filter)
      .sort({ submittedAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('submittedBy', 'firstName lastName email'),
    ApprovalInstance.countDocuments(filter),
  ]);
  return {
    items: items.map((i) => ({
      _id: i._id,
      documentType: i.documentType,
      documentId: i.documentId,
      status: i.status,
      currentLevel: i.currentLevel,
      submittedAt: i.submittedAt,
      submittedBy: i.submittedBy,
    })),
    total,
  };
}

export async function listTopDefects(factoryId, limit = 10, filters = {}) {
  const range = resolveDateRange(filters);
  const match = { factoryId, isDeleted: false, ...dateMatch(range) };
  const rows = await Defect.aggregate([
    { $match: match },
    { $group: { _id: '$categoryId', count: { $sum: '$quantity' }, occurrences: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: limit },
    {
      $lookup: {
        from: 'defectcategories',
        localField: '_id',
        foreignField: '_id',
        as: 'category',
      },
    },
    { $unwind: { path: '$category', preserveNullAndEmptyArrays: true } },
  ]);
  return rows.map((r) => ({
    categoryId: r._id,
    code: r.category?.code || 'UNCATEGORIZED',
    name: r.category?.name || 'Uncategorized',
    quantity: r.count,
    occurrences: r.occurrences,
  }));
}

const DASHBOARD_EXPORT_MAP = {
  factory: getFactoryDashboard,
  production: getProductionDashboard,
  inventory: getInventoryDashboard,
  purchase: getPurchaseDashboard,
  quality: getQualityDashboard,
  waste: getWasteDashboard,
  machine: getMachineDashboard,
  employee: getEmployeeDashboard,
  financial: getFinancialDashboard,
  approval: getApprovalDashboard,
};

export async function exportReportCsv(factoryId, type, filters = {}) {
  const fn = DASHBOARD_EXPORT_MAP[type];
  if (!fn) throw new Error('Unknown report type');
  const dash = await fn(factoryId, filters);
  const lines = ['key,value'];
  const flatten = (obj, prefix = '') => {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v instanceof Date) lines.push(`${key},${v.toISOString()}`);
      else if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key);
      else lines.push(`${key},${v ?? ''}`);
    }
  };
  flatten(dash);
  return lines.join('\n');
}
