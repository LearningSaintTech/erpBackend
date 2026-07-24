import Joi from 'joi';
import * as warehouseService from './warehouse.service.js';
import * as warehouseExtended from './warehouseExtended.service.js';
import { success, paginate, buildMeta } from '../../shared/utils/response.js';
import {
  WAREHOUSE_TYPES, WAREHOUSE_STATUS_LIST, BIN_STATUS_LIST, CYCLE_COUNT_STATUS_LIST,
} from './warehouse.defaults.js';

export const createWarehouseSchema = Joi.object({
  body: Joi.object({
    warehouseCode: Joi.string().trim().min(2).required(),
    name: Joi.string().trim().min(2).required(),
    type: Joi.string().valid(...WAREHOUSE_TYPES).required(),
    address: Joi.string().allow(''),
    isDefault: Joi.boolean(),
  }),
});

export const updateWarehouseSchema = Joi.object({
  body: Joi.object({
    name: Joi.string().trim().min(2),
    address: Joi.string().allow(''),
    isDefault: Joi.boolean(),
    status: Joi.string().valid(...WAREHOUSE_STATUS_LIST),
  }).min(1),
});

export const createBinSchema = Joi.object({
  body: Joi.object({
    zoneCode: Joi.string().trim().default('A'),
    zoneId: Joi.string().hex().length(24).required(),
    rackId: Joi.string().hex().length(24).allow(null, ''),
    shelfId: Joi.string().hex().length(24).allow(null, ''),
    binCode: Joi.string().trim().min(1).required(),
    barcode: Joi.string().trim(),
    capacity: Joi.number().min(0),
    status: Joi.string().valid(...BIN_STATUS_LIST),
  }),
});

export const updateBinSchema = Joi.object({
  body: Joi.object({
    zoneCode: Joi.string().trim(),
    zoneId: Joi.string().allow(null, ''),
    rackId: Joi.string().allow(null, ''),
    shelfId: Joi.string().allow(null, ''),
    capacity: Joi.number().min(0),
    status: Joi.string().valid(...BIN_STATUS_LIST),
  }).min(1),
});

export const materialOpSchema = Joi.object({
  body: Joi.object({
    materialId: Joi.string().required(),
    binId: Joi.string(),
    fromBinId: Joi.string(),
    toBinId: Joi.string(),
    quantity: Joi.number().greater(0),
  }),
});

export const fgOpSchema = Joi.object({
  body: Joi.object({
    skuId: Joi.string().required(),
    binId: Joi.string(),
    storageBinId: Joi.string(),
    quantity: Joi.number().greater(0),
  }).or('binId', 'storageBinId'),
});

export const dispatchSchema = Joi.object({
  body: Joi.object({
    skuId: Joi.string().required(),
    storageBinId: Joi.string(),
    quantity: Joi.number().greater(0),
  }),
});

export const createZoneSchema = Joi.object({
  body: Joi.object({
    zoneCode: Joi.string().trim().min(1).required(),
    name: Joi.string().trim().min(1).required(),
  }),
});

export const createRackSchema = Joi.object({
  body: Joi.object({
    rackCode: Joi.string().trim().min(1).required(),
    name: Joi.string().trim().min(1),
  }),
});

export const createShelfSchema = Joi.object({
  body: Joi.object({
    shelfCode: Joi.string().trim().min(1).required(),
    name: Joi.string().trim().min(1),
  }),
});

export const createCycleCountSchema = Joi.object({
  body: Joi.object({
    warehouseId: Joi.string().required(),
  }),
});

export const completeCycleCountSchema = Joi.object({
  body: Joi.object({
    lines: Joi.array().items(Joi.object({
      materialId: Joi.string().required(),
      systemQty: Joi.number().min(0),
      countedQty: Joi.number().min(0),
    })).min(1),
    applyAdjustments: Joi.boolean(),
  }),
});

export async function catalog(req, res, next) {
  try {
    success(res, {
      warehouseTypes: WAREHOUSE_TYPES,
      warehouseStatuses: WAREHOUSE_STATUS_LIST,
      binStatuses: BIN_STATUS_LIST,
      cycleCountStatuses: CYCLE_COUNT_STATUS_LIST,
    });
  } catch (e) { next(e); }
}

