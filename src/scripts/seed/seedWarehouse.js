import { Warehouse } from '../../modules/warehouse/warehouse.model.js';
import { StorageBin } from '../../modules/warehouse/storageBin.model.js';
import { Zone } from '../../modules/warehouse/zone.model.js';
import { isHeavy, isConditionsSeed, isFixtureSeed, seedLimit, logAudit, safeSeed } from './seedHelpers.js';

const WAREHOUSE_SPECS = [
  { code: 'WH-RM-01', name: 'Raw Material Store', type: 'RAW_MATERIAL', isDefault: true },
  { code: 'WH-WIP-01', name: 'Work In Progress Store', type: 'WIP', isDefault: false },
  { code: 'WH-FG-01', name: 'Finished Goods Store', type: 'FINISHED_GOODS', isDefault: true },
];

function warehousesToSeed() {
  if (isHeavy()) return WAREHOUSE_SPECS;
  if (isConditionsSeed()) return WAREHOUSE_SPECS.filter((s) => s.type !== 'WIP');
  return WAREHOUSE_SPECS.filter((s) => s.type === 'RAW_MATERIAL' || s.type === 'FINISHED_GOODS');
}

async function seedWarehousesAndBins(ctx) {
  const { org, factory, admin } = ctx;
  const warehouseService = await import('../../modules/warehouse/warehouse.service.js');
  ctx.warehouses = [];

  for (const spec of warehousesToSeed()) {
    let wh = await Warehouse.findOne({ factoryId: factory._id, warehouseCode: spec.code });
    if (!wh) {
      wh = await warehouseService.createWarehouse({
        organizationId: org._id,
        factoryId: factory._id,
        warehouseCode: spec.code,
        name: spec.name,
        type: spec.type,
        isDefault: spec.isDefault,
      }, admin._id);
      console.log(`Seeded warehouse: ${spec.code}`);
    }
    ctx.warehouses.push(wh);

    const zoneCodes = seedLimit({ heavy: ['A', 'B', 'C'], conditions: ['A', 'B'], light: ['A'] });
    const zonesByCode = new Map();
    for (const zoneCode of zoneCodes) {
      let zone = await Zone.findOne({ factoryId: factory._id, warehouseId: wh._id, zoneCode });
      if (!zone) {
        zone = await Zone.create({
          organizationId: org._id,
          factoryId: factory._id,
          warehouseId: wh._id,
          zoneCode,
          name: `Zone ${zoneCode}`,
          createdBy: admin._id,
          updatedBy: admin._id,
        });
      }
      zonesByCode.set(zoneCode, zone);
    }

    const binCount = seedLimit({ heavy: 8, conditions: 5, light: 3 });
    // WH-RM-01 → RM, WH-FG-01 → FG (must be unique across warehouses; barcode index is factory-wide)
    const whToken = spec.code.replace(/^WH-/, '').replace(/-\d+$/, '');
    for (let i = 1; i <= binCount; i += 1) {
      const zoneCode = String.fromCharCode(65 + (i % zoneCodes.length));
      const zone = zonesByCode.get(zoneCode) || zonesByCode.get('A');
      const binCode = `BIN-${whToken}-${String(i).padStart(2, '0')}`;
      const existingBin = await StorageBin.findOne({ factoryId: factory._id, warehouseId: wh._id, binCode });
      if (!existingBin) {
        await warehouseService.createStorageBin({
          organizationId: org._id,
          factoryId: factory._id,
          warehouseId: wh._id,
          zoneId: zone?._id,
          zoneCode,
          binCode,
          barcode: binCode,
        }, admin._id);
      } else if (zone && !existingBin.zoneId) {
        existingBin.zoneId = zone._id;
        existingBin.zoneCode = zone.zoneCode;
        await existingBin.save();
      }
    }
  }
  console.log(`Seeded ${ctx.warehouses.length} warehouses with bins`);
}

