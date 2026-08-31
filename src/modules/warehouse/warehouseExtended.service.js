import { Zone } from './zone.model.js';
import { Rack } from './rack.model.js';
import { Shelf } from './shelf.model.js';
import { StorageBin } from './storageBin.model.js';
import { Warehouse } from './warehouse.model.js';
import { CycleCount } from './cycleCount.model.js';
import { InventoryBalance } from '../inventory/inventoryBalance.model.js';
import { InventoryTransaction } from '../inventory/inventoryTransaction.model.js';
import { Material } from '../inventory/material.model.js';
import { Sku } from '../sku/sku.model.js';
import { Factory } from '../organization/factory.model.js';
import { nextDocumentNumber } from '../../shared/utils/numbering.js';
import { NotFoundError, ConflictError } from '../../shared/errors/AppError.js';
import { applySoftDeleteFilter } from '../../shared/utils/schema.js';
import * as warehouseService from './warehouse.service.js';
import { aggregateRmTotals } from '../inventory/inventoryStock.service.js';

async function findBalancesForWarehouse(factoryId, warehouseId, warehouseDoc) {
  const wh = warehouseDoc || await warehouseService.getWarehouse(warehouseId, factoryId);
  const bins = await StorageBin.find(applySoftDeleteFilter({ factoryId, warehouseId })).select('_id');
  const binIds = bins.map((b) => b._id);
  const invType = wh.type === 'FINISHED_GOODS' ? 'FINISHED_GOODS' : 'RAW_MATERIAL';
  const orClause = [{ storageBinId: { $in: binIds } }];
  if (invType === 'RAW_MATERIAL') {
    orClause.push({ storageBinId: null });
  }
  return InventoryBalance.find({
    factoryId,
    inventoryType: invType,
    onHand: { $gt: 0 },
    isDeleted: false,
    $or: orClause,
  })
    .populate('materialId', 'materialCode name unit')
    .populate('skuId', 'skuCode name');
}

async function findRmBalancesForWarehouse(factoryId, warehouseId, warehouseDoc) {
  return findBalancesForWarehouse(factoryId, warehouseId, warehouseDoc);
}

export async function createZone(data, userId) {
  await warehouseService.getWarehouse(data.warehouseId, data.factoryId);
  const existing = await Zone.findOne(applySoftDeleteFilter({
    factoryId: data.factoryId,
    warehouseId: data.warehouseId,
    zoneCode: data.zoneCode,
  }));
  if (existing) throw new ConflictError('Zone code already exists');
  return Zone.create({ ...data, createdBy: userId, updatedBy: userId });
}

export async function listZones(factoryId, warehouseId) {
  return Zone.find(applySoftDeleteFilter({ factoryId, warehouseId })).sort({ zoneCode: 1 });
}

export async function createRack(data, userId) {
  const zone = await Zone.findOne(applySoftDeleteFilter({ _id: data.zoneId, factoryId: data.factoryId }));
  if (!zone) throw new NotFoundError('Zone not found');
  const existing = await Rack.findOne(applySoftDeleteFilter({
    factoryId: data.factoryId,
    zoneId: data.zoneId,
    rackCode: data.rackCode,
  }));
  if (existing) throw new ConflictError('Rack code already exists in this zone');
  return Rack.create({
    factoryId: data.factoryId,
    organizationId: data.organizationId,
    zoneId: data.zoneId,
    rackCode: data.rackCode,
    createdBy: userId,
    updatedBy: userId,
  });
}

export async function createShelf(data, userId) {
  const rack = await Rack.findOne(applySoftDeleteFilter({ _id: data.rackId, factoryId: data.factoryId }));
  if (!rack) throw new NotFoundError('Rack not found');
  const existing = await Shelf.findOne(applySoftDeleteFilter({
    factoryId: data.factoryId,
    rackId: data.rackId,
    shelfCode: data.shelfCode,
  }));
  if (existing) throw new ConflictError('Shelf code already exists on this rack');
  return Shelf.create({
    factoryId: data.factoryId,
    organizationId: data.organizationId,
    rackId: data.rackId,
    shelfCode: data.shelfCode,
    createdBy: userId,
    updatedBy: userId,
  });
}

