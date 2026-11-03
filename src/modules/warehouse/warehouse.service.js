import { Warehouse } from './warehouse.model.js';
import { StorageBin } from './storageBin.model.js';
import { Zone } from './zone.model.js';
import { Rack } from './rack.model.js';
import { Shelf } from './shelf.model.js';
import { InventoryBalance } from '../inventory/inventoryBalance.model.js';
import { InventoryTransaction } from '../inventory/inventoryTransaction.model.js';
import { Material } from '../inventory/material.model.js';
import { Sku } from '../sku/sku.model.js';
import { NotFoundError, ConflictError } from '../../shared/errors/AppError.js';
import { applySoftDeleteFilter, pickFields } from '../../shared/utils/schema.js';
import { getOrCreateRmBalance } from '../inventory/inventoryStock.service.js';

const ROUND3 = (n) => Math.round((n || 0) * 1000) / 1000;

// Ensure populate targets are registered when this module loads first
void Material;
void Sku;

export async function getWarehouseStats(factoryId) {
  const base = applySoftDeleteFilter({ factoryId });
  const [
    warehousesTotal,
    rmWarehouses,
    fgWarehouses,
    binsTotal,
    binsActive,
    binsFrozen,
    dispatchReady,
    stagedFg,
    openCycleCounts,
  ] = await Promise.all([
    Warehouse.countDocuments(base),
    Warehouse.countDocuments({ ...base, type: 'RAW_MATERIAL' }),
    Warehouse.countDocuments({ ...base, type: 'FINISHED_GOODS' }),
    StorageBin.countDocuments(base),
    StorageBin.countDocuments({ ...base, status: 'ACTIVE' }),
    StorageBin.countDocuments({ ...base, status: 'FROZEN' }),
    InventoryBalance.countDocuments({ factoryId, inventoryType: 'FINISHED_GOODS', dispatchStatus: 'READY_FOR_DISPATCH', isDeleted: false }),
    InventoryBalance.countDocuments({ factoryId, inventoryType: 'FINISHED_GOODS', dispatchStatus: 'STAGED', isDeleted: false }),
    (await import('./cycleCount.model.js')).CycleCount.countDocuments({ ...base, status: { $in: ['DRAFT', 'IN_PROGRESS'] } }),
  ]);

  const rmInBins = await InventoryBalance.countDocuments({
    factoryId,
    inventoryType: 'RAW_MATERIAL',
    storageBinId: { $type: 'objectId' },
    onHand: { $gt: 0 },
    isDeleted: false,
  });

  return {
    warehousesTotal,
    rmWarehouses,
    fgWarehouses,
    binsTotal,
    binsActive,
    binsFrozen,
    dispatchReady,
    stagedFg,
    openCycleCounts,
    rmInBins,
  };
}

export async function createWarehouse(data, userId) {
  const existing = await Warehouse.findOne(applySoftDeleteFilter({
    factoryId: data.factoryId,
    warehouseCode: data.warehouseCode,
  }));
  if (existing) throw new ConflictError('Warehouse code already exists');
  if (data.isDefault) {
    await Warehouse.updateMany({ factoryId: data.factoryId, type: data.type, isDefault: true }, { isDefault: false });
  }
  return Warehouse.create({
    ...pickFields(data, ['warehouseCode', 'name', 'type', 'address', 'isDefault']),
    factoryId: data.factoryId,
    organizationId: data.organizationId,
    createdBy: userId,
    updatedBy: userId,
  });
}

export async function listWarehouses(factoryId, { page, limit, skip, search, type }) {
  const filter = applySoftDeleteFilter({ factoryId });
  if (type) filter.type = type;
  if (search) {
    const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ warehouseCode: re }, { name: re }];
  }
  const [items, total] = await Promise.all([
    Warehouse.find(filter).skip(skip).limit(limit).sort({ name: 1 }),
    Warehouse.countDocuments(filter),
  ]);
  return { items, total };
}

