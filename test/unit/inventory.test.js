import {
  startDb, stopDb, seedBase, makeMaterial, makeWarehouse, rmRows, rmTotals, activeReservedQty,
  assertStockInvariants, rejectsConflict, rejectsWith, mongoose,
} from '../helpers/db.js';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import * as inventoryService from '../../src/modules/inventory/inventory.service.js';
import * as warehouseService from '../../src/modules/warehouse/warehouse.service.js';
import * as warehouseExt from '../../src/modules/warehouse/warehouseExtended.service.js';
import { Material } from '../../src/modules/inventory/material.model.js';
import { StockReservation } from '../../src/modules/inventory/stockReservation.model.js';
import { InventoryBalance } from '../../src/modules/inventory/inventoryBalance.model.js';
import { InventoryTransaction } from '../../src/modules/inventory/inventoryTransaction.model.js';
import { ValidationError } from '../../src/shared/errors/AppError.js';

let ctx;
let rm; // RAW_MATERIAL warehouse with 2 bins

const oid = () => new mongoose.Types.ObjectId();

function receipt(material, quantity, extra = {}) {
  return inventoryService.receiptMaterial({
    factoryId: ctx.factoryId, organizationId: ctx.orgId, materialId: material._id, quantity, userId: ctx.userId, ...extra,
  });
}
function reserve(material, quantity, referenceId, referenceType = 'MANUAL') {
  return inventoryService.reserveMaterial({
    factoryId: ctx.factoryId, organizationId: ctx.orgId, materialId: material._id, quantity,
    unit: material.unit, referenceType, referenceId, userId: ctx.userId,
  });
}
function release(referenceId, referenceType = 'MANUAL') {
  return inventoryService.releaseReservations({
    factoryId: ctx.factoryId, organizationId: ctx.orgId, referenceType, referenceId, userId: ctx.userId,
  });
}
function issue(material, quantity, referenceId, referenceType = 'MANUAL') {
  return inventoryService.issueMaterial({
    factoryId: ctx.factoryId, organizationId: ctx.orgId, materialId: material._id, quantity,
    unit: material.unit, referenceType, referenceId, userId: ctx.userId,
  });
}

before(async () => {
  await startDb();
  ctx = await seedBase();
  rm = await makeWarehouse(ctx, { type: 'RAW_MATERIAL', bins: 2 });
});
after(stopDb);

describe('receiptMaterial', () => {
  it('first costed receipt sets unitCost; later receipts use the on-hand moving average', async () => {
    const mat = await makeMaterial(ctx, { unitCost: 999 });
    await receipt(mat, 10, { unitCost: 100 });
    assert.equal((await Material.findById(mat._id)).unitCost, 100, 'no prior stock → cost = receipt cost');
    await receipt(mat, 30, { unitCost: 120 });
    // (10·100 + 30·120) / 40 = 115
    assert.equal((await Material.findById(mat._id)).unitCost, 115);
    await receipt(mat, 5); // uncosted receipt leaves the rate alone
    assert.equal((await Material.findById(mat._id)).unitCost, 115);
    await receipt(mat, 15, { unitCost: 100 });
    // (45·115 + 15·100) / 60 = 111.25
    assert.equal((await Material.findById(mat._id)).unitCost, 111.25);
    const t = await rmTotals(ctx, mat._id);
    assert.deepEqual(t, { onHand: 60, reserved: 0, available: 60 });
  });

  it('rounds the moving average to 4 decimals', async () => {
    const mat = await makeMaterial(ctx);
    await receipt(mat, 3, { unitCost: 10 });
    await receipt(mat, 3, { unitCost: 10.00001 });
    await receipt(mat, 1, { unitCost: 11 });
    const cost = (await Material.findById(mat._id)).unitCost;
    assert.equal(cost, Math.round(cost * 10000) / 10000);
  });

  it('strictUnit rejects a unit other than the material unit; zero / negative qty rejected', async () => {
    const mat = await makeMaterial(ctx, { unit: 'METERS' });
    await rejectsWith(receipt(mat, 5, { unit: 'PIECES', strictUnit: true }), ValidationError, /does not match/);
    await rejectsWith(receipt(mat, 0), ValidationError);
    await rejectsWith(receipt(mat, -2), ValidationError);
    assert.equal((await rmRows(ctx, mat._id)).length, 0, 'rejected receipts create no balance rows');
    // non-strict tolerates it (legacy callers)
    await receipt(mat, 5, { unit: 'METERS', strictUnit: true });
    assert.equal((await rmTotals(ctx, mat._id)).onHand, 5);
  });

  it('bin receipts land on the bin row and write a RECEIPT ledger row with the bin', async () => {
    const mat = await makeMaterial(ctx);
    await receipt(mat, 7, { storageBinId: rm.bins[0]._id });
    const rows = await rmRows(ctx, mat._id);
    assert.equal(rows.length, 1);
    assert.equal(String(rows[0].storageBinId), String(rm.bins[0]._id));
    assert.equal(rows[0].onHand, 7);
    const tx = await InventoryTransaction.findOne({ materialId: mat._id, type: 'RECEIPT' });
    assert.equal(tx.quantity, 7);
    assert.equal(String(tx.storageBinId), String(rm.bins[0]._id));
  });
});

