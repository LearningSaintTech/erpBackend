import { Material } from './material.model.js';
import { dedupeInflight } from '../../shared/utils/inflight.js';
import { InventoryBalance } from './inventoryBalance.model.js';
import { StockReservation } from './stockReservation.model.js';
import { InventoryTransaction } from './inventoryTransaction.model.js';
import { Supplier } from '../purchase/supplier.model.js';
import { NotFoundError, ConflictError, ValidationError } from '../../shared/errors/AppError.js';
import { applySoftDeleteFilter, pickFields } from '../../shared/utils/schema.js';
import {
  findRmBalances,
  aggregateRmTotals,
  getOrCreateRmBalance,
} from './inventoryStock.service.js';
import { MATERIAL_CATEGORIES, MATERIAL_UNITS } from './inventory.defaults.js';
import { MaterialMasterRequest } from './materialMasterRequest.model.js';
import { persistMaterialImages } from '../../shared/services/localFiles.service.js';
import { StorageBin } from '../warehouse/storageBin.model.js';
import { Warehouse } from '../warehouse/warehouse.model.js';
import { computeOnOrderByMaterial } from '../purchase/purchase.onOrder.js';
import mongoose from 'mongoose';

/** Bin of the rows a movement touched: the bin when exactly one, else null (dock or spread). */
function singleBinOf(rows) {
  const bins = new Set(rows.map((r) => (r.storageBinId ? r.storageBinId.toString() : 'dock')));
  if (bins.size !== 1) return null;
  const only = [...bins][0];
  return only === 'dock' ? null : only;
}

const MATERIAL_WRITABLE_FIELDS = [
  'materialCode', 'name', 'category', 'unit', 'unitCost', 'reorderLevel', 'supplierId', 'images',
];

/** localFiles throws plain Error on bad type/size — surface as 422 instead of 500. */
async function persistImagesOrReject(inputs, code) {
  try {
    return await persistMaterialImages(inputs, code);
  } catch (err) {
    throw new ValidationError(err.message || 'Invalid image file');
  }
}

/** Best-effort undo of balance deltas already saved when a later step fails (no transactions). */
async function revertBalanceDeltas(applied) {
  for (const { id, onHand = 0, reserved = 0 } of applied) {
    await InventoryBalance.updateOne(
      { _id: id },
      { $inc: { onHand: -onHand, reserved: -reserved, available: -(onHand - reserved), __v: 1 } },
    ).catch(() => {});
  }
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeVendorKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/m\/s\s*/g, '')
    .replace(/pvt\.?\s*ltd\.?/g, '')
    .replace(/private\s+limited/g, '')
    .replace(/hoisery/g, 'hosiery')
    .replace(/texties/g, 'textiles')
    .replace(/agarwal/g, 'aggarwal')
    .replace(/darshini/g, 'darshni')
    .replace(/deepanshi/g, 'dipanshi')
    .replace(/[^a-z0-9]/g, '');
}

/** Duplicate-material key: trimmed, lower-case, single spaces (used by bulk import + master requests). */
export function normalizeMaterialName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Active (non-deleted) material with the same normalized name (and category when given). */
export async function findMaterialByNormalizedName(factoryId, name, category) {
  const key = normalizeMaterialName(name);
  if (!key) return null;
  const filter = applySoftDeleteFilter({ factoryId });
  if (category) filter.category = category;
  const candidates = await Material.find(filter).select('materialCode name category').lean();
  return candidates.find((m) => normalizeMaterialName(m.name) === key) || null;
}

function slugCodePart(value, max = 18) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toUpperCase()
    .slice(0, max) || 'MAT';
}

function buildMaterialCode(row, index) {
  if (row.materialCode?.trim()) return row.materialCode.trim().toUpperCase();
  const prefix = row.category === 'FABRIC' ? 'FAB' : row.category === 'THREAD' ? 'THR' : 'RM';
  return `${prefix}-${String(index + 1).padStart(3, '0')}-${slugCodePart(row.name)}`.slice(0, 40);
}