export async function getWarehouse(id, factoryId) {
  const filter = applySoftDeleteFilter({ _id: id });
  if (factoryId) filter.factoryId = factoryId;
  const wh = await Warehouse.findOne(filter);
  if (!wh) throw new NotFoundError('Warehouse not found');
  return wh;
}

export async function updateWarehouse(id, data, userId, factoryId) {
  const wh = await getWarehouse(id, factoryId);
  if (data.isDefault) {
    await Warehouse.updateMany({ factoryId: wh.factoryId, type: wh.type, isDefault: true }, { isDefault: false });
  }
  const allowed = ['name', 'address', 'isDefault', 'status'];
  for (const key of allowed) {
    if (data[key] !== undefined) wh[key] = data[key];
  }
  wh.updatedBy = userId;
  await wh.save();
  return wh;
}

export async function getDefaultWarehouse(factoryId, type = 'RAW_MATERIAL') {
  let wh = await Warehouse.findOne({ factoryId, type, isDefault: true, isDeleted: false });
  if (!wh) wh = await Warehouse.findOne({ factoryId, type, isDeleted: false });
  return wh;
}

/** zone is the populated Zone doc reached via shelf/rack — it must exist and sit in the bin's warehouse. */
function assertZoneInWarehouse(zone, warehouseId) {
  if (!zone?.warehouseId || zone.isDeleted) throw new NotFoundError('Zone not found');
  if (zone.warehouseId.toString() !== String(warehouseId)) {
    throw new ConflictError('Zone does not belong to this warehouse');
  }
}

async function resolveBinPlacement(data, factoryId) {
  const resolved = { ...data };
  if (data.shelfId) {
    const shelf = await Shelf.findOne(applySoftDeleteFilter({ _id: data.shelfId, factoryId }))
      .populate({ path: 'rackId', populate: { path: 'zoneId' } });
    if (!shelf) throw new NotFoundError('Shelf not found');
    resolved.shelfId = shelf._id;
    resolved.rackId = shelf.rackId?._id || shelf.rackId;
    resolved.zoneId = shelf.rackId?.zoneId?._id || shelf.rackId?.zoneId;
    resolved.zoneCode = shelf.rackId?.zoneId?.zoneCode || resolved.zoneCode;
    assertZoneInWarehouse(shelf.rackId?.zoneId, data.warehouseId);
  } else if (data.rackId) {
    const rack = await Rack.findOne(applySoftDeleteFilter({ _id: data.rackId, factoryId }))
      .populate('zoneId');
    if (!rack) throw new NotFoundError('Rack not found');
    assertZoneInWarehouse(rack.zoneId, data.warehouseId);
    resolved.rackId = rack._id;
    resolved.zoneId = rack.zoneId?._id || rack.zoneId;
    resolved.zoneCode = rack.zoneId?.zoneCode || resolved.zoneCode;
  } else if (data.zoneId) {
    const zone = await Zone.findOne(applySoftDeleteFilter({ _id: data.zoneId, factoryId }));
    if (!zone) throw new NotFoundError('Zone not found');
    if (zone.warehouseId.toString() !== data.warehouseId.toString()) {
      throw new ConflictError('Zone does not belong to this warehouse');
    }
    resolved.zoneId = zone._id;
    resolved.zoneCode = zone.zoneCode;
  }
  return resolved;
}

async function assertBinWarehouseType(bin, expectedType) {
  const wh = await getWarehouse(bin.warehouseId, bin.factoryId);
  if (expectedType && wh.type !== expectedType) {
    throw new ConflictError(`Bin warehouse type must be ${expectedType}`);
  }
  return wh;
}

