import { Material } from './material.model.js';
import { InventoryBalance } from './inventoryBalance.model.js';
import { StockReservation } from './stockReservation.model.js';
import { InventoryTransaction } from './inventoryTransaction.model.js';
import { NotFoundError, ConflictError, ValidationError } from '../../shared/errors/AppError.js';
import { applySoftDeleteFilter } from '../../shared/utils/schema.js';
import {
  findRmBalances,
  aggregateRmTotals,
  getOrCreateRmBalance,
} from './inventoryStock.service.js';

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function createMaterial(data, userId) {
  const existing = await Material.findOne(applySoftDeleteFilter({
    factoryId: data.factoryId,
    materialCode: data.materialCode?.trim(),
  }));
  if (existing) throw new ConflictError(`Material code already exists: ${data.materialCode}`);
  return Material.create({ ...data, createdBy: userId, updatedBy: userId });
}

export async function updateMaterial(id, factoryId, data, userId) {
  const material = await Material.findOne(applySoftDeleteFilter({ _id: id, factoryId }));
  if (!material) throw new NotFoundError('Material not found');
  if (data.materialCode && data.materialCode !== material.materialCode) {
    const dup = await Material.findOne(applySoftDeleteFilter({
      factoryId,
      materialCode: data.materialCode.trim(),
      _id: { $ne: id },
    }));
    if (dup) throw new ConflictError(`Material code already exists: ${data.materialCode}`);
    material.materialCode = data.materialCode.trim();
  }
  if (data.name?.trim()) material.name = data.name.trim();
  if (data.category) material.category = data.category;
  if (data.unit) material.unit = data.unit;
  if (data.unitCost != null) material.unitCost = data.unitCost;
  if (data.reorderLevel != null) material.reorderLevel = data.reorderLevel;
  material.updatedBy = userId;
  await material.save();
  return material;
}

export async function listMaterials(factoryId, { page, limit, skip, search, category }) {
  const filter = applySoftDeleteFilter({ factoryId });
  if (category) filter.category = category;
  if (search?.trim()) {
    const re = new RegExp(escapeRegex(search.trim()), 'i');
    filter.$or = [{ materialCode: re }, { name: re }, { category: re }];
  }
  const [items, total] = await Promise.all([
    Material.find(filter).skip(skip).limit(limit).sort({ name: 1 }),
    Material.countDocuments(filter),
  ]);
  return { items, total };
}

export async function getMaterial(id, factoryId) {
  const filter = applySoftDeleteFilter({ _id: id });
  if (factoryId) filter.factoryId = factoryId;
  const material = await Material.findOne(filter);
  if (!material) throw new NotFoundError('Material not found');
  return material;
}

export async function getInventoryStats(factoryId) {
  const [materialCount, balanceCount, activeReservations, dockBalanceCount] = await Promise.all([
    Material.countDocuments(applySoftDeleteFilter({ factoryId })),
    InventoryBalance.countDocuments({ factoryId, inventoryType: 'RAW_MATERIAL', isDeleted: false }),
    StockReservation.countDocuments({ factoryId, status: 'ACTIVE', isDeleted: false }),
    InventoryBalance.countDocuments({
      factoryId,
      inventoryType: 'RAW_MATERIAL',
      isDeleted: false,
      storageBinId: null,
      available: { $gt: 0 },
    }),
  ]);

  const balances = await InventoryBalance.find({
    factoryId,
    inventoryType: 'RAW_MATERIAL',
    isDeleted: false,
  }).populate('materialId', 'reorderLevel unitCost materialCode');

  const byMaterial = new Map();
  let dockOnHand = 0;
  for (const b of balances) {
    const matId = (b.materialId?._id || b.materialId)?.toString();
    if (!matId) continue;
    const cur = byMaterial.get(matId) || { onHand: 0, available: 0, mat: b.materialId };
    cur.onHand += b.onHand || 0;
    cur.available += b.available || 0;
    byMaterial.set(matId, cur);
    if (!b.storageBinId && (b.available || 0) > 0) {
      dockOnHand += b.available || 0;
    }
  }

  let totalOnHand = 0;
  let stockValue = 0;
  let lowStock = 0;
  let outOfStock = 0;

  for (const [, agg] of byMaterial) {
    totalOnHand += agg.onHand;
    stockValue += agg.onHand * (agg.mat?.unitCost || 0);
    const reorder = agg.mat?.reorderLevel ?? 0;
    if (agg.available <= 0) outOfStock += 1;
    else if (reorder > 0 && agg.available <= reorder) lowStock += 1;
  }

  const materialsWithoutStock = Math.max(0, materialCount - byMaterial.size);
  outOfStock += materialsWithoutStock;

  return {
    materialCount,
    balanceCount,
    totalOnHand,
    dockOnHand,
    dockBalanceCount,
    stockValue: Math.round(stockValue),
    lowStock,
    outOfStock,
    activeReservations,
  };
}