async function resolveSupplierId(factoryId, row, supplierByKey) {
  if (row.supplierId) return row.supplierId;
  const key = normalizeVendorKey(row.vendorName);
  if (!key) return undefined;
  if (supplierByKey.has(key)) return supplierByKey.get(key);
  for (const [sKey, id] of supplierByKey.entries()) {
    if (sKey.includes(key) || key.includes(sKey)) return id;
  }
  return undefined;
}

export async function createMaterial(data, userId) {
  const existing = await Material.findOne(applySoftDeleteFilter({
    factoryId: data.factoryId,
    materialCode: data.materialCode?.trim(),
  }));
  if (existing) throw new ConflictError(`Material code already exists: ${data.materialCode}`);
  const payload = {
    ...pickFields(data, MATERIAL_WRITABLE_FIELDS),
    organizationId: data.organizationId,
    factoryId: data.factoryId,
    createdBy: userId,
    updatedBy: userId,
  };
  if (!payload.supplierId) delete payload.supplierId;
  const imageInputs = payload.images;
  delete payload.images;
  // Validate/store files before the document exists so a bad file can't leave a half-saved material
  if (imageInputs?.length) {
    payload.images = await persistImagesOrReject(imageInputs, payload.materialCode);
  }
  return Material.create(payload);
}

/**
 * Bulk import materials from parsed spreadsheet rows.
 * Skips duplicate materialCode; optionally posts openingQty as dock receipt.
 */
export async function bulkImportMaterials({ factoryId, organizationId, items, postOpeningStock = true }, userId) {
  if (!Array.isArray(items) || !items.length) {
    throw new ValidationError('No materials to import');
  }

  const suppliers = await Supplier.find(applySoftDeleteFilter({ factoryId })).select('_id name').lean();
  const supplierByKey = new Map(suppliers.map((s) => [normalizeVendorKey(s.name), s._id]));

  const existing = await Material.find(applySoftDeleteFilter({ factoryId })).select('materialCode name').lean();
  const codeSet = new Set(existing.map((m) => m.materialCode.toUpperCase()));
  const nameSet = new Set(existing.map((m) => normalizeMaterialName(m.name)));

  const summary = {
    total: items.length,
    created: 0,
    skipped: 0,
    stockPosted: 0,
    errors: [],
  };

  for (let i = 0; i < items.length; i += 1) {
    const row = items[i];
    const name = String(row.name || '').trim();
    if (!name) {
      summary.skipped += 1;
      summary.errors.push({ row: i + 1, message: 'Missing name' });
      continue;
    }

    const category = MATERIAL_CATEGORIES.includes(row.category) ? row.category : 'FABRIC';
    const unit = MATERIAL_UNITS.includes(row.unit) ? row.unit : 'METERS';
    const materialCode = buildMaterialCode({ ...row, category }, i);

    if (codeSet.has(materialCode.toUpperCase()) || nameSet.has(normalizeMaterialName(name))) {
      summary.skipped += 1;
      continue;
    }

    try {
      const supplierId = await resolveSupplierId(factoryId, row, supplierByKey);
      const material = await Material.create({
        organizationId,
        factoryId,
        materialCode,
        name,
        category,
        unit,
        unitCost: Number(row.unitCost) || 0,
        reorderLevel: Number(row.reorderLevel) || 0,
        ...(supplierId ? { supplierId } : {}),
        createdBy: userId,
        updatedBy: userId,
      });

      codeSet.add(materialCode.toUpperCase());
      nameSet.add(normalizeMaterialName(name));
      summary.created += 1;

      const qty = Number(row.openingQty) || 0;
      if (postOpeningStock && qty > 0) {
        await receiptMaterial({
          factoryId,
          organizationId,
          materialId: material._id,
          quantity: qty,
          unit,
          userId,
        });
        summary.stockPosted += 1;
      }
    } catch (err) {
      summary.skipped += 1;
      summary.errors.push({ row: i + 1, name, message: err.message || 'Import failed' });
    }
  }

  return summary;
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
  if (data.unit && data.unit !== material.unit) {
    // Quantities on stock rows / reservations / open purchase docs are in the old unit
    const [hasStock, onOrder] = await Promise.all([
      InventoryBalance.exists({
        factoryId,
        materialId: material._id,
        isDeleted: false,
        $or: [{ onHand: { $gt: 0 } }, { reserved: { $gt: 0 } }],
      }),
      computeOnOrderByMaterial(factoryId, { materialIds: [material._id] }),
    ]);
    if (hasStock) {
      throw new ConflictError(`Cannot change unit of ${material.materialCode}: stock or reservations exist in ${material.unit}`);
    }
    if ((onOrder.get(material._id.toString()) || 0) > 0) {
      throw new ConflictError(
        `Cannot change unit of ${material.materialCode}: open requisitions / purchase orders / GRNs exist in ${material.unit}`,
      );
    }
    material.unit = data.unit;
  }
  if (data.unitCost != null) material.unitCost = data.unitCost;
  if (data.reorderLevel != null) material.reorderLevel = data.reorderLevel;
  if (data.supplierId !== undefined) {
    material.supplierId = data.supplierId || undefined;
  }
  if (data.images !== undefined) {
    const kept = (data.images || []).filter((img) => img?.url && !img.data && !img.dataUrl);
    const incoming = (data.images || []).filter((img) => img?.data || img?.dataUrl);
    const saved = incoming.length
      ? await persistImagesOrReject(incoming, material.materialCode)
      : [];
    material.images = [...kept.map((img) => ({ url: img.url, fileName: img.fileName || '' })), ...saved];
  }
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

/** Concurrent callers for the same factory share one computation (dashboard fan-out, perf audit). */
export const getInventoryStats = dedupeInflight((factoryId) => computeInventoryStats(factoryId));

async function computeInventoryStats(factoryId) {
  const [materialCount, balanceCount, activeReservations, dockBalanceCount, pendingMasterRequests] = await Promise.all([
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
    MaterialMasterRequest.countDocuments(applySoftDeleteFilter({ factoryId, status: 'PENDING' })),
  ]);

  const [dockRows, alerts] = await Promise.all([
    InventoryBalance.find({
      factoryId,
      inventoryType: 'RAW_MATERIAL',
      isDeleted: false,
      storageBinId: null,
      available: { $gt: 0 },
    }).select('available').lean(),
    computeMaterialStockAlerts(factoryId),
  ]);
  const dockOnHand = dockRows.reduce((sum, b) => sum + (b.available || 0), 0);

  let totalOnHand = 0;
  let stockValue = 0;
  let lowStock = 0;
  let outOfStock = 0;
  for (const a of alerts) {
    totalOnHand += a.onHand;
    stockValue += a.stockValue;
    if (a.isOutOfStock) outOfStock += 1;
    else if (a.isLowStock) lowStock += 1;
  }

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
    pendingMasterRequests,
  };
}