export async function createStorageBin(data, userId) {
  await getWarehouse(data.warehouseId, data.factoryId);
  const existing = await StorageBin.findOne(applySoftDeleteFilter({
    factoryId: data.factoryId,
    warehouseId: data.warehouseId,
    binCode: data.binCode,
  }));
  if (existing) throw new ConflictError('Bin code already exists in this warehouse');
  const placement = await resolveBinPlacement({
    ...pickFields(data, ['zoneCode', 'zoneId', 'rackId', 'shelfId', 'binCode', 'barcode', 'capacity', 'status']),
    warehouseId: data.warehouseId,
    factoryId: data.factoryId,
    organizationId: data.organizationId,
  }, data.factoryId);
  // Drop empty optional placement FKs so Mongo doesn't store ""
  for (const key of ['zoneId', 'rackId', 'shelfId']) {
    if (!placement[key]) delete placement[key];
  }
  const binCode = placement.binCode;
  // Avoid BIN-BIN-… when callers already pass a BIN-prefixed binCode
  const barcode = placement.barcode
    || (binCode
      ? (/^BIN-/i.test(binCode) ? binCode : `BIN-${binCode}`)
      : undefined);
  return StorageBin.create({ ...placement, barcode, createdBy: userId, updatedBy: userId });
}

export async function listStorageBins(factoryId, warehouseId, { page, limit, skip, search, status }) {
  const filter = applySoftDeleteFilter({ factoryId, warehouseId });
  if (status) filter.status = status;
  if (search) {
    const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ binCode: re }, { zoneCode: re }, { barcode: re }];
  }
  const [items, total] = await Promise.all([
    StorageBin.find(filter).skip(skip).limit(limit).sort({ zoneCode: 1, binCode: 1 }),
    StorageBin.countDocuments(filter),
  ]);
  return { items, total };
}

export async function updateStorageBin(binId, warehouseId, data, userId, factoryId) {
  const bin = await StorageBin.findOne(applySoftDeleteFilter({ _id: binId, warehouseId, factoryId }));
  if (!bin) throw new NotFoundError('Storage bin not found');

  const placementKeys = ['zoneId', 'rackId', 'shelfId'];
  const wantsPlacement = placementKeys.some((k) => data[k] !== undefined);
  if (wantsPlacement) {
    const placement = await resolveBinPlacement({
      warehouseId,
      zoneId: data.zoneId !== undefined ? (data.zoneId || null) : bin.zoneId,
      rackId: data.rackId !== undefined ? (data.rackId || null) : bin.rackId,
      shelfId: data.shelfId !== undefined ? (data.shelfId || null) : bin.shelfId,
      zoneCode: data.zoneCode !== undefined ? data.zoneCode : bin.zoneCode,
    }, factoryId);
    bin.zoneId = placement.zoneId || null;
    bin.rackId = placement.rackId || null;
    bin.shelfId = placement.shelfId || null;
    if (placement.zoneCode) bin.zoneCode = placement.zoneCode;
  }

  const allowed = ['zoneCode', 'capacity', 'status'];
  for (const key of allowed) {
    if (data[key] !== undefined) bin[key] = data[key];
  }
  bin.updatedBy = userId;
  await bin.save();
  return bin;
}

export async function getBinContents(factoryId, binId) {
  const bin = await StorageBin.findOne(applySoftDeleteFilter({ _id: binId, factoryId }))
    .populate('zoneId', 'zoneCode name')
    .populate('rackId', 'rackCode name')
    .populate('shelfId', 'shelfCode name');
  if (!bin) throw new NotFoundError('Storage bin not found');

  const [rmBalances, fgBalances] = await Promise.all([
    InventoryBalance.find({
      factoryId,
      inventoryType: 'RAW_MATERIAL',
      storageBinId: binId,
      isDeleted: false,
    }).populate('materialId', 'materialCode name unit'),
    InventoryBalance.find({
      factoryId,
      inventoryType: 'FINISHED_GOODS',
      storageBinId: binId,
      isDeleted: false,
    }).populate('skuId', 'skuCode name'),
  ]);

  return {
    bin,
    rawMaterials: rmBalances.map((b) => ({
      materialId: b.materialId,
      onHand: b.onHand,
      reserved: b.reserved,
      available: b.available,
      unit: b.unit,
    })),
    finishedGoods: fgBalances.map((b) => ({
      skuId: b.skuId,
      onHand: b.onHand,
      dispatchStatus: b.dispatchStatus,
      unit: b.unit,
    })),
  };
}