export async function listRacks(factoryId, zoneId) {
  return Rack.find(applySoftDeleteFilter({ factoryId, zoneId })).sort({ rackCode: 1 });
}

export async function listShelves(factoryId, rackId) {
  return Shelf.find(applySoftDeleteFilter({ factoryId, rackId })).sort({ shelfCode: 1 });
}

export async function getWarehouseLayout(factoryId, warehouseId) {
  await warehouseService.getWarehouse(warehouseId, factoryId);
  const zones = await Zone.find(applySoftDeleteFilter({ factoryId, warehouseId })).sort({ zoneCode: 1 }).lean();
  const zoneIds = zones.map((z) => z._id);
  const racks = await Rack.find(applySoftDeleteFilter({ factoryId, zoneId: { $in: zoneIds } })).sort({ rackCode: 1 }).lean();
  const rackIds = racks.map((r) => r._id);
  const shelves = await Shelf.find(applySoftDeleteFilter({ factoryId, rackId: { $in: rackIds } })).sort({ shelfCode: 1 }).lean();
  const bins = await StorageBin.find(applySoftDeleteFilter({ factoryId, warehouseId }))
    .sort({ zoneCode: 1, binCode: 1 })
    .lean();

  const racksByZone = new Map();
  for (const rack of racks) {
    const key = rack.zoneId.toString();
    if (!racksByZone.has(key)) racksByZone.set(key, []);
    racksByZone.get(key).push({ ...rack, shelves: [] });
  }
  const shelvesByRack = new Map();
  for (const shelf of shelves) {
    const key = shelf.rackId.toString();
    if (!shelvesByRack.has(key)) shelvesByRack.set(key, []);
    shelvesByRack.get(key).push(shelf);
  }
  for (const rackList of racksByZone.values()) {
    for (const rack of rackList) {
      rack.shelves = shelvesByRack.get(rack._id.toString()) || [];
    }
  }

  const binsByZone = new Map();
  for (const bin of bins) {
    // Only attach bins with a real zoneId — zoneCode-only bins stay unassigned
    const key = bin.zoneId?.toString();
    if (!key) continue;
    if (!binsByZone.has(key)) binsByZone.set(key, []);
    binsByZone.get(key).push(bin);
  }

  return {
    warehouseId,
    zones: zones.map((zone) => ({
      ...zone,
      racks: racksByZone.get(zone._id.toString()) || [],
      bins: binsByZone.get(zone._id.toString()) || [],
    })),
    unassignedBins: bins.filter((b) => !b.zoneId),
  };
}

export async function lookupByBarcode(factoryId, barcode) {
  const bin = await StorageBin.findOne({ factoryId, barcode, isDeleted: false });
  if (!bin) throw new NotFoundError('Bin not found for barcode');
  const contents = await warehouseService.getBinContents(factoryId, bin._id);
  return contents;
}

export async function pickStock({ factoryId, organizationId, materialId, skuId, binId, quantity, userId }) {
  if (!quantity || quantity <= 0) throw new ConflictError('Pick quantity required');

  if (skuId) {
    const filter = {
      factoryId,
      skuId,
      inventoryType: 'FINISHED_GOODS',
      isDeleted: false,
      onHand: { $gt: 0 },
    };
    if (binId) filter.storageBinId = binId;
    const balance = await InventoryBalance.findOne(filter);
    if (!balance) throw new ConflictError('Finished goods not found in the selected location');
    const unreserved = balance.onHand - (balance.reserved || 0);
    if (unreserved < quantity) throw new ConflictError('Insufficient unreserved finished goods to pick');
    balance.onHand -= quantity;
    balance.available = balance.onHand - balance.reserved;
    balance.updatedBy = userId;
    await balance.save();
    await InventoryTransaction.create({
      organizationId,
      factoryId,
      type: 'ISSUE',
      skuId,
      quantity,
      unit: balance.unit,
      referenceType: 'PICK',
      referenceId: binId,
      performedBy: userId,
      createdBy: userId,
      updatedBy: userId,
    });
    return { skuId, quantity, binId };
  }

  if (!materialId) throw new ConflictError('materialId or skuId required');

  const totals = await aggregateRmTotals(factoryId, materialId);
  if (totals.available < quantity) throw new ConflictError('Insufficient unreserved stock to pick');

  let remaining = quantity;
  const filter = {
    factoryId,
    materialId,
    inventoryType: 'RAW_MATERIAL',
    isDeleted: false,
    onHand: { $gt: 0 },
  };
  if (binId) filter.storageBinId = binId;

  const balances = await InventoryBalance.find(filter).sort({ storageBinId: 1 });
  if (binId && balances.length === 0) {
    throw new ConflictError('Material is not located in the selected bin');
  }

  for (const balance of balances) {
    if (remaining <= 0) break;
    const unreserved = balance.onHand - (balance.reserved || 0);
    if (unreserved <= 0) continue;
    const take = Math.min(unreserved, remaining);
    balance.onHand -= take;
    balance.available = balance.onHand - balance.reserved;
    balance.updatedBy = userId;
    await balance.save();
    remaining -= take;
  }

  if (remaining > 0) {
    throw new ConflictError('Insufficient unreserved stock in selected location');
  }

  const sampleBalance = balances[0];
  await InventoryTransaction.create({
    organizationId,
    factoryId,
    type: 'ISSUE',
    materialId,
    quantity,
    unit: sampleBalance?.unit,
    referenceType: 'PICK',
    referenceId: binId,
    performedBy: userId,
    createdBy: userId,
    updatedBy: userId,
  });
  return { materialId, quantity, binId };
}