export async function getOrCreateBalance(factoryId, organizationId, materialId, unit) {
  return getOrCreateRmBalance(factoryId, organizationId, materialId, unit, null);
}

export async function receiptMaterial({
  factoryId, organizationId, materialId, quantity, unit, userId, storageBinId,
  referenceType, referenceId,
}) {
  if (!quantity || quantity <= 0) throw new ValidationError('Receipt quantity must be greater than zero');
  const material = await getMaterial(materialId, factoryId);
  const balance = await getOrCreateRmBalance(
    factoryId,
    organizationId,
    materialId,
    unit || material.unit,
    storageBinId || null,
  );
  balance.onHand += quantity;
  balance.available = balance.onHand - balance.reserved;
  if (storageBinId) balance.locationId = storageBinId;
  await balance.save();

  const txRefType = referenceType || (storageBinId ? 'BIN_RECEIPT' : 'RECEIPT');
  const txRefId = referenceId || (storageBinId || undefined);

  await InventoryTransaction.create({
    organizationId,
    factoryId,
    type: 'RECEIPT',
    materialId,
    quantity,
    unit: unit || material.unit,
    referenceType: txRefType,
    referenceId: txRefId,
    performedBy: userId,
    createdBy: userId,
  });
  return balance;
}

export async function reserveMaterial({ factoryId, organizationId, materialId, quantity, unit, referenceType, referenceId, userId }) {
  const existing = await StockReservation.findOne({
    factoryId,
    materialId,
    referenceType,
    referenceId,
    status: 'ACTIVE',
    isDeleted: false,
  });
  if (existing) {
    if (existing.quantity === quantity) return existing;
    throw new ConflictError(
      `Active reservation already exists (${existing.quantity} ${existing.unit}). Release before re-reserving.`,
    );
  }

  const totals = await aggregateRmTotals(factoryId, materialId);
  if (totals.available < quantity) {
    throw new ConflictError(
      `Insufficient stock for material ${materialId}. Available: ${totals.available}, required: ${quantity}`,
    );
  }

  let remaining = quantity;
  const balances = await findRmBalances(factoryId, materialId);
  for (const balance of balances) {
    if (remaining <= 0) break;
    if (balance.available <= 0) continue;
    const take = Math.min(balance.available, remaining);
    balance.reserved += take;
    balance.available = balance.onHand - balance.reserved;
    await balance.save();
    remaining -= take;
  }

  const reservation = await StockReservation.create({
    organizationId,
    factoryId,
    materialId,
    quantity,
    unit,
    referenceType,
    referenceId,
    status: 'ACTIVE',
    createdBy: userId,
  });

  await InventoryTransaction.create({
    organizationId,
    factoryId,
    type: 'RESERVATION',
    materialId,
    quantity,
    unit,
    referenceType,
    referenceId,
    performedBy: userId,
    createdBy: userId,
  });

  return reservation;
}