async function getBin(binId, factoryId) {
  const bin = await StorageBin.findOne(applySoftDeleteFilter({ _id: binId, factoryId }));
  if (!bin) throw new NotFoundError('Storage bin not found');
  if (bin.status !== 'ACTIVE') throw new ConflictError('Bin is not active');
  return bin;
}

export async function putAway({ factoryId, organizationId, materialId, binId, quantity, userId }) {
  const bin = await getBin(binId, factoryId);
  await assertBinWarehouseType(bin, 'RAW_MATERIAL');

  const unalloc = await InventoryBalance.findOne({
    factoryId,
    materialId,
    inventoryType: 'RAW_MATERIAL',
    storageBinId: null,
    isDeleted: false,
  });
  if (!unalloc || unalloc.onHand <= 0) throw new ConflictError('No unallocated on-hand stock to put away');

  const maxTransfer = unalloc.onHand - (unalloc.reserved || 0);
  const transferQty = quantity ?? maxTransfer;
  if (transferQty <= 0 || maxTransfer < transferQty) {
    throw new ConflictError('Cannot put away reserved stock or zero quantity');
  }

  unalloc.onHand -= transferQty;
  unalloc.available = unalloc.onHand - unalloc.reserved;
  unalloc.updatedBy = userId;
  await unalloc.save();

  const binBalance = await getOrCreateRmBalance(
    factoryId,
    organizationId,
    materialId,
    unalloc.unit,
    bin._id,
  );
  binBalance.onHand += transferQty;
  binBalance.locationId = bin._id;
  binBalance.available = binBalance.onHand - binBalance.reserved;
  binBalance.updatedBy = userId;
  await binBalance.save();

  await InventoryTransaction.create({
    organizationId,
    factoryId,
    type: 'TRANSFER',
    materialId,
    quantity: transferQty,
    unit: unalloc.unit,
    referenceType: 'PUT_AWAY',
    referenceId: bin._id,
    performedBy: userId,
    createdBy: userId,
    updatedBy: userId,
  });

  return { fromBalance: unalloc, toBalance: binBalance, bin, quantity: transferQty };
}

async function transferFgStock({
  factoryId, organizationId, skuId, fromBinId, toBinId, quantity, userId,
}) {
  const resolvedTo = toBinId;
  if (!resolvedTo) throw new ConflictError('Destination bin (toBinId) required');
  if (!skuId) throw new ConflictError('skuId required for finished-goods transfer');

  const toBin = await getBin(resolvedTo, factoryId);
  await assertBinWarehouseType(toBin, 'FINISHED_GOODS');

  if (fromBinId && String(fromBinId) === String(toBin._id)) throw new ConflictError('Source and destination bins must differ');
  const fromBalance = await fgSourceRow({
    factoryId, skuId, binId: fromBinId, extra: fromBinId ? {} : { storageBinId: { $ne: toBin._id } },
  });
  if (!fromBalance || fromBalance.onHand <= 0) throw new ConflictError('No finished-goods stock to transfer');
  if (fromBalance.storageBinId && String(fromBalance.storageBinId) === String(toBin._id)) {
    throw new ConflictError('Source and destination bins must differ');
  }

  const maxTransfer = fromBalance.onHand - (fromBalance.reserved || 0);
  const transferQty = quantity ?? maxTransfer;
  if (transferQty <= 0 || maxTransfer < transferQty) {
    throw new ConflictError('Cannot transfer reserved stock or zero quantity');
  }

  // Partial moves are fine: the destination bin gets its own row (merged if the SKU is already there).
  const toBalance = await fgRowAt({ factoryId, organizationId, skuId, binId: toBin._id, locationId: toBin.warehouseId, unit: fromBalance.unit });
  const toWasEmpty = (toBalance.onHand || 0) <= 0;
  fromBalance.onHand -= transferQty;
  fromBalance.available = fromBalance.onHand - (fromBalance.reserved || 0);
  fromBalance.updatedBy = userId;
  await fromBalance.save();
  toBalance.onHand += transferQty;
  toBalance.available = toBalance.onHand - (toBalance.reserved || 0);
  toBalance.locationId = toBin.warehouseId;
  // Moved stock keeps its dispatch status; mixing with different stock already in the bin restarts staging.
  if (toWasEmpty) toBalance.dispatchStatus = fromBalance.dispatchStatus || 'STAGED';
  else if (toBalance.dispatchStatus !== fromBalance.dispatchStatus) toBalance.dispatchStatus = 'STAGED';
  toBalance.updatedBy = userId;
  await toBalance.save();

  await InventoryTransaction.create({
    organizationId,
    factoryId,
    type: 'TRANSFER',
    skuId,
    quantity: transferQty,
    unit: toBalance.unit,
    referenceType: 'BIN_TRANSFER',
    referenceId: toBin._id,
    storageBinId: toBin._id,
    performedBy: userId,
    createdBy: userId,
    updatedBy: userId,
  });

  return { fromBalance, toBalance, bin: toBin, quantity: transferQty };
}