async function seedZoneHierarchy(ctx) {
  if (!isFixtureSeed()) return;
  const warehouseExt = await import('../../modules/warehouse/warehouseExtended.service.js');
  const { factory, admin } = ctx;

  for (const wh of ctx.warehouses) {
    const zoneCount = await Zone.countDocuments({ factoryId: factory._id, warehouseId: wh._id });
    if (zoneCount >= 3) continue;

    for (const zoneCode of ['A', 'B', 'C']) {
      let zone = await Zone.findOne({ factoryId: factory._id, warehouseId: wh._id, zoneCode });
      if (!zone) {
        zone = await safeSeed(`zone-${wh.warehouseCode}-${zoneCode}`, () => warehouseExt.createZone({
          organizationId: ctx.org._id,
          factoryId: factory._id,
          warehouseId: wh._id,
          zoneCode,
          name: `Zone ${zoneCode}`,
        }, admin._id));
      }
      if (!zone) continue;

      for (let r = 1; r <= 2; r += 1) {
        const rackCode = `${zoneCode}-R${String(r).padStart(2, '0')}`;
        const rack = await safeSeed(`rack-${rackCode}`, () => warehouseExt.createRack({
          organizationId: ctx.org._id,
          factoryId: factory._id,
          zoneId: zone._id,
          rackCode,
          name: `Rack ${rackCode}`,
        }, admin._id));

        if (!rack) continue;
        for (let s = 1; s <= 4; s += 1) {
          const shelfCode = `${rackCode}-S${s}`;
          await safeSeed(`shelf-${shelfCode}`, () => warehouseExt.createShelf({
            organizationId: ctx.org._id,
            factoryId: factory._id,
            rackId: rack._id,
            shelfCode,
            name: `Shelf ${shelfCode}`,
          }, admin._id));
        }
      }
    }
  }
  console.log('Seeded warehouse zone/rack/shelf hierarchy');
}

async function seedPutAway(ctx) {
  if (!ctx.fabric || !ctx.warehouses.length) return;
  const warehouseService = await import('../../modules/warehouse/warehouse.service.js');
  const { InventoryBalance } = await import('../../modules/inventory/inventoryBalance.model.js');
  const rmWh = ctx.warehouses.find((w) => w.type === 'RAW_MATERIAL');
  if (!rmWh) return;

  const bin = await StorageBin.findOne({ factoryId: ctx.factory._id, warehouseId: rmWh._id });
  if (!bin) return;

  const alreadyInBin = await InventoryBalance.findOne({
    factoryId: ctx.factory._id,
    materialId: ctx.fabric._id,
    inventoryType: 'RAW_MATERIAL',
    storageBinId: bin._id,
    onHand: { $gt: 0 },
    isDeleted: false,
  });
  if (alreadyInBin) {
    console.log('Fabric already in bin — skipping put-away');
    return;
  }

  await safeSeed('put-away-fabric', () => warehouseService.putAway({
    factoryId: ctx.factory._id,
    organizationId: ctx.org._id,
    materialId: ctx.fabric._id,
    binId: bin._id,
    userId: ctx.admin._id,
  }));
  console.log('Seeded put-away for fabric');
  await logAudit(ctx, {
    module: 'warehouse',
    action: 'putaway.complete',
    documentType: 'Material',
    documentId: ctx.fabric._id,
    metadata: { binCode: bin.binCode },
  });
}

async function seedCycleCounts(ctx) {
  if (!isFixtureSeed() || !ctx.warehouses.length) return;
  const warehouseExt = await import('../../modules/warehouse/warehouseExtended.service.js');
  const { factory, admin, org } = ctx;
  const { CycleCount } = await import('../../modules/warehouse/cycleCount.model.js');

  const existing = await CycleCount.countDocuments({ factoryId: factory._id });
  if (existing >= 2) return;

  for (const wh of ctx.warehouses.slice(0, 2)) {
    const cc = await safeSeed(`cycle-${wh.warehouseCode}`, () => warehouseExt.createCycleCount({
      factoryId: factory._id,
      organizationId: org._id,
      warehouseId: wh._id,
    }, admin._id));
    if (cc) {
      await warehouseExt.startCycleCount(cc._id, admin._id, factory._id);
    }
  }
  console.log('Seeded cycle counts');
}

export async function seedWarehouse(ctx) {
  await seedWarehousesAndBins(ctx);
  await seedZoneHierarchy(ctx);
  await seedPutAway(ctx);
  await seedCycleCounts(ctx);
  return ctx;
}