export async function issueMaterial({
  factoryId, organizationId, materialId, quantity, unit,
  referenceType, referenceId, reservationReferenceType, reservationReferenceId, userId,
}) {
  const totals = await aggregateRmTotals(factoryId, materialId);
  if (totals.onHand < quantity) {
    throw new ConflictError('Insufficient on-hand stock to issue');
  }

  let remaining = quantity;
  const balances = await findRmBalances(factoryId, materialId);
  for (const balance of balances) {
    if (remaining <= 0) break;
    if (balance.onHand <= 0) continue;
    const take = Math.min(balance.onHand, remaining);
    const fromReserved = Math.min(balance.reserved, take);
    balance.reserved -= fromReserved;
    balance.onHand -= take;
    balance.available = balance.onHand - balance.reserved;
    await balance.save();
    remaining -= take;
  }

  if (remaining > 0) {
    throw new ConflictError(`Insufficient on-hand stock to issue (short by ${remaining})`);
  }

  const resRefType = reservationReferenceType || referenceType;
  const resRefId = reservationReferenceId || referenceId;
  let resRemaining = quantity;
  const reservations = await StockReservation.find({
    referenceType: resRefType,
    referenceId: resRefId,
    materialId,
    status: 'ACTIVE',
  }).sort({ createdAt: 1 });

  for (const res of reservations) {
    if (resRemaining <= 0) break;
    const consume = Math.min(resRemaining, res.quantity);
    resRemaining -= consume;
    if (consume >= res.quantity) {
      res.status = 'CONSUMED';
    } else {
      res.quantity -= consume;
    }
    res.updatedBy = userId;
    await res.save();
  }

  await InventoryTransaction.create({
    organizationId,
    factoryId,
    type: 'ISSUE',
    materialId,
    quantity,
    unit,
    referenceType,
    referenceId,
    performedBy: userId,
    createdBy: userId,
  });

  return balances[0] || await getOrCreateRmBalance(factoryId, organizationId, materialId, unit, null);
}

export async function releaseReservations({ factoryId, organizationId, referenceType, referenceId, userId }) {
  const reservations = await StockReservation.find({
    factoryId,
    referenceType,
    referenceId,
    status: 'ACTIVE',
    isDeleted: false,
  });

  for (const res of reservations) {
    let toRelease = res.quantity;
    const balances = await findRmBalances(factoryId, res.materialId);
    for (const balance of balances) {
      if (toRelease <= 0) break;
      if (balance.reserved <= 0) continue;
      const release = Math.min(balance.reserved, toRelease);
      balance.reserved -= release;
      balance.available = balance.onHand - balance.reserved;
      balance.updatedBy = userId;
      await balance.save();
      toRelease -= release;
    }

    res.status = 'RELEASED';
    res.updatedBy = userId;
    await res.save();

    await InventoryTransaction.create({
      organizationId,
      factoryId,
      type: 'RESERVATION_RELEASE',
      materialId: res.materialId,
      quantity: res.quantity,
      unit: res.unit,
      referenceType,
      referenceId,
      performedBy: userId,
      createdBy: userId,
    });
  }

  return reservations.length;
}

export async function getAvailability(factoryId, materialId) {
  const material = await getMaterial(materialId, factoryId);
  const totals = await aggregateRmTotals(factoryId, materialId);
  const balances = await findRmBalances(factoryId, materialId);
  const unit = balances.find((b) => b.unit)?.unit || material.unit;
  return {
    materialId,
    materialCode: material.materialCode,
    name: material.name,
    unit,
    onHand: totals.onHand,
    reserved: totals.reserved,
    available: totals.available,
    reorderLevel: material.reorderLevel ?? 0,
    isLowStock: totals.available > 0
      && material.reorderLevel > 0
      && totals.available <= material.reorderLevel,
    isOutOfStock: totals.available <= 0,
    locations: balances
      .filter((b) => b.storageBinId && b.onHand > 0)
      .map((b) => ({
        storageBinId: b.storageBinId,
        onHand: b.onHand,
        reserved: b.reserved,
        available: b.available,
      })),
  };
}

export async function getAvailableQty(factoryId, materialId) {
  const totals = await aggregateRmTotals(factoryId, materialId);
  return totals.available;
}