describe('reserveMaterial / releaseReservations', () => {
  it('reserve moves qty from available to reserved; release restores exactly', async () => {
    const mat = await makeMaterial(ctx);
    await receipt(mat, 50);
    const ref = oid();
    const r = await reserve(mat, 20, ref);
    assert.equal(r.status, 'ACTIVE');
    assert.deepEqual(await rmTotals(ctx, mat._id), { onHand: 50, reserved: 20, available: 30 });

    // same reference + same qty is idempotent, a different qty conflicts
    const again = await reserve(mat, 20, ref);
    assert.equal(String(again._id), String(r._id));
    await rejectsConflict(reserve(mat, 25, ref), /already exists/);
    assert.deepEqual(await rmTotals(ctx, mat._id), { onHand: 50, reserved: 20, available: 30 });

    assert.equal(await release(ref), 1);
    assert.deepEqual(await rmTotals(ctx, mat._id), { onHand: 50, reserved: 0, available: 50 });
    assert.equal((await StockReservation.findById(r._id)).status, 'RELEASED');
    assert.equal(await release(ref), 0, 'second release is a no-op');
    assert.deepEqual(await rmTotals(ctx, mat._id), { onHand: 50, reserved: 0, available: 50 });
    const relTx = await InventoryTransaction.findOne({ materialId: mat._id, type: 'RESERVATION_RELEASE' });
    assert.equal(relTx.quantity, 20);
  });

  it('cannot reserve more than available (other holds count)', async () => {
    const mat = await makeMaterial(ctx);
    await receipt(mat, 30);
    await reserve(mat, 25, oid());
    await rejectsConflict(reserve(mat, 6, oid()), /Insufficient stock/);
    await reserve(mat, 5, oid()); // exactly the remainder is fine
    assert.deepEqual(await rmTotals(ctx, mat._id), { onHand: 30, reserved: 30, available: 0 });
    await rejectsConflict(reserve(mat, 0.001, oid()));
    await assertStockInvariants(ctx, mat._id);
  });

  it('a reserve spread over dock + bin rows rolls back completely when a later row write fails', async (t) => {
    const mat = await makeMaterial(ctx);
    await receipt(mat, 10);
    await receipt(mat, 10, { storageBinId: rm.bins[0]._id });
    const original = InventoryBalance.prototype.save;
    let calls = 0;
    t.mock.method(InventoryBalance.prototype, 'save', function patched(...args) {
      calls += 1;
      if (calls === 2) return Promise.reject(new Error('simulated write failure'));
      return original.apply(this, args);
    });
    const ref = oid();
    await assert.rejects(reserve(mat, 15, ref), /simulated write failure/);
    t.mock.restoreAll();
    assert.deepEqual(await rmTotals(ctx, mat._id), { onHand: 20, reserved: 0, available: 20 });
    assert.equal(await StockReservation.countDocuments({ referenceId: ref }), 0, 'reservation doc removed');
    await assertStockInvariants(ctx, mat._id);
  });

  it('release spread over several rows releases the full quantity', async () => {
    const mat = await makeMaterial(ctx);
    await receipt(mat, 4);
    await receipt(mat, 6, { storageBinId: rm.bins[0]._id });
    await receipt(mat, 5, { storageBinId: rm.bins[1]._id });
    const ref = oid();
    await reserve(mat, 14, ref);
    assert.equal((await rmTotals(ctx, mat._id)).reserved, 14);
    await release(ref);
    assert.deepEqual(await rmTotals(ctx, mat._id), { onHand: 15, reserved: 0, available: 15 });
    for (const row of await rmRows(ctx, mat._id)) assert.equal(row.reserved, 0);
  });
});