export async function transferStock({
  factoryId, organizationId, materialId, skuId, fromBinId, toBinId, quantity, userId,
}) {
  if (skuId) {
    return transferFgStock({
      factoryId, organizationId, skuId, fromBinId, toBinId, quantity, userId,
    });
  }

  const resolvedTo = toBinId;
  if (!resolvedTo) throw new ConflictError('Destination bin (toBinId) required');
  if (!materialId) throw new ConflictError('materialId or skuId required');

  const toBin = await getBin(resolvedTo, factoryId);
  await assertBinWarehouseType(toBin, 'RAW_MATERIAL');

  const fromBinKey = fromBinId || null;
  if (fromBinKey && String(fromBinKey) === String(toBin._id)) {
    throw new ConflictError('Source and destination bins must differ');
  }
  const sourceFilter = {
    factoryId,
    materialId,
    inventoryType: 'RAW_MATERIAL',
    storageBinId: fromBinKey,
    isDeleted: false,
  };
  const sourceBalance = await InventoryBalance.findOne(sourceFilter);
  if (!sourceBalance || sourceBalance.onHand <= 0) throw new ConflictError('No stock to transfer');

  const maxTransfer = ROUND3(sourceBalance.onHand - (sourceBalance.reserved || 0));
  const transferQty = quantity ?? maxTransfer;
  if (transferQty <= 0 || maxTransfer <= 0) {
    throw new ConflictError('Nothing to transfer — all stock at the source is reserved');
  }
  if (transferQty > maxTransfer) {
    throw new ConflictError(
      `Only ${maxTransfer} ${sourceBalance.unit || ''} can be moved from the source (${sourceBalance.reserved || 0} reserved) — requested ${transferQty}`.replace(/\s+/g, ' '),
    );
  }

  // Atomic take: a concurrent transfer / issue between the read and the write cannot drive the source negative.
  const fromBalance = await InventoryBalance.findOneAndUpdate(
    { _id: sourceBalance._id, $expr: { $gte: [{ $subtract: ['$onHand', { $ifNull: ['$reserved', 0] }] }, transferQty] } },
    { $inc: { onHand: -transferQty }, $set: { updatedBy: userId, updatedAt: new Date() } },
    { new: true },
  );
  if (!fromBalance) throw new ConflictError('Source stock changed — refresh and retry');
  fromBalance.onHand = ROUND3(fromBalance.onHand);
  fromBalance.available = ROUND3(fromBalance.onHand - (fromBalance.reserved || 0));
  await fromBalance.save();

  const toBalance = await getOrCreateRmBalance(
    factoryId,
    organizationId,
    materialId,
    fromBalance.unit,
    toBin._id,
  );
  toBalance.onHand = ROUND3(toBalance.onHand + transferQty);
  toBalance.locationId = toBin._id;
  toBalance.available = ROUND3(toBalance.onHand - (toBalance.reserved || 0));
  toBalance.updatedBy = userId;
  await toBalance.save();

  const fromBin = fromBinKey ? await StorageBin.findById(fromBinKey).select('binCode').lean() : null;
  await InventoryTransaction.create({
    organizationId,
    factoryId,
    type: 'TRANSFER',
    materialId,
    quantity: transferQty,
    unit: fromBalance.unit,
    referenceType: 'BIN_TRANSFER',
    referenceId: toBin._id,
    storageBinId: toBin._id,
    note: `${fromBin?.binCode || 'Unallocated dock'} → ${toBin.binCode}`,
    performedBy: userId,
    createdBy: userId,
    updatedBy: userId,
  });

  return { fromBalance, toBalance, bin: toBin, quantity: transferQty };
}