export async function stats(req, res, next) {
  try {
    success(res, await warehouseService.getWarehouseStats(req.factoryId));
  } catch (e) { next(e); }
}

export async function stockLocator(req, res, next) {
  try {
    success(res, await warehouseExtended.stockLocator(req.factoryId, {
      materialId: req.query.materialId,
      skuId: req.query.skuId,
      search: req.query.search || req.query.q,
      inventoryType: req.query.inventoryType,
    }));
  } catch (e) { next(e); }
}

export async function createWarehouse(req, res, next) {
  try {
    const wh = await warehouseService.createWarehouse({
      ...req.body,
      factoryId: req.factoryId,
      organizationId: req.user.organizationId,
    }, req.user._id);
    success(res, wh, null, 201);
  } catch (e) { next(e); }
}

export async function listWarehouses(req, res, next) {
  try {
    const { page, limit, skip } = paginate(req.query);
    const { items, total } = await warehouseService.listWarehouses(req.factoryId, {
      page, limit, skip,
      search: req.query.search,
      type: req.query.type,
    });
    success(res, items, buildMeta(page, limit, total));
  } catch (e) { next(e); }
}

export async function getWarehouse(req, res, next) {
  try {
    success(res, await warehouseService.getWarehouse(req.params.id, req.factoryId));
  } catch (e) { next(e); }
}

export async function updateWarehouse(req, res, next) {
  try {
    success(res, await warehouseService.updateWarehouse(req.params.id, req.body, req.user._id, req.factoryId));
  } catch (e) { next(e); }
}

export async function createBin(req, res, next) {
  try {
    const bin = await warehouseService.createStorageBin({
      ...req.body,
      warehouseId: req.params.warehouseId,
      factoryId: req.factoryId,
      organizationId: req.user.organizationId,
    }, req.user._id);
    success(res, bin, null, 201);
  } catch (e) { next(e); }
}

export async function listBins(req, res, next) {
  try {
    const { page, limit, skip } = paginate(req.query);
    const { items, total } = await warehouseService.listStorageBins(req.factoryId, req.params.warehouseId, {
      page, limit, skip,
      search: req.query.search,
      status: req.query.status,
    });
    success(res, items, buildMeta(page, limit, total));
  } catch (e) { next(e); }
}

export async function updateBin(req, res, next) {
  try {
    success(res, await warehouseService.updateStorageBin(
      req.params.binId,
      req.params.warehouseId,
      req.body,
      req.user._id,
      req.factoryId,
    ));
  } catch (e) { next(e); }
}

export async function binContents(req, res, next) {
  try {
    success(res, await warehouseService.getBinContents(req.factoryId, req.params.binId));
  } catch (e) { next(e); }
}

export async function putAway(req, res, next) {
  try {
    success(res, await warehouseService.putAway({
      ...req.body,
      factoryId: req.factoryId,
      organizationId: req.user.organizationId,
      userId: req.user._id,
    }));
  } catch (e) { next(e); }
}

export async function fgPutAway(req, res, next) {
  try {
    success(res, await warehouseService.putAwayFinishedGoods({
      ...req.body,
      binId: req.body.binId || req.body.storageBinId,
      factoryId: req.factoryId,
      organizationId: req.user.organizationId,
      userId: req.user._id,
    }));
  } catch (e) { next(e); }
}

export async function markDispatchReady(req, res, next) {
  try {
    success(res, await warehouseService.markReadyForDispatch({
      factoryId: req.factoryId,
      skuId: req.body.skuId,
      storageBinId: req.body.storageBinId || req.body.binId,
      userId: req.user._id,
    }));
  } catch (e) { next(e); }
}

export async function listDispatchReady(req, res, next) {
  try {
    success(res, await warehouseService.listDispatchReady(req.factoryId));
  } catch (e) { next(e); }
}