describe('issueMaterial', () => {
  it('consumes only the caller\'s own reservation plus free stock — never another document\'s hold', async () => {
    const mat = await makeMaterial(ctx);
    await receipt(mat, 50);
    const refA = oid();
    const refB = oid();
    await reserve(mat, 20, refA);
    await reserve(mat, 20, refB);
    // free = 10; A may draw 20 own + 10 free
    await issue(mat, 25, refA);
    assert.deepEqual(await rmTotals(ctx, mat._id), { onHand: 25, reserved: 20, available: 5 });
    assert.equal(await activeReservedQty(ctx, mat._id, { referenceId: refA }), 0);
    assert.equal(await activeReservedQty(ctx, mat._id, { referenceId: refB }), 20, 'B untouched');

    // a third document without a hold can only take free stock (5), not B's 20
    await rejectsConflict(issue(mat, 6, oid()), /Insufficient stock/);
    assert.deepEqual(await rmTotals(ctx, mat._id), { onHand: 25, reserved: 20, available: 5 });
    await issue(mat, 5, oid());
    assert.deepEqual(await rmTotals(ctx, mat._id), { onHand: 20, reserved: 20, available: 0 });
    await assertStockInvariants(ctx, mat._id);
  });

  it('a partial issue leaves the remainder of the reservation ACTIVE', async () => {
    const mat = await makeMaterial(ctx);
    await receipt(mat, 30);
    const ref = oid();
    const r = await reserve(mat, 20, ref);
    await issue(mat, 8, ref);
    const doc = await StockReservation.findById(r._id);
    assert.equal(doc.status, 'ACTIVE');
    assert.equal(doc.quantity, 12);
    assert.deepEqual(await rmTotals(ctx, mat._id), { onHand: 22, reserved: 12, available: 10 });
    await issue(mat, 12, ref);
    assert.equal((await StockReservation.findById(r._id)).status, 'CONSUMED');
    assert.deepEqual(await rmTotals(ctx, mat._id), { onHand: 10, reserved: 0, available: 10 });
    const issued = await InventoryTransaction.find({ materialId: mat._id, type: 'ISSUE' });
    assert.deepEqual(issued.map((x) => x.quantity).sort((a, b) => a - b), [8, 12]);
    await assertStockInvariants(ctx, mat._id);
  });
});

describe('computeMaterialStockAlerts', () => {
  it('totals per material across dock + bins; low vs out-of-stock; never-received materials included', async () => {
    const binned = await makeMaterial(ctx, { reorderLevel: 20, unitCost: 2 });
    await receipt(binned, 10);
    await receipt(binned, 15, { storageBinId: rm.bins[0]._id });
    const never = await makeMaterial(ctx, { reorderLevel: 5 });
    const noReorder = await makeMaterial(ctx, { reorderLevel: 0 });
    await receipt(noReorder, 1);
    const allHeld = await makeMaterial(ctx, { reorderLevel: 10 });
    await receipt(allHeld, 8);
    await reserve(allHeld, 8, oid());
    const exact = await makeMaterial(ctx, { reorderLevel: 7 });
    await receipt(exact, 7);

    const ids = [binned, never, noReorder, allHeld, exact].map((m) => m._id);
    const alerts = await inventoryService.computeMaterialStockAlerts(ctx.factoryId, { materialIds: ids });
    const by = new Map(alerts.map((a) => [String(a.materialId), a]));

    const a1 = by.get(String(binned._id));
    assert.equal(a1.onHand, 25);
    assert.equal(a1.available, 25);
    assert.equal(a1.stockValue, 50);
    assert.equal(a1.isLowStock, false, '25 > reorder 20 — per-row 10 and 15 must not trigger low');
    assert.equal(a1.isOutOfStock, false);

    const a2 = by.get(String(never._id));
    assert.equal(a2.hasBalance, false);
    assert.equal(a2.onHand, 0);
    assert.equal(a2.isOutOfStock, true);
    assert.equal(a2.isLowStock, false, 'out-of-stock is not also low-stock');

    const a3 = by.get(String(noReorder._id));
    assert.equal(a3.isLowStock, false, 'reorderLevel 0 never flags low');
    assert.equal(a3.isOutOfStock, false);

    const a4 = by.get(String(allHeld._id));
    assert.equal(a4.onHand, 8);
    assert.equal(a4.reserved, 8);
    assert.equal(a4.available, 0);
    assert.equal(a4.isOutOfStock, true, 'fully reserved stock is out of stock');

    const a5 = by.get(String(exact._id));
    assert.equal(a5.isLowStock, true, 'available == reorder level is low');

    // reserving part of `binned` drops available to 15 ≤ 20 → low
    await reserve(binned, 10, oid());
    const [after1] = await inventoryService.computeMaterialStockAlerts(ctx.factoryId, { materialIds: [binned._id] });
    assert.equal(after1.available, 15);
    assert.equal(after1.isLowStock, true);
  });
});