export async function getOrCreateBalance(factoryId, organizationId, materialId, unit) {
  return getOrCreateRmBalance(factoryId, organizationId, materialId, unit, null);
}

async function assertReceivableRmBin(storageBinId, factoryId) {
  const bin = await StorageBin.findOne(applySoftDeleteFilter({ _id: storageBinId, factoryId }));
  if (!bin) throw new NotFoundError('Storage bin not found');
  if (bin.status !== 'ACTIVE') throw new ConflictError('Bin is not active');
  const wh = await Warehouse.findOne(applySoftDeleteFilter({ _id: bin.warehouseId, factoryId }));
  if (!wh) throw new NotFoundError('Warehouse not found');
  if (wh.type !== 'RAW_MATERIAL') throw new ConflictError('Bin warehouse type must be RAW_MATERIAL');
  return bin;
}

export async function receiptMaterial({
  factoryId, organizationId, materialId, quantity, unit, userId, storageBinId,
  referenceType, referenceId, strictUnit = false, unitCost,
}) {
  if (!quantity || quantity <= 0) throw new ValidationError('Receipt quantity must be greater than zero');
  const material = await getMaterial(materialId, factoryId);
  if (strictUnit && unit && unit !== material.unit) {
    throw new ValidationError(`Unit ${unit} does not match material unit ${material.unit}`);
  }
  const cost = unitCost != null && Number.isFinite(Number(unitCost)) && Number(unitCost) >= 0
    ? Number(unitCost)
    : null;
  if (storageBinId) await assertReceivableRmBin(storageBinId, factoryId);
  // On-hand before this receipt, for the moving-average cost
  const before = cost != null ? await aggregateRmTotals(factoryId, materialId) : null;
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

  if (cost != null) {
    // Moving average over on-hand: (oldOnHand·oldCost + qty·cost) / (oldOnHand + qty)
    const oldOnHand = Math.max(0, before?.onHand || 0);
    const oldCost = material.unitCost || 0;
    const newCost = oldOnHand > 0
      ? (oldOnHand * oldCost + quantity * cost) / (oldOnHand + quantity)
      : cost;
    await Material.updateOne(
      { _id: material._id },
      { $set: { unitCost: Math.round(newCost * 10000) / 10000, updatedBy: userId, updatedAt: new Date() } },
    );
  }

  await InventoryTransaction.create({
    organizationId,
    factoryId,
    type: 'RECEIPT',
    materialId,
    quantity,
    unit: unit || material.unit,
    referenceType: txRefType,
    referenceId: txRefId,
    storageBinId: storageBinId || null,
    ...(cost != null ? { unitCost: cost } : {}),
    performedBy: userId,
    createdBy: userId,
  });
  return balance;
}