export async function createCycleCount({ factoryId, organizationId, warehouseId }, userId) {
  const wh = await warehouseService.getWarehouse(warehouseId, factoryId);
  const factory = await Factory.findById(factoryId);
  const countNumber = await nextDocumentNumber(factoryId, 'CC', `CC-${factory.code}-`);
  const balances = await findBalancesForWarehouse(factoryId, warehouseId, wh);
  const isFg = wh.type === 'FINISHED_GOODS';

  const byItem = new Map();
  for (const b of balances) {
    const itemId = isFg
      ? (b.skuId?._id || b.skuId)?.toString()
      : (b.materialId?._id || b.materialId)?.toString();
    if (!itemId) continue;
    const cur = byItem.get(itemId) || {
      materialId: isFg ? undefined : (b.materialId?._id || b.materialId),
      skuId: isFg ? (b.skuId?._id || b.skuId) : undefined,
      systemQty: 0,
    };
    cur.systemQty += b.onHand || 0;
    byItem.set(itemId, cur);
  }

  const lines = [...byItem.values()].map((row) => ({
    materialId: row.materialId,
    skuId: row.skuId,
    systemQty: row.systemQty,
    countedQty: row.systemQty,
    variance: 0,
  }));
  return CycleCount.create({
    organizationId,
    factoryId,
    warehouseId,
    countNumber,
    lines,
    status: 'DRAFT',
    createdBy: userId,
    updatedBy: userId,
  });
}

export async function getCycleCount(id, factoryId) {
  const filter = applySoftDeleteFilter({ _id: id });
  if (factoryId) filter.factoryId = factoryId;
  const cc = await CycleCount.findOne(filter)
    .populate('warehouseId', 'warehouseCode name type')
    .populate('lines.materialId', 'materialCode name unit')
    .populate('lines.skuId', 'skuCode name');
  if (!cc) throw new NotFoundError('Cycle count not found');
  return cc;
}

export async function startCycleCount(id, userId, factoryId) {
  const cc = await getCycleCount(id, factoryId);
  if (cc.status !== 'DRAFT') throw new ConflictError('Cycle count already started');
  cc.status = 'IN_PROGRESS';
  cc.updatedBy = userId;
  await cc.save();
  return cc;
}

