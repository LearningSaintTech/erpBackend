import {
  startDb, stopDb, seedBase, makeMaterial, makeSentPo, rmTotals, settle, isConflict, ITERATIONS,
} from '../helpers/db.js';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import * as purchaseService from '../../src/modules/purchase/purchase.service.js';
import * as qualityService from '../../src/modules/quality/quality.service.js';
import { PurchaseOrder } from '../../src/modules/purchase/purchaseOrder.model.js';
import { GoodsReceipt } from '../../src/modules/purchase/goodsReceipt.model.js';
import { InventoryTransaction } from '../../src/modules/inventory/inventoryTransaction.model.js';

let ctx;
before(async () => {
  await startDb();
  ctx = await seedBase();
});
after(stopDb);

function grn(po, material, qty) {
  return purchaseService.createGoodsReceipt({
    factoryId: ctx.factoryId, organizationId: ctx.orgId, poId: po._id, lines: [{ materialId: material._id, receivedQty: qty }],
  }, ctx.userId);
}

async function assertPoNotOverReceived(po, material) {
  const fresh = await PurchaseOrder.findById(po._id);
  const line = fresh.lines.find((l) => String(l.materialId) === String(material._id));
  const live = await GoodsReceipt.find({ poId: po._id, isDeleted: false, status: { $ne: 'CANCELLED' } });
  const grnQty = live.reduce((s, g) => s + g.lines.reduce((x, l) => x + l.receivedQty, 0), 0);
  assert.ok(line.receivedQty <= line.orderedQty, `PO over-received: ${line.receivedQty} > ${line.orderedQty}`);
  assert.equal(line.receivedQty, grnQty, 'PO receivedQty == Σ live GRN qty (no orphan GRN, no lost draw-down)');
  return { line, live };
}

describe('GRN races', () => {
  it(`double GRN submit for the full remaining qty → PO never over-received (×${ITERATIONS})`, async () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const m = await makeMaterial(ctx);
      const po = await makeSentPo(ctx, [{ material: m, qty: 100, unitPrice: 2 }]);
      const { ok, failed } = await settle([grn(po, m, 100), grn(po, m, 100)]);
      assert.equal(ok.length, 1, `iteration ${i}: one GRN wins`);
      assert.ok(isConflict(failed[0]), `loser should conflict, got ${failed[0]?.name}: ${failed[0]?.message}`);
      const { line, live } = await assertPoNotOverReceived(po, m);
      assert.equal(line.receivedQty, 100);
      assert.equal(live.length, 1);
    }
  });

  it(`three partial GRNs racing on one PO keep Σ received ≤ ordered (×${ITERATIONS})`, async () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const m = await makeMaterial(ctx);
      const po = await makeSentPo(ctx, [{ material: m, qty: 100, unitPrice: 2 }]);
      const { failed } = await settle([grn(po, m, 40), grn(po, m, 40), grn(po, m, 40)]);
      for (const err of failed) assert.ok(isConflict(err), err?.message);
      await assertPoNotOverReceived(po, m);
    }
  });

  it(`GRN vs PO cancel at once → never a cancelled PO with goods received (×${ITERATIONS})`, async () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const m = await makeMaterial(ctx);
      const po = await makeSentPo(ctx, [{ material: m, qty: 10, unitPrice: 2 }]);
      const { failed } = await settle([grn(po, m, 10), purchaseService.cancelPurchaseOrder(po._id, ctx.factoryId, ctx.userId)]);
      for (const err of failed) assert.ok(isConflict(err), err?.message);
      const fresh = await PurchaseOrder.findById(po._id);
      const liveGrn = await GoodsReceipt.countDocuments({ poId: po._id, isDeleted: false, status: { $ne: 'CANCELLED' } });
      if (fresh.status === 'CANCELLED') {
        assert.equal(liveGrn, 0, 'cancelled PO must not keep a GRN');
        assert.equal(fresh.lines[0].receivedQty, 0);
      } else {
        assert.equal(liveGrn, 1);
      }
    }
  });
});

describe('incoming QC races', () => {
  it(`two simultaneous QC completions of one inspection → stock receipted once (×${ITERATIONS})`, async () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const m = await makeMaterial(ctx);
      const po = await makeSentPo(ctx, [{ material: m, qty: 30, unitPrice: 4 }]);
      const g = await grn(po, m, 30);
      await purchaseService.submitGrnForQc(g._id, ctx.factoryId, ctx.userId);
      const { qcInspectionId } = await GoodsReceipt.findById(g._id);
      const body = { lines: [{ materialId: m._id, acceptedQty: 25, rejectedQty: 5 }] };
      const { ok, failed } = await settle([
        qualityService.completeInspection(qcInspectionId, body, ctx.userId, ctx.factoryId),
        qualityService.completeInspection(qcInspectionId, body, ctx.userId, ctx.factoryId),
      ]);
      assert.equal(ok.length, 1, `iteration ${i}`);
      assert.ok(isConflict(failed[0]), failed[0]?.message);
      assert.deepEqual(await rmTotals(ctx, m._id), { onHand: 25, reserved: 0, available: 25 });
      assert.equal(await InventoryTransaction.countDocuments({ materialId: m._id, type: 'RECEIPT' }), 1);
      const line = (await PurchaseOrder.findById(po._id)).lines[0];
      assert.deepEqual([line.acceptedQty, line.rejectedQty, line.receivedQty], [25, 5, 25], 'PO written back once');
    }
  });
});
