import {
  startDb, stopDb, seedBase, makeMaterial, makeSkuWithBom, makeApprovedOrder, rmTotals, assertStockInvariants,
  settle, isConflict, ITERATIONS,
} from '../helpers/db.js';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import * as P from '../../src/modules/production/production.service.js';
import * as qualityService from '../../src/modules/quality/quality.service.js';
import * as inventoryService from '../../src/modules/inventory/inventory.service.js';
import { ProductionOrder } from '../../src/modules/production/productionOrder.model.js';
import { ProductionBatch } from '../../src/modules/production/productionBatch.model.js';
import { InventoryTransaction } from '../../src/modules/inventory/inventoryTransaction.model.js';
import { InventoryBalance } from '../../src/modules/inventory/inventoryBalance.model.js';

let ctx;
let fabric;
let sku;

before(async () => {
  await startDb();
  ctx = await seedBase({ stages: ['CUTTING'] }); // CUTTING, PACKING, QC, COMPLETED
  fabric = await makeMaterial(ctx, { unitCost: 10 });
  ({ sku } = await makeSkuWithBom(ctx, [{ material: fabric, qty: 2, unitCost: 10 }]));
  await inventoryService.receiptMaterial({
    factoryId: ctx.factoryId, organizationId: ctx.orgId, materialId: fabric._id, quantity: 100000, userId: ctx.userId,
  });
});
after(stopDb);

async function startedBatch(qty) {
  const order = await makeApprovedOrder(ctx, sku, qty);
  const batch = await P.createBatch({ productionOrderId: order._id, plannedQuantity: qty }, ctx.userId, ctx.factoryId);
  await P.startBatch(batch._id, ctx.userId, ctx.factoryId);
  return { order, batch };
}
const done = (batchId) => P.completeBatchStage(batchId, ctx.userId, { skipQcGate: true }, ctx.factoryId);

describe('batch stage races', () => {
  it(`double "complete stage" on the last stage → producedQuantity counted once (×${ITERATIONS})`, async () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const { order, batch } = await startedBatch(3);
      await done(batch._id); // CUTTING → PACKING
      await done(batch._id); // PACKING → QC
      const { ok, failed } = await settle([done(batch._id), done(batch._id)]);
      assert.equal(ok.length, 1, `iteration ${i}`);
      assert.ok(isConflict(failed[0]), failed[0]?.message);
      const b = await ProductionBatch.findById(batch._id);
      assert.equal(b.status, 'COMPLETED');
      assert.equal(b.producedQuantity, 3);
      assert.equal((await ProductionOrder.findById(order._id)).producedQuantity, 3, 'counted once');
    }
  });

  it(`double "complete stage" mid-line advances one stage only (×${ITERATIONS})`, async () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const { batch } = await startedBatch(1);
      const { ok, failed } = await settle([done(batch._id), done(batch._id)]);
      assert.equal(ok.length, 1);
      assert.ok(isConflict(failed[0]), failed[0]?.message);
      const b = await ProductionBatch.findById(batch._id);
      assert.equal(b.currentStage, 'PACKING');
      assert.equal(b.stageHistory.length, 2, 'CUTTING closed + PACKING opened, nothing duplicated');
      assert.equal(b.stageHistory.filter((h) => h.completedAt).length, 1);
    }
  });
});

describe('startBatch races', () => {
  it(`two simultaneous startBatch calls → materials issued once (×${ITERATIONS})`, async () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const order = await makeApprovedOrder(ctx, sku, 4);
      const batch = await P.createBatch({ productionOrderId: order._id, plannedQuantity: 4 }, ctx.userId, ctx.factoryId);
      const before = await rmTotals(ctx, fabric._id);
      const { ok, failed } = await settle([
        P.startBatch(batch._id, ctx.userId, ctx.factoryId),
        P.startBatch(batch._id, ctx.userId, ctx.factoryId),
      ]);
      assert.equal(ok.length, 1, `iteration ${i}`);
      assert.ok(isConflict(failed[0]), failed[0]?.message);
      const after = await rmTotals(ctx, fabric._id);
      assert.equal(before.onHand - after.onHand, 8, 'issued 4 × 2 m once');
      assert.equal(await InventoryTransaction.countDocuments({ referenceId: batch._id, type: 'ISSUE' }), 1);
      const b = await ProductionBatch.findById(batch._id);
      assert.equal(b.status, 'IN_PROGRESS');
      assert.equal(b.issuedMaterials.length, 1);
      assert.equal(b.actualMaterialCost, 80);
      assert.equal((await ProductionOrder.findById(order._id)).actualMaterialCost, 80, 'cost added once');
      await assertStockInvariants(ctx, fabric._id);
    }
  });
});

describe('final QC races', () => {
  it(`two simultaneous final QC completions → FG posted once, order passed once (×${ITERATIONS})`, async () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const { order, batch } = await startedBatch(2);
      for (let s = 0; s < 3; s += 1) await done(batch._id);
      const fgBefore = (await InventoryBalance.findOne({ factoryId: ctx.factoryId, skuId: sku._id, inventoryType: 'FINISHED_GOODS' }))?.onHand || 0;
      const insp = await qualityService.createFinalInspection(batch._id, ctx.userId, {}, ctx.factoryId);
      const { ok, failed } = await settle([
        qualityService.completeInspection(insp._id, { result: 'PASS' }, ctx.userId, ctx.factoryId),
        qualityService.completeInspection(insp._id, { result: 'PASS' }, ctx.userId, ctx.factoryId),
      ]);
      assert.equal(ok.length, 1);
      assert.ok(isConflict(failed[0]), failed[0]?.message);
      const fg = await InventoryBalance.findOne({ factoryId: ctx.factoryId, skuId: sku._id, inventoryType: 'FINISHED_GOODS' });
      assert.equal(fg.onHand - fgBefore, 2);
      const o = await ProductionOrder.findById(order._id);
      assert.equal(o.passedQuantity, 2);
      assert.equal(o.status, 'COMPLETED');
    }
  });
});