describe('pickStock / transferStock', () => {
  it('pick reduces only the chosen bin; over-pick is blocked with no partial change', async () => {
    const mat = await makeMaterial(ctx);
    await receipt(mat, 30, { storageBinId: rm.bins[0]._id });
    await receipt(mat, 20, { storageBinId: rm.bins[1]._id });
    const pick = (quantity, binId) => warehouseExt.pickStock({
      factoryId: ctx.factoryId, organizationId: ctx.orgId, materialId: mat._id, binId, quantity, userId: ctx.userId,
    });
    await pick(10, rm.bins[0]._id);
    let rows = await rmRows(ctx, mat._id);
    const onBin = (id) => rows.find((r) => String(r.storageBinId) === String(id)).onHand;
    assert.equal(onBin(rm.bins[0]._id), 20);
    assert.equal(onBin(rm.bins[1]._id), 20);

    await rejectsConflict(pick(21, rm.bins[0]._id), /pickable: 20/);
    rows = await rmRows(ctx, mat._id);
    assert.equal(onBin(rm.bins[0]._id), 20);

    // reserved stock is not pickable
    await reserve(mat, 15, oid());
    await rejectsConflict(pick(26, undefined), /Insufficient unreserved/);
    assert.equal((await rmTotals(ctx, mat._id)).onHand, 40);
    await pick(25);
    assert.deepEqual(await rmTotals(ctx, mat._id), { onHand: 15, reserved: 15, available: 0 });
    await assertStockInvariants(ctx, mat._id);
  });

  it('transfer moves qty between bins; totals unchanged; reserved stock cannot move', async () => {
    const mat = await makeMaterial(ctx);
    await receipt(mat, 12, { storageBinId: rm.bins[0]._id });
    const before = await rmTotals(ctx, mat._id);
    const move = (quantity) => warehouseService.transferStock({
      factoryId: ctx.factoryId, organizationId: ctx.orgId, materialId: mat._id,
      fromBinId: rm.bins[0]._id, toBinId: rm.bins[1]._id, quantity, userId: ctx.userId,
    });
    await move(5);
    const rows = await rmRows(ctx, mat._id);
    const onBin = (id) => rows.find((r) => String(r.storageBinId) === String(id))?.onHand;
    assert.equal(onBin(rm.bins[0]._id), 7);
    assert.equal(onBin(rm.bins[1]._id), 5);
    assert.deepEqual(await rmTotals(ctx, mat._id), before);

    await reserve(mat, 10, oid()); // holds bin0's 7 + 3 of bin1
    await rejectsConflict(move(1), /reserved/);
    assert.deepEqual((await rmTotals(ctx, mat._id)).onHand, 12);
    await assertStockInvariants(ctx, mat._id);
  });

  it('put-away moves free dock stock into a bin', async () => {
    const mat = await makeMaterial(ctx);
    await receipt(mat, 9);
    await reserve(mat, 4, oid());
    await rejectsConflict(warehouseService.putAway({
      factoryId: ctx.factoryId, organizationId: ctx.orgId, materialId: mat._id, binId: rm.bins[0]._id, quantity: 6, userId: ctx.userId,
    }));
    const res = await warehouseService.putAway({
      factoryId: ctx.factoryId, organizationId: ctx.orgId, materialId: mat._id, binId: rm.bins[0]._id, userId: ctx.userId,
    });
    assert.equal(res.quantity, 5);
    assert.equal((await rmTotals(ctx, mat._id)).onHand, 9);
    await assertStockInvariants(ctx, mat._id);
  });
});