export async function assignRmToBin({ factoryId, organizationId, materialId, binId, quantity, userId }) {
  return putAway({ factoryId, organizationId, materialId, binId, quantity, userId });
}

/** A SKU's FG row in one bin (or on the dock when binId is null), created empty if missing. */
async function fgRowAt({ factoryId, organizationId, skuId, binId = null, locationId = null, unit = 'PIECES' }) {
  const where = { factoryId, skuId, inventoryType: 'FINISHED_GOODS', storageBinId: binId || null, isDeleted: false };
  let row = await InventoryBalance.findOne(where);
  if (!row) {
    try {
      row = await InventoryBalance.create({
        organizationId, factoryId, inventoryType: 'FINISHED_GOODS', skuId, storageBinId: binId || null,
        locationId, unit, onHand: 0, reserved: 0, available: 0, dispatchStatus: 'STAGED',
      });
    } catch (err) {
      if (err?.code !== 11000) throw err; // concurrent create — re-read the winner's row
      row = await InventoryBalance.findOne(where);
      if (!row) throw err;
    }
  }
  return row;
}

/**
 * The FG row an operation draws from. With a bin: that bin's row. Without: the only row of this SKU
 * that has stock — when the SKU sits in several places the caller must say which bin.
 */
async function fgSourceRow({ factoryId, skuId, binId, extra = {}, what = 'Finished goods' }) {
  if (binId) {
    return InventoryBalance.findOne({ factoryId, skuId, inventoryType: 'FINISHED_GOODS', storageBinId: binId, isDeleted: false, ...extra });
  }
  const rows = await InventoryBalance.find({ factoryId, skuId, inventoryType: 'FINISHED_GOODS', isDeleted: false, onHand: { $gt: 0 }, ...extra });
  if (rows.length > 1) throw new ConflictError(`${what} for this SKU sit in ${rows.length} places — choose the bin`);
  return rows[0] || null;
}

/**
 * Move finished goods into a bin. Draws from the unallocated dock by default (or from fromBinId).
 * Partial quantities are fine — the rest stays where it was. A SKU can be put away into several bins.
 */