export async function listBalances(factoryId, { page, limit, skip, search, lowStockOnly, inventoryType } = {}) {
  const invType = inventoryType || 'RAW_MATERIAL';

  // Alerts must match getInventoryStats: include materials with no balance rows (never received)
  if (lowStockOnly) {
    return listStockAlerts(factoryId, { page, limit, skip, search, inventoryType: invType });
  }

  const filter = { factoryId, isDeleted: false, inventoryType: invType };

  let items;
  let total;

  if (search?.trim()) {
    const re = new RegExp(escapeRegex(search.trim()), 'i');
    const materials = await Material.find(applySoftDeleteFilter({
      factoryId,
      $or: [{ materialCode: re }, { name: re }],
    })).select('_id');
    filter.materialId = { $in: materials.map((m) => m._id) };
  }

  const query = InventoryBalance.find(filter)
    .populate('materialId', 'name materialCode unit reorderLevel unitCost category')
    .populate('skuId', 'skuCode name')
    .populate('storageBinId', 'binCode zoneCode warehouseId')
    .sort({ updatedAt: -1 });

  if (page != null && limit != null) {
    [items, total] = await Promise.all([
      query.clone().skip(skip).limit(limit),
      InventoryBalance.countDocuments(filter),
    ]);
  } else {
    items = await query;
    total = items.length;
  }

  const result = items.map((b) => {
    const mat = b.materialId;
    const reorder = mat?.reorderLevel ?? 0;
    const isLowStock = (b.available ?? 0) > 0 && reorder > 0 && b.available <= reorder;
    const isOutOfStock = (b.available ?? 0) <= 0;
    const stockValue = (b.onHand || 0) * (mat?.unitCost || 0);
    return {
      ...b.toObject(),
      reorderLevel: reorder,
      isLowStock,
      isOutOfStock,
      stockValue,
    };
  });

  return { items: result, total };
}

/**
 * Material-level low/out alerts (same rules as getInventoryStats).
 * Returns one synthetic balance row per alerting material so Store Keeper can Request PR
 * even when the material has never been received (no InventoryBalance yet).
 */
async function listStockAlerts(factoryId, { page, limit, skip = 0, search, inventoryType } = {}) {
  const matFilter = applySoftDeleteFilter({ factoryId });
  if (search?.trim()) {
    const re = new RegExp(escapeRegex(search.trim()), 'i');
    matFilter.$or = [{ materialCode: re }, { name: re }];
  }

  const materials = await Material.find(matFilter)
    .select('name materialCode unit reorderLevel unitCost category')
    .sort({ materialCode: 1 });

  const balances = await InventoryBalance.find({
    factoryId,
    inventoryType: inventoryType || 'RAW_MATERIAL',
    isDeleted: false,
    materialId: { $in: materials.map((m) => m._id) },
  }).populate('storageBinId', 'binCode zoneCode warehouseId');

  const byMaterial = new Map();
  for (const b of balances) {
    const matId = b.materialId?.toString();
    if (!matId) continue;
    const cur = byMaterial.get(matId) || {
      onHand: 0,
      reserved: 0,
      available: 0,
      unit: b.unit,
      sampleBalance: b,
    };
    cur.onHand += b.onHand || 0;
    cur.reserved += b.reserved || 0;
    cur.available += b.available || 0;
    if (!cur.unit && b.unit) cur.unit = b.unit;
    if (!cur.sampleBalance) cur.sampleBalance = b;
    byMaterial.set(matId, cur);
  }

  const alerts = [];
  for (const mat of materials) {
    const matId = mat._id.toString();
    const agg = byMaterial.get(matId) || { onHand: 0, reserved: 0, available: 0, unit: mat.unit };
    const reorder = mat.reorderLevel ?? 0;
    const isOutOfStock = (agg.available ?? 0) <= 0;
    const isLowStock = !isOutOfStock && reorder > 0 && agg.available <= reorder;
    if (!isOutOfStock && !isLowStock) continue;

    const sample = agg.sampleBalance;
    alerts.push({
      _id: sample?._id?.toString() || `alert-${matId}`,
      factoryId,
      materialId: mat,
      storageBinId: sample?.storageBinId || null,
      onHand: agg.onHand,
      reserved: agg.reserved,
      available: agg.available,
      unit: agg.unit || mat.unit,
      inventoryType: inventoryType || 'RAW_MATERIAL',
      reorderLevel: reorder,
      isLowStock,
      isOutOfStock,
      stockValue: Math.round((agg.onHand || 0) * (mat.unitCost || 0)),
      noBalanceYet: !sample,
      isDeleted: false,
    });
  }

  const total = alerts.length;
  let items = alerts;
  if (page != null && limit != null) {
    items = alerts.slice(skip, skip + limit);
  }

  return { items, total };
}

export async function listTransactions(factoryId, { page, limit, skip, materialId, type }) {
  const filter = { factoryId, isDeleted: false };
  if (materialId) filter.materialId = materialId;
  if (type) filter.type = type;

  const [items, total] = await Promise.all([
    InventoryTransaction.find(filter)
      .populate('materialId', 'materialCode name unit')
      .populate('skuId', 'skuCode name')
      .populate('performedBy', 'firstName lastName email')
      .skip(skip)
      .limit(limit)
      .sort({ createdAt: -1 }),
    InventoryTransaction.countDocuments(filter),
  ]);
  return { items, total };
}