describe('cycle count', () => {
  it('applies delta = counted − on hand with the right ledger direction', async () => {
    const own = await seedBase();
    const wh = await makeWarehouse(own, { type: 'RAW_MATERIAL', bins: 1 });
    const mk = (o) => makeMaterial(own, o);
    const shrink = await mk();
    const grow = await mk();
    const same = await mk();
    const rec = (m, q, bin) => inventoryService.receiptMaterial({
      factoryId: own.factoryId, organizationId: own.orgId, materialId: m._id, quantity: q, userId: own.userId, storageBinId: bin,
    });
    await rec(shrink, 10);
    await rec(shrink, 20, wh.bins[0]._id);
    await rec(grow, 5, wh.bins[0]._id);
    await rec(same, 3);

    const cc = await warehouseExt.createCycleCount({ factoryId: own.factoryId, organizationId: own.orgId, warehouseId: wh.warehouse._id }, own.userId);
    const sys = new Map(cc.lines.map((l) => [String(l.materialId), l.systemQty]));
    assert.equal(sys.get(String(shrink._id)), 30, 'dock + bin');
    assert.equal(sys.get(String(grow._id)), 5);

    await rejectsConflict(
      warehouseExt.completeCycleCount(cc._id, { lines: [] }, own.userId, own.factoryId),
      /IN_PROGRESS/,
    );
    await warehouseExt.startCycleCount(cc._id, own.userId, own.factoryId);
    const done = await warehouseExt.completeCycleCount(cc._id, {
      applyAdjustments: true,
      lines: [
        { materialId: shrink._id, countedQty: 24 },
        { materialId: grow._id, countedQty: 9 },
        { materialId: same._id, countedQty: 3 },
      ],
    }, own.userId, own.factoryId);
    assert.equal(done.status, 'COMPLETED');
    const line = (m) => done.lines.find((l) => String(l.materialId._id || l.materialId) === String(m._id));
    assert.equal(line(shrink).variance, -6);
    assert.equal(line(grow).variance, 4);
    assert.equal(line(same).variance, 0);

    const tot = async (m) => (await rmTotals(own, m._id)).onHand;
    assert.equal(await tot(shrink), 24);
    assert.equal(await tot(grow), 9);
    assert.equal(await tot(same), 3);

    const adj = await InventoryTransaction.find({ referenceId: cc._id, type: 'ADJUSTMENT' }).lean();
    const adjOf = (m) => adj.find((a) => String(a.materialId) === String(m._id));
    assert.equal(adjOf(shrink).direction, 'OUT');
    assert.equal(adjOf(shrink).quantity, 6);
    assert.equal(adjOf(grow).direction, 'IN');
    assert.equal(adjOf(grow).quantity, 4);
    assert.equal(adjOf(same), undefined, 'no ledger row for zero variance');

    await rejectsConflict(
      warehouseExt.completeCycleCount(cc._id, { lines: [], applyAdjustments: true }, own.userId, own.factoryId),
    );
    assert.equal(await tot(shrink), 24, 'a second complete applies nothing');
  });

  it('refuses to count reserved stock away', async () => {
    const own = await seedBase();
    const wh = await makeWarehouse(own, { type: 'RAW_MATERIAL', bins: 1 });
    const m = await makeMaterial(own);
    await inventoryService.receiptMaterial({
      factoryId: own.factoryId, organizationId: own.orgId, materialId: m._id, quantity: 10, userId: own.userId,
    });
    await inventoryService.reserveMaterial({
      factoryId: own.factoryId, organizationId: own.orgId, materialId: m._id, quantity: 8, unit: m.unit,
      referenceType: 'MANUAL', referenceId: oid(), userId: own.userId,
    });
    const cc = await warehouseExt.createCycleCount({ factoryId: own.factoryId, organizationId: own.orgId, warehouseId: wh.warehouse._id }, own.userId);
    await warehouseExt.startCycleCount(cc._id, own.userId, own.factoryId);
    await rejectsConflict(warehouseExt.completeCycleCount(cc._id, {
      applyAdjustments: true, lines: [{ materialId: m._id, countedQty: 5 }],
    }, own.userId, own.factoryId), /only 2 unreserved/);
    assert.equal((await rmTotals(own, m._id)).onHand, 10);
  });
});