export async function putAwayFinishedGoods({ factoryId, organizationId, skuId, binId, storageBinId, fromBinId, quantity, userId }) {
  const resolvedBinId = binId || storageBinId;
  const bin = await getBin(resolvedBinId, factoryId);
  await assertBinWarehouseType(bin, 'FINISHED_GOODS');
  if (fromBinId && String(fromBinId) === String(bin._id)) throw new ConflictError('Source and destination bins must differ');

  let source = await InventoryBalance.findOne({
    factoryId, skuId, inventoryType: 'FINISHED_GOODS', storageBinId: fromBinId || null, isDeleted: false,
  });
  if (!fromBinId && (!source || source.onHand - (source.reserved || 0) <= 0)) {
    // Nothing on the dock: older stock may sit in exactly one other bin — move from there.
    const others = await InventoryBalance.find({
      factoryId, skuId, inventoryType: 'FINISHED_GOODS', isDeleted: false, onHand: { $gt: 0 }, storageBinId: { $ne: bin._id },
    });
    if (others.length === 1) source = others[0];
    else if (others.length > 1) throw new ConflictError('This SKU sits in several bins — use a bin transfer and choose the source bin');
  }
  const free = source ? source.onHand - (source.reserved || 0) : 0;
  const moveQty = quantity ?? free;
  if (!source || moveQty <= 0 || free < moveQty) throw new ConflictError('Insufficient finished goods to put away');

  const target = await fgRowAt({ factoryId, organizationId, skuId, binId: bin._id, locationId: bin.warehouseId, unit: source.unit });
  source.onHand -= moveQty;
  source.available = source.onHand - (source.reserved || 0);
  source.updatedBy = userId;
  await source.save();
  target.onHand += moveQty;
  target.available = target.onHand - (target.reserved || 0);
  target.locationId = bin.warehouseId;
  target.dispatchStatus = 'STAGED';
  target.updatedBy = userId;
  await target.save();

  await InventoryTransaction.create({
    organizationId,
    factoryId,
    type: 'TRANSFER',
    skuId,
    quantity: moveQty,
    unit: target.unit,
    referenceType: 'FG_PUT_AWAY',
    referenceId: bin._id,
    storageBinId: bin._id,
    performedBy: userId,
    createdBy: userId,
    updatedBy: userId,
  });

  return { balance: target, bin, quantity: moveQty };
}

export async function markReadyForDispatch({ factoryId, skuId, storageBinId, userId }) {
  const balance = await fgSourceRow({
    factoryId, skuId, binId: storageBinId, extra: storageBinId ? {} : { storageBinId: { $type: 'objectId' } },
  });
  if (!balance) throw new NotFoundError('Finished goods inventory not found');
  if (!balance.storageBinId) throw new ConflictError('FG must be put away to a bin before dispatch readiness');
  balance.dispatchStatus = 'READY_FOR_DISPATCH';
  balance.updatedBy = userId;
  await balance.save();
  return balance;
}

export async function listDispatchReady(factoryId) {
  return InventoryBalance.find({
    factoryId,
    inventoryType: 'FINISHED_GOODS',
    dispatchStatus: 'READY_FOR_DISPATCH',
    isDeleted: false,
  })
    .populate('skuId', 'skuCode name barcode')
    .populate('storageBinId', 'binCode zoneCode');
}

export async function markDispatched({ factoryId, skuId, storageBinId, quantity, userId }) {
  const balance = await fgSourceRow({
    factoryId, skuId, binId: storageBinId, extra: storageBinId ? {} : { dispatchStatus: 'READY_FOR_DISPATCH' }, what: 'Ready-to-ship units',
  });
  if (!balance) throw new NotFoundError('Finished goods inventory not found');
  if (balance.dispatchStatus !== 'READY_FOR_DISPATCH') {
    throw new ConflictError('Inventory must be READY_FOR_DISPATCH before dispatch');
  }
  const dispatchQty = quantity || balance.onHand;
  if (dispatchQty > balance.onHand) throw new ConflictError('Insufficient quantity to dispatch');

  balance.onHand -= dispatchQty;
  balance.available = balance.onHand - balance.reserved;
  if (balance.onHand <= 0) {
    balance.dispatchStatus = 'DISPATCHED';
  }
  balance.updatedBy = userId;
  await balance.save();

  await InventoryTransaction.create({
    organizationId: balance.organizationId,
    factoryId,
    type: 'ISSUE',
    skuId,
    quantity: dispatchQty,
    unit: balance.unit,
    referenceType: 'DISPATCH',
    performedBy: userId,
    createdBy: userId,
    updatedBy: userId,
  });

  return balance;
}