export async function completeCycleCount(id, { lines, applyAdjustments = false }, userId, factoryId) {
  const cc = await getCycleCount(id, factoryId);
  if (cc.status === 'COMPLETED') throw new ConflictError('Cycle count already completed');

  const merged = (lines || cc.lines).map((l) => {
    const systemQty = l.systemQty ?? 0;
    const countedQty = l.countedQty ?? 0;
    return {
      materialId: l.materialId,
      skuId: l.skuId,
      systemQty,
      countedQty,
      variance: countedQty - systemQty,
    };
  });
  cc.lines = merged;
  cc.status = 'COMPLETED';
  cc.updatedBy = userId;
  await cc.save();

  if (applyAdjustments) {
    const wh = await warehouseService.getWarehouse(cc.warehouseId, cc.factoryId);
    const isFg = wh.type === 'FINISHED_GOODS';
    const invType = isFg ? 'FINISHED_GOODS' : 'RAW_MATERIAL';
    const bins = await StorageBin.find(applySoftDeleteFilter({ factoryId: cc.factoryId, warehouseId: cc.warehouseId })).select('_id');
    const binIdSet = new Set(bins.map((b) => b._id.toString()));
    const inScope = (balance) => {
      if (!balance.storageBinId) return !isFg;
      return binIdSet.has(balance.storageBinId.toString());
    };

    for (const line of merged) {
      if (!line.variance) continue;
      const itemFilter = {
        factoryId: cc.factoryId,
        inventoryType: invType,
        isDeleted: false,
      };
      if (isFg) itemFilter.skuId = line.skuId;
      else itemFilter.materialId = line.materialId;

      const balances = (await InventoryBalance.find(itemFilter).sort({ storageBinId: 1 })).filter(inScope);
      if (!balances.length) continue;

      const totalOnHand = balances.reduce((s, b) => s + (b.onHand || 0), 0);
      const target = Math.max(0, line.countedQty);
      let delta = target - totalOnHand;
      if (delta === 0) continue;

      if (delta > 0) {
        const pool = balances.find((b) => !b.storageBinId) || balances[0];
        pool.onHand += delta;
        pool.available = pool.onHand - pool.reserved;
        pool.updatedBy = userId;
        await pool.save();
      } else {
        let toRemove = Math.abs(delta);
        for (const balance of balances) {
          if (toRemove <= 0) break;
          const removable = Math.max(0, balance.onHand - balance.reserved);
          const take = Math.min(removable, toRemove);
          if (take <= 0) continue;
          balance.onHand -= take;
          balance.available = balance.onHand - balance.reserved;
          balance.updatedBy = userId;
          await balance.save();
          toRemove -= take;
        }
      }

      await InventoryTransaction.create({
        organizationId: cc.organizationId,
        factoryId: cc.factoryId,
        type: 'ADJUSTMENT',
        materialId: isFg ? undefined : line.materialId,
        skuId: isFg ? line.skuId : undefined,
        quantity: Math.abs(line.variance),
        unit: balances[0].unit,
        referenceType: 'CYCLE_COUNT',
        referenceId: cc._id,
        performedBy: userId,
        createdBy: userId,
        updatedBy: userId,
      });
    }
  }

  return cc;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function binLocationParts(bin) {
  if (!bin) return null;
  const zone = bin.zoneId?.zoneCode || bin.zoneCode || '—';
  const rack = bin.rackId?.rackCode || '—';
  const shelf = bin.shelfId?.shelfCode || '—';
  const wh = bin.warehouseId;
  return {
    binId: bin._id,
    binCode: bin.binCode,
    zoneCode: zone,
    rackCode: rack,
    shelfCode: shelf,
    barcode: bin.barcode,
    warehouseId: wh?._id || bin.warehouseId,
    warehouseCode: wh?.warehouseCode,
    warehouseName: wh?.name,
    warehouseType: wh?.type,
    label: `${zone}-${bin.binCode}`,
  };
}

/** Find all warehouse locations (dock + bins) for RM or FG stock. */
export async function stockLocator(factoryId, { materialId, skuId, search, inventoryType } = {}) {
  const invType = inventoryType === 'FINISHED_GOODS' ? 'FINISHED_GOODS' : 'RAW_MATERIAL';
  const filter = { factoryId, isDeleted: false, inventoryType: invType, onHand: { $gt: 0 } };

  if (materialId && invType === 'RAW_MATERIAL') filter.materialId = materialId;
  if (skuId && invType === 'FINISHED_GOODS') filter.skuId = skuId;

  if (search?.trim() && !materialId && !skuId) {
    const re = new RegExp(escapeRegex(search.trim()), 'i');
    if (invType === 'RAW_MATERIAL') {
      const materials = await Material.find(applySoftDeleteFilter({
        factoryId,
        $or: [{ materialCode: re }, { name: re }],
      })).select('_id');
      const ids = materials.map((m) => m._id);
      if (!ids.length) return { items: [], totals: { onHand: 0, reserved: 0, available: 0 } };
      filter.materialId = { $in: ids };
    } else {
      const skus = await Sku.find(applySoftDeleteFilter({
        factoryId,
        $or: [{ skuCode: re }, { name: re }],
      })).select('_id');
      const ids = skus.map((s) => s._id);
      if (!ids.length) return { items: [], totals: { onHand: 0, reserved: 0, available: 0 } };
      filter.skuId = { $in: ids };
    }
  }

  if (!materialId && !skuId && !search?.trim()) {
    return { items: [], totals: { onHand: 0, reserved: 0, available: 0 } };
  }

  let defaultRmWh = null;
  if (invType === 'RAW_MATERIAL') {
    defaultRmWh = await Warehouse.findOne(applySoftDeleteFilter({ factoryId, type: 'RAW_MATERIAL', isDefault: true }))
      || await Warehouse.findOne(applySoftDeleteFilter({ factoryId, type: 'RAW_MATERIAL' }));
  }

  const balances = await InventoryBalance.find(filter)
    .populate('materialId', 'materialCode name unit')
    .populate('skuId', 'skuCode name')
    .populate({
      path: 'storageBinId',
      populate: [
        { path: 'zoneId', select: 'zoneCode name' },
        { path: 'rackId', select: 'rackCode name' },
        { path: 'shelfId', select: 'shelfCode name' },
        { path: 'warehouseId', select: 'name warehouseCode type' },
      ],
    })
    .sort({ materialId: 1, skuId: 1, storageBinId: 1 });

  const items = balances.map((b) => {
    const bin = b.storageBinId;
    const isDock = !bin;
    const loc = isDock ? null : binLocationParts(bin);
    const wh = isDock && defaultRmWh
      ? {
        warehouseId: defaultRmWh._id,
        warehouseCode: defaultRmWh.warehouseCode,
        warehouseName: defaultRmWh.name,
        warehouseType: defaultRmWh.type,
      }
      : loc
        ? {
          warehouseId: loc.warehouseId,
          warehouseCode: loc.warehouseCode,
          warehouseName: loc.warehouseName,
          warehouseType: loc.warehouseType,
        }
        : null;

    return {
      balanceId: b._id,
      inventoryType: invType,
      materialId: b.materialId,
      skuId: b.skuId,
      onHand: b.onHand,
      reserved: b.reserved,
      available: b.available,
      unit: b.unit,
      dispatchStatus: b.dispatchStatus || null,
      location: {
        isDock,
        dockLabel: isDock ? 'Unallocated (dock)' : null,
        zoneCode: isDock ? '—' : (loc?.zoneCode || '—'),
        rackCode: isDock ? '—' : (loc?.rackCode || '—'),
        shelfCode: isDock ? '—' : (loc?.shelfCode || '—'),
        binCode: isDock ? '—' : (loc?.binCode || '—'),
        binLabel: isDock ? 'Unallocated (dock)' : (loc?.label || '—'),
        binId: isDock ? null : loc?.binId,
        barcode: isDock ? null : loc?.barcode,
        warehouse: wh,
      },
    };
  });

  const totals = items.reduce(
    (acc, r) => ({
      onHand: acc.onHand + (r.onHand || 0),
      reserved: acc.reserved + (r.reserved || 0),
      available: acc.available + (r.available || 0),
    }),
    { onHand: 0, reserved: 0, available: 0 },
  );

  return { items, totals };
}

export async function listCycleCounts(factoryId, { page, limit, skip, status } = {}) {
  const filter = applySoftDeleteFilter({ factoryId });
  if (status) filter.status = status;
  if (page && limit !== undefined && skip !== undefined) {
    const [items, total] = await Promise.all([
      CycleCount.find(filter)
        .populate('warehouseId', 'warehouseCode name')
        .skip(skip)
        .limit(limit)
        .sort({ createdAt: -1 }),
      CycleCount.countDocuments(filter),
    ]);
    return { items, total };
  }
  return { items: await CycleCount.find(filter).populate('warehouseId', 'warehouseCode name').sort({ createdAt: -1 }), total: 0 };
}