export async function reserveMaterial({
  factoryId, organizationId, materialId, quantity, unit, referenceType, referenceId, userId, note,
}) {
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

  // Create the reservation first (enum/cast validation) so a failure can't leak balance.reserved
  const reservation = await StockReservation.create({
    organizationId,
    factoryId,
    materialId,
    quantity,
    unit,
    referenceType,
    referenceId,
    status: 'ACTIVE',
    ...(note ? { note } : {}),
    createdBy: userId,
  });

  const applied = [];
  const touched = [];
  try {
    let remaining = quantity;
    const balances = await findRmBalances(factoryId, materialId);
    for (const balance of balances) {
      if (remaining <= 0) break;
      if (balance.available <= 0) continue;
      const take = Math.min(balance.available, remaining);
      balance.reserved += take;
      balance.available = balance.onHand - balance.reserved;
      await balance.save();
      applied.push({ id: balance._id, reserved: take });
      touched.push(balance);
      remaining -= take;
    }
    if (remaining > 0) {
      throw new ConflictError(`Insufficient stock for material ${materialId} (short by ${remaining})`);
    }
  } catch (err) {
    await revertBalanceDeltas(applied);
    await StockReservation.deleteOne({ _id: reservation._id }).catch(() => {});
    throw err;
  }

  await InventoryTransaction.create({
    organizationId,
    factoryId,
    type: 'RESERVATION',
    materialId,
    quantity,
    unit,
    referenceType,
    referenceId,
    storageBinId: singleBinOf(touched),
    ...(note ? { note } : {}),
    performedBy: userId,
    createdBy: userId,
  });

  return reservation;
}

