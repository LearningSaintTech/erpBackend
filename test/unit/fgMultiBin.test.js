import {
  startDb, stopDb, seedBase, makeWarehouse, rejectsConflict, uid,
} from '../helpers/db.js';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import * as inventoryService from '../../src/modules/inventory/inventory.service.js';
import * as warehouseService from '../../src/modules/warehouse/warehouse.service.js';
import * as warehouseExt from '../../src/modules/warehouse/warehouseExtended.service.js';
import { InventoryBalance } from '../../src/modules/inventory/inventoryBalance.model.js';
import { Sku } from '../../src/modules/sku/sku.model.js';

let ctx;
let fg; // FINISHED_GOODS warehouse with 3 bins

before(async () => {
  await startDb();
  ctx = await seedBase();
  fg = await makeWarehouse(ctx, { type: 'FINISHED_GOODS', bins: 3 });
});
after(stopDb);

const makeSku = () => Sku.create({
  organizationId: ctx.orgId, factoryId: ctx.factoryId, skuCode: uid('SKU'), name: 'Test dress', size: 'M', status: 'ACTIVE',
});
const rows = async (sku) => InventoryBalance.find({ factoryId: ctx.factoryId, skuId: sku._id, inventoryType: 'FINISHED_GOODS', isDeleted: false });
const at = (list, bin) => list.find((r) => String(r.storageBinId || '') === String(bin?._id || ''))?.onHand ?? 0;
const total = (list) => list.reduce((s, r) => s + r.onHand, 0);
const base = () => ({ factoryId: ctx.factoryId, organizationId: ctx.orgId, userId: ctx.userId });

describe('finished goods on several shelves', () => {
  it('receipt into two bins keeps one row per bin', async () => {
    const sku = await makeSku();
    const [b0, b1] = fg.bins;
    await inventoryService.receiptFinishedGoods({ ...base(), skuId: sku._id, quantity: 34, storageBinId: b0._id });
    await inventoryService.receiptFinishedGoods({ ...base(), skuId: sku._id, quantity: 32, storageBinId: b1._id });
    await inventoryService.receiptFinishedGoods({ ...base(), skuId: sku._id, quantity: 6, storageBinId: b0._id });
    const list = await rows(sku);
    assert.equal(list.length, 2);
    assert.equal(at(list, b0), 40);
    assert.equal(at(list, b1), 32);
  });

  it('put-away splits dock stock over bins; partial put-away leaves the rest on the dock', async () => {
    const sku = await makeSku();
    const [b0, b1] = fg.bins;
    await inventoryService.receiptFinishedGoods({ ...base(), skuId: sku._id, quantity: 10 });
    await warehouseService.putAwayFinishedGoods({ ...base(), skuId: sku._id, binId: b0._id, quantity: 6 });
    await warehouseService.putAwayFinishedGoods({ ...base(), skuId: sku._id, binId: b1._id, quantity: 3 });
    const list = await rows(sku);
    assert.equal(at(list, null), 1);
    assert.equal(at(list, b0), 6);
    assert.equal(at(list, b1), 3);
    assert.equal(total(list), 10);
    await rejectsConflict(warehouseService.putAwayFinishedGoods({ ...base(), skuId: sku._id, binId: b1._id, quantity: 2 }), /Insufficient/);
  });

  it('transfer moves part of a bin and merges into the destination', async () => {
    const sku = await makeSku();
    const [b0, b1, b2] = fg.bins;
    await inventoryService.receiptFinishedGoods({ ...base(), skuId: sku._id, quantity: 20, storageBinId: b0._id });
    await inventoryService.receiptFinishedGoods({ ...base(), skuId: sku._id, quantity: 5, storageBinId: b1._id });
    await warehouseService.transferStock({ ...base(), skuId: sku._id, fromBinId: b0._id, toBinId: b1._id, quantity: 8 });
    let list = await rows(sku);
    assert.equal(at(list, b0), 12);
    assert.equal(at(list, b1), 13);
    // no source bin given while the SKU is in two bins → must choose
    await rejectsConflict(warehouseService.transferStock({ ...base(), skuId: sku._id, toBinId: b2._id, quantity: 1 }), /choose the bin/);
    list = await rows(sku);
    assert.equal(total(list), 25);
  });

  it('ready / pick / dispatch work per bin and need a bin when ambiguous', async () => {
    const sku = await makeSku();
    const [b0, b1] = fg.bins;
    await inventoryService.receiptFinishedGoods({ ...base(), skuId: sku._id, quantity: 7, storageBinId: b0._id });
    await inventoryService.receiptFinishedGoods({ ...base(), skuId: sku._id, quantity: 4, storageBinId: b1._id });
    await rejectsConflict(warehouseService.markReadyForDispatch({ ...base(), skuId: sku._id }), /choose the bin/);
    await warehouseService.markReadyForDispatch({ ...base(), skuId: sku._id, storageBinId: b0._id });
    await warehouseService.markReadyForDispatch({ ...base(), skuId: sku._id, storageBinId: b1._id });
    await rejectsConflict(warehouseExt.pickStock({ ...base(), skuId: sku._id, quantity: 1 }), /choose the bin/);
    await warehouseExt.pickStock({ ...base(), skuId: sku._id, binId: b1._id, quantity: 4 });
    await warehouseService.markDispatched({ ...base(), skuId: sku._id, storageBinId: b0._id, quantity: 2 });
    const list = await rows(sku);
    assert.equal(at(list, b0), 5);
    assert.equal(at(list, b1), 0);
    // b1 is empty now, so a dispatch without a bin is unambiguous again
    await warehouseService.markDispatched({ ...base(), skuId: sku._id, quantity: 5 });
    assert.equal(total(await rows(sku)), 0);
  });

  it('the unique index allows one row per SKU per bin, and one dock row', async () => {
    const sku = await makeSku();
    const doc = { organizationId: ctx.orgId, factoryId: ctx.factoryId, inventoryType: 'FINISHED_GOODS', skuId: sku._id, unit: 'PIECES', onHand: 1 };
    await InventoryBalance.create({ ...doc, storageBinId: fg.bins[0]._id });
    await InventoryBalance.create({ ...doc, storageBinId: fg.bins[1]._id });
    await InventoryBalance.create({ ...doc, storageBinId: null });
    await assert.rejects(InventoryBalance.create({ ...doc, storageBinId: fg.bins[0]._id }), (e) => e.code === 11000);
    await assert.rejects(InventoryBalance.create({ ...doc, storageBinId: null }), (e) => e.code === 11000);
  });
});