export async function getOrCreateFgBalance(factoryId, organizationId, skuId, unit = 'PIECES', locationId = null) {
  let balance = await InventoryBalance.findOne({
    factoryId,
    skuId,
    inventoryType: 'FINISHED_GOODS',
    isDeleted: false,
  });
  if (!balance) {
    balance = await InventoryBalance.create({
      organizationId,
      factoryId,
      inventoryType: 'FINISHED_GOODS',
      skuId,
      locationId,
      unit,
      onHand: 0,
      reserved: 0,
      available: 0,
    });
  }
  return balance;
}

export async function receiptFinishedGoods({ factoryId, organizationId, skuId, quantity, locationId, storageBinId, userId }) {
  const balance = await getOrCreateFgBalance(factoryId, organizationId, skuId, 'PIECES', locationId);
  balance.onHand += quantity;
  balance.available = balance.onHand - balance.reserved;
  if (locationId) balance.locationId = locationId;
  if (storageBinId) balance.storageBinId = storageBinId;
  balance.dispatchStatus = balance.dispatchStatus || 'STAGED';
  await balance.save();

  await InventoryTransaction.create({
    organizationId,
    factoryId,
    type: 'RECEIPT',
    skuId,
    quantity,
    unit: balance.unit,
    performedBy: userId,
    createdBy: userId,
  });
  return balance;
}

export async function receiptRejectedGoods({ factoryId, organizationId, skuId, quantity, userId }) {
  let balance = await InventoryBalance.findOne({
    factoryId, skuId, inventoryType: 'REJECTED', isDeleted: false,
  });
  if (!balance) {
    balance = await InventoryBalance.create({
      organizationId,
      factoryId,
      inventoryType: 'REJECTED',
      skuId,
      unit: 'PIECES',
      onHand: 0,
      reserved: 0,
      available: 0,
    });
  }
  balance.onHand += quantity;
  balance.available = balance.onHand - balance.reserved;
  await balance.save();

  await InventoryTransaction.create({
    organizationId,
    factoryId,
    type: 'RECEIPT',
    skuId,
    quantity,
    unit: balance.unit,
    referenceType: 'QC_REJECT',
    performedBy: userId,
    createdBy: userId,
  });
  return balance;
}

export async function receiptScrap({ factoryId, organizationId, materialId, skuId, quantity, unit, userId }) {
  let balance = await InventoryBalance.findOne({
    factoryId,
    inventoryType: 'SCRAP',
    ...(materialId ? { materialId } : { skuId }),
    isDeleted: false,
  });
  if (!balance) {
    balance = await InventoryBalance.create({
      organizationId,
      factoryId,
      inventoryType: 'SCRAP',
      materialId,
      skuId,
      unit: unit || 'PIECES',
      onHand: 0,
      reserved: 0,
      available: 0,
    });
  }
  balance.onHand += quantity;
  balance.available = balance.onHand - balance.reserved;
  await balance.save();
  return balance;
}

export async function lookupSkuByBarcode(factoryId, barcode) {
  const { Sku } = await import('../sku/sku.model.js');
  const sku = await Sku.findOne({
    factoryId,
    $or: [{ barcode }, { skuCode: barcode }],
    isDeleted: false,
  });
  return sku;
}

export async function recordWip({ factoryId, organizationId, skuId, quantity, stage, userId }) {
  let balance = await InventoryBalance.findOne({
    factoryId, skuId, inventoryType: 'WIP', isDeleted: false,
  });
  if (!balance) {
    balance = await InventoryBalance.create({
      organizationId,
      factoryId,
      inventoryType: 'WIP',
      skuId,
      unit: 'PIECES',
      onHand: 0,
      reserved: 0,
      available: 0,
    });
  }
  balance.onHand = quantity;
  balance.available = quantity;
  await balance.save();

  await InventoryTransaction.create({
    organizationId,
    factoryId,
    type: 'TRANSFER',
    skuId,
    quantity,
    unit: 'PIECES',
    referenceType: 'WIP_STAGE',
    performedBy: userId,
    createdBy: userId,
  });
  return balance;
}