export async function dispatch(req, res, next) {
  try {
    success(res, await warehouseService.markDispatched({
      factoryId: req.factoryId,
      skuId: req.body.skuId,
      storageBinId: req.body.storageBinId,
      quantity: req.body.quantity,
      userId: req.user._id,
    }));
  } catch (e) { next(e); }
}

export async function skuLookup(req, res, next) {
  try {
    const inv = await import('../inventory/inventory.service.js');
    success(res, await inv.lookupSkuByBarcode(req.factoryId, req.params.barcode));
  } catch (e) { next(e); }
}

export async function transfer(req, res, next) {
  try {
    success(res, await warehouseService.transferStock({
      ...req.body,
      toBinId: req.body.toBinId || req.body.binId,
      factoryId: req.factoryId,
      organizationId: req.user.organizationId,
      userId: req.user._id,
    }));
  } catch (e) { next(e); }
}

export async function createZone(req, res, next) {
  try {
    success(res, await warehouseExtended.createZone({
      ...req.body,
      warehouseId: req.params.warehouseId,
      factoryId: req.factoryId,
      organizationId: req.user.organizationId,
    }, req.user._id), null, 201);
  } catch (e) { next(e); }
}

export async function listZones(req, res, next) {
  try {
    success(res, await warehouseExtended.listZones(req.factoryId, req.params.warehouseId));
  } catch (e) { next(e); }
}

export async function listRacks(req, res, next) {
  try {
    success(res, await warehouseExtended.listRacks(req.factoryId, req.params.zoneId));
  } catch (e) { next(e); }
}

export async function listShelves(req, res, next) {
  try {
    success(res, await warehouseExtended.listShelves(req.factoryId, req.params.rackId));
  } catch (e) { next(e); }
}

export async function warehouseLayout(req, res, next) {
  try {
    success(res, await warehouseExtended.getWarehouseLayout(req.factoryId, req.params.warehouseId));
  } catch (e) { next(e); }
}

export async function createRack(req, res, next) {
  try {
    success(res, await warehouseExtended.createRack({
      ...req.body,
      zoneId: req.params.zoneId,
      factoryId: req.factoryId,
      organizationId: req.user.organizationId,
    }, req.user._id), null, 201);
  } catch (e) { next(e); }
}

export async function createShelf(req, res, next) {
  try {
    success(res, await warehouseExtended.createShelf({
      ...req.body,
      rackId: req.params.rackId,
      factoryId: req.factoryId,
      organizationId: req.user.organizationId,
    }, req.user._id), null, 201);
  } catch (e) { next(e); }
}

export async function binLookup(req, res, next) {
  try {
    success(res, await warehouseExtended.lookupByBarcode(req.factoryId, req.params.barcode));
  } catch (e) { next(e); }
}

export async function pick(req, res, next) {
  try {
    success(res, await warehouseExtended.pickStock({
      ...req.body,
      factoryId: req.factoryId,
      organizationId: req.user.organizationId,
      userId: req.user._id,
    }));
  } catch (e) { next(e); }
}

export async function createCycleCount(req, res, next) {
  try {
    success(res, await warehouseExtended.createCycleCount({
      factoryId: req.factoryId,
      organizationId: req.user.organizationId,
      warehouseId: req.body.warehouseId,
    }, req.user._id), null, 201);
  } catch (e) { next(e); }
}

export async function listCycleCounts(req, res, next) {
  try {
    const { page, limit, skip } = paginate(req.query);
    const { items, total } = await warehouseExtended.listCycleCounts(req.factoryId, { page, limit, skip, status: req.query.status });
    success(res, items, buildMeta(page, limit, total));
  } catch (e) { next(e); }
}

export async function getCycleCount(req, res, next) {
  try {
    success(res, await warehouseExtended.getCycleCount(req.params.id, req.factoryId));
  } catch (e) { next(e); }
}

export async function startCycleCount(req, res, next) {
  try {
    success(res, await warehouseExtended.startCycleCount(req.params.id, req.user._id, req.factoryId));
  } catch (e) { next(e); }
}

export async function completeCycleCount(req, res, next) {
  try {
    success(res, await warehouseExtended.completeCycleCount(req.params.id, req.body, req.user._id, req.factoryId));
  } catch (e) { next(e); }
}
