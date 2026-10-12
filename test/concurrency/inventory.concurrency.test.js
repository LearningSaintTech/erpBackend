import {
  startDb, stopDb, seedBase, makeMaterial, makeWarehouse, rmTotals, assertStockInvariants, settle, isConflict,
  ITERATIONS, mongoose,
} from '../helpers/db.js';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import * as inventoryService from '../../src/modules/inventory/inventory.service.js';
import { StockReservation } from '../../src/modules/inventory/stockReservation.model.js';
import { InventoryTransaction } from '../../src/modules/inventory/inventoryTransaction.model.js';

let ctx;
let rm;
const oid = () => new mongoose.Types.ObjectId();

before(async () => {
  await startDb();
  ctx = await seedBase();
  rm = await makeWarehouse(ctx, { type: 'RAW_MATERIAL', bins: 1 });
});
after(stopDb);

const receipt = (m, quantity, storageBinId) => inventoryService.receiptMaterial({
  factoryId: ctx.factoryId, organizationId: ctx.orgId, materialId: m._id, quantity, userId: ctx.userId, storageBinId,
});
const reserve = (m, quantity, referenceId) => inventoryService.reserveMaterial({
  factoryId: ctx.factoryId, organizationId: ctx.orgId, materialId: m._id, quantity, unit: m.unit,
  referenceType: 'MANUAL', referenceId, userId: ctx.userId,
});
const issue = (m, quantity, referenceId) => inventoryService.issueMaterial({
  factoryId: ctx.factoryId, organizationId: ctx.orgId, materialId: m._id, quantity, unit: m.unit,
  referenceType: 'MANUAL', referenceId, userId: ctx.userId,
});

describe('reserve races', () => {
  it(`parallel reserves exceeding available → reserved never exceeds on hand (×${ITERATIONS})`, async () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const m = await makeMaterial(ctx);
      await receipt(m, 6);
      await receipt(m, 4, rm.bins[0]._id);
      const refs = Array.from({ length: 5 }, oid);
      const { ok, failed } = await settle(refs.map((r) => reserve(m, 4, r)));
      for (const err of failed) assert.ok(isConflict(err), `unexpected ${err?.name}: ${err?.message}`);
      assert.ok(ok.length <= 2, `at most 2 × 4 fit into 10 (got ${ok.length})`);
      const t = await assertStockInvariants(ctx, m._id);
      assert.equal(t.onHand, 10);
      assert.equal(t.reserved, ok.length * 4);
      assert.equal(await StockReservation.countDocuments({ materialId: m._id, status: 'ACTIVE' }), ok.length,
        'no orphan reservation documents');
    }
  });

  it(`parallel reserve + release of different references keep balances consistent (×${ITERATIONS})`, async () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const m = await makeMaterial(ctx);
      await receipt(m, 10);
      const held = oid();
      await reserve(m, 5, held);
      const { failed } = await settle([
        inventoryService.releaseReservations({
          factoryId: ctx.factoryId, organizationId: ctx.orgId, referenceType: 'MANUAL', referenceId: held, userId: ctx.userId,
        }),
        reserve(m, 5, oid()),
        reserve(m, 3, oid()),
      ]);
      for (const err of failed) assert.ok(isConflict(err), `unexpected ${err?.name}: ${err?.message}`);
      await assertStockInvariants(ctx, m._id);
    }
  });
});

describe('issue races', () => {
  it(`parallel issues draining one reservation → never negative, reservation stays in sync (×${ITERATIONS})`, async () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const m = await makeMaterial(ctx);
      await receipt(m, 10);
      const ref = oid();
      await reserve(m, 10, ref);
      const { ok, failed } = await settle([issue(m, 5, ref), issue(m, 5, ref), issue(m, 5, ref)]);
      for (const err of failed) assert.ok(isConflict(err), `unexpected ${err?.name}: ${err?.message}`);
      assert.ok(ok.length <= 2);
      const t = await assertStockInvariants(ctx, m._id);
      const issued = (await InventoryTransaction.find({ materialId: m._id, type: 'ISSUE' })).reduce((s, x) => s + x.quantity, 0);
      assert.equal(issued, ok.length * 5, 'ledger matches successful issues');
      assert.equal(t.onHand, 10 - issued, 'stock moved exactly by what was issued');
    }
  });

  it(`parallel issues with own hold + free stock never eat another document's hold (×${ITERATIONS})`, async () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const m = await makeMaterial(ctx);
      await receipt(m, 20);
      const mine = oid();
      const theirs = oid();
      await reserve(m, 6, mine);
      await reserve(m, 8, theirs);
      const { ok, failed } = await settle([issue(m, 6, mine), issue(m, 6, mine), issue(m, 6, oid())]);
      for (const err of failed) assert.ok(isConflict(err), `unexpected ${err?.name}: ${err?.message}`);
      const t = await assertStockInvariants(ctx, m._id);
      const theirsLeft = (await StockReservation.findOne({ referenceId: theirs })).quantity;
      assert.equal(theirsLeft, 8, 'the other document keeps its full hold');
      assert.ok(t.onHand >= 8, 'their 8 is still physically there');
      const issued = (await InventoryTransaction.find({ materialId: m._id, type: 'ISSUE' })).reduce((s, x) => s + x.quantity, 0);
      assert.equal(t.onHand, 20 - issued);
      assert.ok(ok.length >= 1);
    }
  });
});