export async function issueMaterial({
  factoryId, organizationId, materialId, quantity, unit,
  referenceType, referenceId, reservationReferenceType, reservationReferenceId, userId,
}) {
  const resRefType = reservationReferenceType || referenceType;
  const resRefId = reservationReferenceId || referenceId;
  // Only this caller's own ACTIVE reservations may be drawn down — never other documents' holds
  const reservations = resRefType && mongoose.isValidObjectId(resRefId)
    ? await StockReservation.find({
      factoryId,
      materialId,
      referenceType: resRefType,
      referenceId: resRefId,
      status: 'ACTIVE',
      isDeleted: false,
    }).sort({ createdAt: 1 })
    : [];
  const ownReservedQty = reservations.reduce((sum, r) => sum + (r.quantity || 0), 0);

  const totals = await aggregateRmTotals(factoryId, materialId);
  if (totals.available + ownReservedQty < quantity) {
    throw new ConflictError(
      `Insufficient stock to issue. Available: ${totals.available}, own reserved: ${ownReservedQty}, required: ${quantity}`,
    );
  }

  // Plan per row: draw own reserved qty from reserved buckets first, then free (unreserved) stock
  const balances = await findRmBalances(factoryId, materialId);
  const plan = new Map();
  let reservedLeft = Math.min(ownReservedQty, quantity);
  let remaining = quantity;
  for (const balance of balances) {
    if (reservedLeft <= 0) break;
    const fromReserved = Math.min(balance.reserved || 0, balance.onHand || 0, reservedLeft);
    if (fromReserved <= 0) continue;
    plan.set(balance, { reserved: fromReserved, onHand: fromReserved });
    reservedLeft -= fromReserved;
    remaining -= fromReserved;
  }
  for (const balance of balances) {
    if (remaining <= 0) break;
    const delta = plan.get(balance) || { reserved: 0, onHand: 0 };
    const free = Math.max(0, (balance.onHand || 0) - (balance.reserved || 0));
    const fromFree = Math.min(free, remaining);
    if (fromFree <= 0) continue;
    delta.onHand += fromFree;
    plan.set(balance, delta);
    remaining -= fromFree;
  }
  if (remaining > 0) {
    throw new ConflictError(`Insufficient stock to issue (short by ${remaining})`);
  }

  // Claim the reservation draw-down atomically BEFORE touching balances: each claim only matches
  // the exact (ACTIVE, quantity) we planned with, so a concurrent issue on the same hold cannot
  // also draw it from the reserved buckets (which would eat other documents' holds and leave a
  // ghost ACTIVE reservation behind).
  const claimedReservations = [];
  const revertReservationClaims = async () => {
    for (const { id, quantity: originalQty, consumedStatus } of claimedReservations) {
      await StockReservation.updateOne(
        { _id: id, status: consumedStatus ? 'CONSUMED' : 'ACTIVE' },
        { $set: { status: 'ACTIVE', quantity: originalQty, updatedBy: userId, updatedAt: new Date() } },
      ).catch(() => {});
    }
  };
  let resRemaining = quantity;
  for (const res of reservations) {
    if (resRemaining <= 0) break;
    const consume = Math.min(resRemaining, res.quantity);
    const fullyConsumed = consume >= res.quantity;
    const claimed = await StockReservation.findOneAndUpdate(
      { _id: res._id, status: 'ACTIVE', isDeleted: false, quantity: res.quantity },
      fullyConsumed
        ? { $set: { status: 'CONSUMED', updatedBy: userId, updatedAt: new Date() } }
        : { $inc: { quantity: -consume }, $set: { updatedBy: userId, updatedAt: new Date() } },
      { new: true },
    );
    if (!claimed) {
      await revertReservationClaims();
      throw new ConflictError('Reservation changed while issuing — refresh and retry');
    }
    claimedReservations.push({ id: res._id, quantity: res.quantity, consumedStatus: fullyConsumed });
    resRemaining -= consume;
  }

  const applied = [];
  try {
    for (const [balance, delta] of plan) {
      balance.reserved -= delta.reserved;
      balance.onHand -= delta.onHand;
      balance.available = balance.onHand - balance.reserved;
      balance.updatedBy = userId;
      await balance.save();
      applied.push({ id: balance._id, onHand: -delta.onHand, reserved: -delta.reserved });
    }
  } catch (err) {
    await revertBalanceDeltas(applied);
    await revertReservationClaims();
    throw err;
  }

  await InventoryTransaction.create({
    organizationId,
    factoryId,
    type: 'ISSUE',
    materialId,
    quantity,
    unit,
    referenceType,
    referenceId: mongoose.isValidObjectId(referenceId) ? referenceId : undefined,
    storageBinId: singleBinOf([...plan.keys()]),
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

  let releasedCount = 0;
  for (const candidate of reservations) {
    // Claim ACTIVE → RELEASED first so a concurrent issue/release can't consume the same hold twice
    const res = await StockReservation.findOneAndUpdate(
      { _id: candidate._id, status: 'ACTIVE', isDeleted: false },
      { $set: { status: 'RELEASED', updatedBy: userId, updatedAt: new Date() } },
      { new: true },
    );
    if (!res) continue;

    const applied = [];
    const touched = [];
    let toRelease = res.quantity;
    try {
      const balances = await findRmBalances(factoryId, res.materialId);
      for (const balance of balances) {
        if (toRelease <= 0) break;
        if (balance.reserved <= 0) continue;
        const release = Math.min(balance.reserved, toRelease);
        balance.reserved -= release;
        balance.available = balance.onHand - balance.reserved;
        balance.updatedBy = userId;
        await balance.save();
        applied.push({ id: balance._id, reserved: -release });
        touched.push(balance);
        toRelease -= release;
      }
    } catch (err) {
      await revertBalanceDeltas(applied);
      await StockReservation.updateOne(
        { _id: res._id, status: 'RELEASED' },
        { $set: { status: 'ACTIVE', updatedBy: userId, updatedAt: new Date() } },
      ).catch(() => {});
      throw err;
    }

    const releasedQty = res.quantity - Math.max(0, toRelease);
    await InventoryTransaction.create({
      organizationId,
      factoryId,
      type: 'RESERVATION_RELEASE',
      materialId: res.materialId,
      quantity: releasedQty,
      unit: res.unit,
      referenceType,
      referenceId,
      storageBinId: singleBinOf(touched),
      ...(toRelease > 0 ? { note: `Reservation ${res.quantity}, only ${releasedQty} was still held on balances` } : {}),
      performedBy: userId,
      createdBy: userId,
    });
    releasedCount += 1;
  }

  return releasedCount;
}

/** Active MANUAL holds (the manual release form picks from these). */
export async function listManualReservations(factoryId, { materialId } = {}) {
  const filter = { factoryId, referenceType: 'MANUAL', status: 'ACTIVE', isDeleted: false };
  if (materialId) filter.materialId = materialId;
  return StockReservation.find(filter)
    .populate('materialId', 'materialCode name unit')
    .populate('createdBy', 'firstName lastName')
    .sort({ createdAt: -1 })
    .limit(200);
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

/**
 * The single stock-alert definition (Inventory stats, alerts list, balance rows, reports).
 * Per material, from material totals over every RM row (dock + bins); materials never received
 * are included with zero stock (→ out of stock).
 *   isOutOfStock = available <= 0
 *   isLowStock   = !isOutOfStock && reorderLevel > 0 && available <= reorderLevel
 * onOrderQty = qty on open PRs + unreceived open-PO qty + GRNs awaiting QC (see purchase.onOrder).
 *
 * @param {string|ObjectId} factoryId
 * @param {{ materialIds?: Array<string|ObjectId>, search?: string }} [opts]
 * @returns {Promise<Array<{ materialId, materialCode, name, unit, category, onHand, reserved,
 *   available, reorderLevel, unitCost, stockValue, isLowStock, isOutOfStock, onOrderQty, hasBalance }>>}
 */
export async function computeMaterialStockAlerts(factoryId, { materialIds, search } = {}) {
  const matFilter = applySoftDeleteFilter({ factoryId });
  if (materialIds) matFilter._id = { $in: materialIds };
  if (search?.trim()) {
    const re = new RegExp(escapeRegex(search.trim()), 'i');
    matFilter.$or = [{ materialCode: re }, { name: re }];
  }
  const materials = await Material.find(matFilter)
    .select('materialCode name unit reorderLevel unitCost category')
    .sort({ materialCode: 1 })
    .lean();
  if (!materials.length) return [];
  const ids = materials.map((m) => m._id);
  // Whole-factory call (stats / dashboards): skip the huge `$in: [every material id]` filters —
  // rows for other materials are simply never looked up below (perf audit).
  const allMaterials = !materialIds && !search?.trim();

  const balanceFilter = { factoryId, inventoryType: 'RAW_MATERIAL', isDeleted: false };
  if (!allMaterials) balanceFilter.materialId = { $in: ids };
  const [balances, onOrder] = await Promise.all([
    InventoryBalance.find(balanceFilter).select('materialId onHand reserved available').lean(),
    computeOnOrderByMaterial(factoryId, allMaterials ? {} : { materialIds: ids }),
  ]);

  const totals = new Map();
  for (const b of balances) {
    const key = b.materialId?.toString();
    if (!key) continue;
    const cur = totals.get(key) || { onHand: 0, reserved: 0, available: 0 };
    cur.onHand += b.onHand || 0;
    cur.reserved += b.reserved || 0;
    cur.available += b.available || 0;
    totals.set(key, cur);
  }

  return materials.map((mat) => {
    const key = mat._id.toString();
    const agg = totals.get(key);
    const onHand = agg?.onHand || 0;
    const reserved = agg?.reserved || 0;
    const available = agg?.available || 0;
    const reorderLevel = mat.reorderLevel ?? 0;
    const unitCost = mat.unitCost || 0;
    const isOutOfStock = available <= 0;
    const isLowStock = !isOutOfStock && reorderLevel > 0 && available <= reorderLevel;
    return {
      materialId: mat._id,
      materialCode: mat.materialCode,
      name: mat.name,
      unit: mat.unit,
      category: mat.category,
      onHand,
      reserved,
      available,
      reorderLevel,
      unitCost,
      stockValue: Math.round(onHand * unitCost),
      isLowStock,
      isOutOfStock,
      onOrderQty: onOrder.get(key) || 0,
      hasBalance: !!agg,
    };
  });
}

export async function listBalances(factoryId, {
  page, limit, skip, search, lowStockOnly, inventoryType, includeEmpty = false,
} = {}) {
  const invType = inventoryType || 'RAW_MATERIAL';

  // Alerts must match getInventoryStats: include materials with no balance rows (never received)
  if (lowStockOnly) {
    return listStockAlerts(factoryId, { page, limit, skip, search, inventoryType: invType });
  }

  const filter = { factoryId, isDeleted: false, inventoryType: invType };
  // Emptied dock rows (all stock put away / issued) are noise unless explicitly requested
  if (!includeEmpty) {
    filter.$nor = [{ storageBinId: null, onHand: { $lte: 0 }, reserved: { $lte: 0 } }];
  }

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

  // Flags come from the material total (all rows), not the individual bin row
  const materialIds = [...new Set(items
    .map((b) => (b.materialId?._id || b.materialId)?.toString())
    .filter(Boolean))];
  const alertByMaterial = new Map();
  if (invType === 'RAW_MATERIAL' && materialIds.length) {
    const alerts = await computeMaterialStockAlerts(factoryId, { materialIds });
    for (const a of alerts) alertByMaterial.set(a.materialId.toString(), a);
  }

  const result = items.map((b) => {
    const mat = b.materialId;
    const alert = alertByMaterial.get((mat?._id || mat)?.toString());
    const reorder = mat?.reorderLevel ?? 0;
    const stockValue = (b.onHand || 0) * (mat?.unitCost || 0);
    return {
      ...b.toObject(),
      reorderLevel: reorder,
      isLowStock: alert ? alert.isLowStock : false,
      isOutOfStock: alert ? alert.isOutOfStock : (b.available ?? 0) <= 0,
      materialOnHand: alert?.onHand,
      materialAvailable: alert?.available,
      onOrderQty: alert?.onOrderQty ?? 0,
      stockValue,
    };
  });

  return { items: result, total };
}

/**
 * Material-level low/out alerts (computeMaterialStockAlerts).
 * Returns one synthetic balance row per alerting material so Store Keeper can Request PR
 * even when the material has never been received (no InventoryBalance yet).
 */
async function listStockAlerts(factoryId, { page, limit, skip = 0, search, inventoryType } = {}) {
  const invType = inventoryType || 'RAW_MATERIAL';
  const alerting = (await computeMaterialStockAlerts(factoryId, { search }))
    .filter((a) => a.isOutOfStock || a.isLowStock);

  const total = alerting.length;
  const pageAlerts = page != null && limit != null ? alerting.slice(skip, skip + limit) : alerting;

  // A representative balance row (for row id / bin) per alerting material on this page
  const samples = pageAlerts.length
    ? await InventoryBalance.find({
      factoryId,
      inventoryType: invType,
      isDeleted: false,
      materialId: { $in: pageAlerts.map((a) => a.materialId) },
    }).populate('storageBinId', 'binCode zoneCode warehouseId').sort({ storageBinId: 1 })
    : [];
  const sampleByMaterial = new Map();
  for (const b of samples) {
    const key = b.materialId?.toString();
    if (key && !sampleByMaterial.has(key)) sampleByMaterial.set(key, b);
  }

  const items = pageAlerts.map((a) => {
    const key = a.materialId.toString();
    const sample = sampleByMaterial.get(key);
    return {
      _id: sample?._id?.toString() || `alert-${key}`,
      factoryId,
      materialId: {
        _id: a.materialId,
        materialCode: a.materialCode,
        name: a.name,
        unit: a.unit,
        reorderLevel: a.reorderLevel,
        unitCost: a.unitCost,
        category: a.category,
      },
      storageBinId: sample?.storageBinId || null,
      onHand: a.onHand,
      reserved: a.reserved,
      available: a.available,
      unit: a.unit,
      inventoryType: invType,
      reorderLevel: a.reorderLevel,
      isLowStock: a.isLowStock,
      isOutOfStock: a.isOutOfStock,
      onOrderQty: a.onOrderQty,
      stockValue: a.stockValue,
      noBalanceYet: !a.hasBalance,
      isDeleted: false,
    };
  });

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
  return { items: await withReferenceNumbers(items), total };
}

/**
 * Movement rows carry only referenceType + referenceId; resolve the human document number
 * (GRN / PO / PR / batch / inspection / bin) so the history is traceable from the UI.
 */
const REFERENCE_SOURCES = {
  GOODS_RECEIPT: ['GoodsReceipt', 'grnNumber'],
  PURCHASE_ORDER: ['PurchaseOrder', 'poNumber'],
  PURCHASE_REQUISITION: ['PurchaseRequisition', 'prNumber'],
  QUALITY_INSPECTION: ['QualityInspection', 'inspectionNumber'],
  QC_REJECT: ['QualityInspection', 'inspectionNumber'],
  PRODUCTION_BATCH: ['ProductionBatch', 'batchNumber'],
  WIP_BATCH: ['ProductionBatch', 'batchNumber'],
  PRODUCTION_ORDER: ['ProductionOrder', 'orderNumber'],
  PUT_AWAY: ['StorageBin', 'binCode'],
  PICK: ['StorageBin', 'binCode'],
  BIN_TRANSFER: ['StorageBin', 'binCode'],
  FG_PUT_AWAY: ['StorageBin', 'binCode'],
  CYCLE_COUNT: ['CycleCount', 'countNumber'],
};

async function withReferenceNumbers(items) {
  const rows = items.map((t) => (t.toObject ? t.toObject() : t));
  const idsByType = new Map();
  for (const t of rows) {
    if (!t.referenceId || !REFERENCE_SOURCES[t.referenceType]) continue;
    if (!idsByType.has(t.referenceType)) idsByType.set(t.referenceType, new Set());
    idsByType.get(t.referenceType).add(t.referenceId.toString());
  }
  const labels = new Map();
  await Promise.all([...idsByType.entries()].map(async ([type, ids]) => {
    const [modelName, field] = REFERENCE_SOURCES[type];
    const Model = mongoose.models[modelName];
    if (!Model) return;
    try {
      const docs = await Model.find({ _id: { $in: [...ids] } }).select(field).lean();
      for (const d of docs) if (d[field]) labels.set(`${type}:${d._id}`, d[field]);
    } catch {
      // a missing label just falls back to the id
    }
  }));
  return rows.map((t) => {
    const referenceNumber = t.referenceId ? labels.get(`${t.referenceType}:${t.referenceId}`) : undefined;
    return referenceNumber ? { ...t, referenceNumber } : t;
  });
}

export async function getOrCreateFgBalance(factoryId, organizationId, skuId, unit = 'PIECES', locationId = null) {
  let balance = await InventoryBalance.findOne({
    factoryId,
    skuId,
    inventoryType: 'FINISHED_GOODS',
    isDeleted: false,
  });
  if (!balance) {
    try {
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
    } catch (err) {
      // Concurrent create hit the unique FG index — re-read the winner's row
      if (err?.code !== 11000) throw err;
      balance = await InventoryBalance.findOne({
        factoryId, skuId, inventoryType: 'FINISHED_GOODS', isDeleted: false,
      });
      if (!balance) throw err;
    }
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
