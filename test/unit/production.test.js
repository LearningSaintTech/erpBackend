import {
  startDb, stopDb, seedBase, makeMaterial, makeSkuWithBom, makeApprovedOrder, rmTotals, activeReservedQty,
  assertStockInvariants, rejectsConflict, rejectsWith,
} from '../helpers/db.js';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import * as productionService from '../../src/modules/production/production.service.js';
import * as qualityService from '../../src/modules/quality/quality.service.js';
import * as qualityExt from '../../src/modules/quality/qualityExtended.service.js';
import * as inventoryService from '../../src/modules/inventory/inventory.service.js';
import { ProductionOrder } from '../../src/modules/production/productionOrder.model.js';
import { ProductionBatch } from '../../src/modules/production/productionBatch.model.js';
import { WasteRecord } from '../../src/modules/waste/wasteRecord.model.js';
import { InventoryBalance } from '../../src/modules/inventory/inventoryBalance.model.js';
import { ApprovalInstance } from '../../src/modules/approval/approvalInstance.model.js';
import { ValidationError } from '../../src/shared/errors/AppError.js';

let ctx;
let fabric;
let button;
let sku;
let bom;

const P = productionService;

async function newBatch(order, plannedQuantity) {
  return P.createBatch({ productionOrderId: order._id, plannedQuantity }, ctx.userId, ctx.factoryId);
}
async function start(batch) {
  return P.startBatch(batch._id, ctx.userId, ctx.factoryId);
}
async function completeStage(batch, opts = {}) {
  return P.completeBatchStage(batch._id, ctx.userId, { skipQcGate: true, ...opts }, ctx.factoryId);
}
/** Run a started batch through every remaining stage (QC gate skipped). */
async function finishLine(batch) {
  let b = await ProductionBatch.findById(batch._id);
  let guard = 0;
  while (['IN_PROGRESS', 'REWORK'].includes(b.status) && guard < 20) {
    guard += 1;
    b = await completeStage(b);
  }
  return ProductionBatch.findById(batch._id);
}
async function inProcess(batch, body) {
  const insp = await qualityExt.createInProcessInspection(batch._id, ctx.userId, ctx.factoryId);
  return qualityService.completeInspection(insp._id, body, ctx.userId, ctx.factoryId);
}
async function finalQc(batch, body) {
  const insp = await qualityService.createFinalInspection(batch._id, ctx.userId, {}, ctx.factoryId);
  return qualityService.completeInspection(insp._id, body, ctx.userId, ctx.factoryId);
}
const order = (id) => ProductionOrder.findById(id);
const batchDoc = (id) => ProductionBatch.findById(id);

before(async () => {
  await startDb();
  ctx = await seedBase({ stages: ['CUTTING', 'STITCHING'] }); // → CUTTING, STITCHING, PACKING, QC, COMPLETED
  fabric = await makeMaterial(ctx, { unit: 'METERS', unitCost: 100 });
  button = await makeMaterial(ctx, { unit: 'PIECES', unitCost: 2, category: 'BUTTON' });
  // per piece: fabric 2 m + 5 % = 2.1 m @100 = 210; buttons 6 @2 = 12 → 222
  ({ sku, bom } = await makeSkuWithBom(ctx, [
    { material: fabric, qty: 2, wastagePercent: 5, unitCost: 100 },
    { material: button, qty: 6, unitCost: 2 },
  ]));
  const rec = (m, q) => inventoryService.receiptMaterial({
    factoryId: ctx.factoryId, organizationId: ctx.orgId, materialId: m._id, quantity: q, userId: ctx.userId,
  });
  await rec(fabric, 1000);
  await rec(button, 10000);
});
after(stopDb);

describe('standard vs actual cost', () => {
  it('standard = BOM cost × qty; actual = Σ issued qty × master rate; per-piece costs', async () => {
    assert.equal(bom.totalCostPerPiece, 222);
    const o = await makeApprovedOrder(ctx, sku, 10);
    assert.equal(o.standardCostPerPiece, 222);
    assert.equal(o.standardMaterialCost, 2220);
    assert.equal(o.status, 'APPROVED');
    assert.equal(await activeReservedQty(ctx, fabric._id, { referenceId: o._id }), 21);

    const b = await newBatch(o, 6);
    const started = await start(b);
    assert.equal(started.status, 'IN_PROGRESS');
    // 12.6 m × 100 + 36 × 2 = 1332
    assert.equal(started.actualMaterialCost, 1332);
    assert.equal((await order(o._id)).actualMaterialCost, 1332);
    assert.equal(P.batchCostPerPiece(started, o), 222);
    // the order's own reservation was drawn down, nothing else
    assert.ok(Math.abs(await activeReservedQty(ctx, fabric._id, { referenceId: o._id }) - 8.4) < 1e-9);
    assert.equal(await activeReservedQty(ctx, button._id, { referenceId: o._id }), 24);
    await assertStockInvariants(ctx, fabric._id);
    await assertStockInvariants(ctx, button._id);

    // fallback: no issue yet → standard material cost / planned
    const fresh = await newBatch(o, 4);
    assert.equal(P.batchCostPerPiece(fresh, o), 222);
    assert.equal(P.batchCostPerPiece({ actualMaterialCost: 0, plannedQuantity: 1 }, { plannedQuantity: 0, standardCostPerPiece: 7 }), 7);
  });
});

describe('createBatch cap', () => {
  it('cap = planned − batched + rejects (in-process and final)', async () => {
    const o = await makeApprovedOrder(ctx, sku, 10);
    const b1 = await newBatch(o, 6);
    assert.equal((await order(o._id)).status, 'IN_PROGRESS');
    await rejectsConflict(newBatch(o, 5), /exceeds remaining order quantity \(4\)/);
    const b2 = await newBatch(o); // default = remaining
    assert.equal(b2.plannedQuantity, 4);
    await rejectsConflict(newBatch(o, 1), /fully batched/);

    // in-process reject of 2 opens 2 more
    await start(b1);
    await inProcess(b1, { passedQuantity: 4, failedQuantity: 2 });
    assert.equal(await P.getBatchableQuantity(await order(o._id)), 2);
    await rejectsConflict(newBatch(o, 3));
    const b3 = await newBatch(o, 2);
    assert.equal(b3.plannedQuantity, 2);

    // a cancelled batch frees its quantity again
    await ProductionBatch.updateOne({ _id: b3._id }, { $set: { status: 'CANCELLED' } });
    assert.equal(await P.getBatchableQuantity(await order(o._id)), 2);
  });
});

describe('in-process QC', () => {
  it('QC-gated stage cannot complete without a pass; rejects reduce good qty and post waste at cost/piece', async () => {
    const o = await makeApprovedOrder(ctx, sku, 5);
    const b = await start(await newBatch(o, 5));
    assert.equal(b.currentStage, 'CUTTING');
    await rejectsConflict(P.completeBatchStage(b._id, ctx.userId, {}, ctx.factoryId), /In-process QC required/);

    await rejectsWith(inProcess(b, { passedQuantity: 5, failedQuantity: 1 }), ValidationError, /cannot exceed/);
    const insp = await inProcess(b, { passedQuantity: 3, failedQuantity: 2 });
    assert.equal(insp.result, 'PARTIAL');
    let fresh = await batchDoc(b._id);
    assert.equal(fresh.rejectedQuantity, 2);
    assert.equal(P.batchGoodQuantity(fresh), 3);
    assert.equal(fresh.stageQcPassed.get('CUTTING'), true);
    assert.equal((await order(o._id)).rejectedQuantity, 2);

    const waste = await WasteRecord.findOne({ batchId: b._id, wasteType: 'REJECTED_PIECES' });
    assert.equal(waste.quantity, 2);
    assert.equal(waste.unitCost, 222);
    assert.equal(waste.totalCost, 444);
    const rejStock = await InventoryBalance.findOne({ factoryId: ctx.factoryId, skuId: sku._id, inventoryType: 'REJECTED' });
    assert.ok(rejStock.onHand >= 2);

    // now the gate is open
    fresh = await P.completeBatchStage(b._id, ctx.userId, {}, ctx.factoryId);
    assert.equal(fresh.currentStage, 'STITCHING');

    // a second in-process check counts against the reduced good qty (3)
    await rejectsWith(inProcess(fresh, { passedQuantity: 3, failedQuantity: 1 }), ValidationError);
    const all = await inProcess(fresh, { result: 'FAIL' });
    assert.equal(all.failedQuantity, 3, 'FAIL without quantities rejects all good pieces');
    const closed = await batchDoc(b._id);
    assert.equal(closed.status, 'CANCELLED');
    assert.equal(closed.closedReason, 'ALL_PIECES_REJECTED');
  });

  it('REWORK posts nothing and rolls the batch back, clearing that stage\'s QC pass', async () => {
    const o = await makeApprovedOrder(ctx, sku, 3);
    let b = await start(await newBatch(o, 3));
    await inProcess(b, { result: 'PASS' });
    b = await P.completeBatchStage(b._id, ctx.userId, {}, ctx.factoryId);
    assert.equal(b.currentStage, 'STITCHING');
    const wasteBefore = await WasteRecord.countDocuments({ batchId: b._id });

    const insp = await inProcess(b, { passedQuantity: 1, failedQuantity: 2, disposition: 'REWORK' });
    assert.equal(insp.result, 'REWORK');
    assert.equal(insp.passedQuantity, 0);
    assert.equal(insp.failedQuantity, 0);
    const rolled = await batchDoc(b._id);
    assert.equal(rolled.status, 'REWORK');
    assert.equal(rolled.currentStage, 'CUTTING');
    assert.equal(rolled.stageQcPassed.get('CUTTING'), false);
    assert.equal(rolled.rejectedQuantity, 0);
    assert.equal(await WasteRecord.countDocuments({ batchId: b._id }), wasteBefore);
    await rejectsConflict(P.completeBatchStage(b._id, ctx.userId, {}, ctx.factoryId), /In-process QC required/);
    await rejectsConflict(P.rollbackBatchStage(b._id, ctx.userId, ctx.factoryId), /first stage/);
  });
});

describe('final QC and order completion', () => {
  it('final QC must account for every piece; explicit 0 stays 0', async () => {
    const o = await makeApprovedOrder(ctx, sku, 4);
    const b = await finishLine(await start(await newBatch(o, 4)));
    assert.equal(b.status, 'COMPLETED');
    assert.equal(b.producedQuantity, 4);
    assert.equal((await order(o._id)).producedQuantity, 4);

    const insp = await qualityService.createFinalInspection(b._id, ctx.userId, {}, ctx.factoryId);
    const complete = (body) => qualityService.completeInspection(insp._id, body, ctx.userId, ctx.factoryId);
    await rejectsWith(complete({ passedQuantity: 3, failedQuantity: 0 }), ValidationError, /must equal 4/);
    await rejectsWith(complete({ passedQuantity: 0, result: 'PASS' }), ValidationError, /must equal 4/);
    await rejectsWith(complete({ passedQuantity: 3, failedQuantity: 2 }), ValidationError);
    const done = await complete({ passedQuantity: 0, failedQuantity: 4 });
    assert.equal(done.passedQuantity, 0);
    assert.equal(done.failedQuantity, 4);
    assert.equal(done.result, 'FAIL');
    const ord = await order(o._id);
    assert.equal(ord.passedQuantity, 0);
    assert.equal(ord.rejectedQuantity, 4);
    assert.equal(ord.status, 'IN_PROGRESS');
    // final rejects reopen the cap
    assert.equal(await P.getBatchableQuantity(ord), 4);
    const waste = await WasteRecord.findOne({ batchId: b._id, wasteType: 'REJECTED_PIECES' });
    assert.equal(waste.quantity, 4);
    assert.equal(waste.totalCost, 4 * 222);
  });

  it('order completes only when every non-cancelled batch has a completed FINAL QC and passed ≥ planned', async () => {
    const o = await makeApprovedOrder(ctx, sku, 4);
    const fgBefore = (await InventoryBalance.findOne({ factoryId: ctx.factoryId, skuId: sku._id, inventoryType: 'FINISHED_GOODS' }))?.onHand || 0;
    const a = await finishLine(await start(await newBatch(o, 2)));
    const b = await start(await newBatch(o, 2));

    await finalQc(a, { passedQuantity: 1, failedQuantity: 1 });
    let ord = await order(o._id);
    assert.equal(ord.passedQuantity, 1);
    assert.equal(ord.status, 'IN_PROGRESS');
    assert.equal(await P.getBatchableQuantity(ord), 1);

    await finishLine(b);
    await finalQc(b, { result: 'PASS' });
    ord = await order(o._id);
    assert.equal(ord.passedQuantity, 3);
    assert.equal(ord.status, 'IN_PROGRESS', 'passed 3 < planned 4');

    // top-up batch for the final reject
    const c = await finishLine(await start(await newBatch(o, 1)));
    ord = await order(o._id);
    assert.equal(ord.status, 'IN_PROGRESS', 'top-up batch has no final QC yet');
    await finalQc(c, { result: 'PASS' });
    ord = await order(o._id);
    assert.equal(ord.passedQuantity, 4);
    assert.equal(ord.producedQuantity, 5);
    assert.equal(ord.status, 'COMPLETED');

    const fg = await InventoryBalance.findOne({ factoryId: ctx.factoryId, skuId: sku._id, inventoryType: 'FINISHED_GOODS' });
    assert.equal(fg.onHand - fgBefore, 4);
    // leftover holds of the order are released on completion
    assert.equal(await activeReservedQty(ctx, fabric._id, { referenceId: o._id }), 0);
    assert.equal(await activeReservedQty(ctx, button._id, { referenceId: o._id }), 0);
    await assertStockInvariants(ctx, fabric._id);
  });

  it('final REWORK posts nothing and takes the batch output back off the order', async () => {
    const o = await makeApprovedOrder(ctx, sku, 2);
    const b = await finishLine(await start(await newBatch(o, 2)));
    assert.equal((await order(o._id)).producedQuantity, 2);
    const insp = await finalQc(b, { disposition: 'REWORK' });
    assert.equal(insp.passedQuantity, 0);
    assert.equal(insp.failedQuantity, 0);
    const reopened = await batchDoc(b._id);
    assert.equal(reopened.status, 'REWORK');
    assert.equal(reopened.currentStage, 'PACKING', 'last QC-gated stage');
    assert.equal(reopened.qcInspectionId, undefined);
    const ord = await order(o._id);
    assert.equal(ord.producedQuantity, 0);
    assert.equal(ord.passedQuantity, 0);
    const again = await finishLine(reopened);
    assert.equal(again.status, 'COMPLETED');
    await finalQc(again, { result: 'PASS' });
    const done = await order(o._id);
    assert.equal(done.producedQuantity, 2);
    assert.equal(done.passedQuantity, 2);
    assert.equal(done.status, 'COMPLETED');
  });
});

describe('cancel production order', () => {
  it('blocked while a batch is running; otherwise cancels CREATED batches and releases holds', async () => {
    const o = await makeApprovedOrder(ctx, sku, 4);
    const running = await start(await newBatch(o, 2));
    await rejectsConflict(P.cancelProductionOrder(o._id, ctx.userId, ctx.factoryId), /in progress/);
    await finishLine(running);
    const idle = await newBatch(o, 2);
    const cancelled = await P.cancelProductionOrder(o._id, ctx.userId, ctx.factoryId);
    assert.equal(cancelled.status, 'CANCELLED');
    assert.equal((await batchDoc(idle._id)).status, 'CANCELLED');
    assert.equal(await activeReservedQty(ctx, fabric._id, { referenceId: o._id }), 0);
    assert.equal(await activeReservedQty(ctx, button._id, { referenceId: o._id }), 0);
    await assertStockInvariants(ctx, fabric._id);
    await rejectsConflict(P.cancelProductionOrder(o._id, ctx.userId, ctx.factoryId), /already/);
    await rejectsConflict(P.startBatch(idle._id, ctx.userId, ctx.factoryId));
  });

  it('cancel while APPROVAL_PENDING closes the approval instance and releases everything reserved', async () => {
    const o = await P.createProductionOrder({ factoryId: ctx.factoryId, organizationId: ctx.orgId, skuId: sku._id, plannedQuantity: 3 }, ctx.userId);
    await P.runProductionMrp(o._id, ctx.userId, ctx.factoryId);
    await P.reserveProductionMaterials(o._id, ctx.userId, ctx.factoryId);
    const before = await rmTotals(ctx, fabric._id);
    await P.submitProductionOrderForApproval(o._id, ctx.userId, ctx.factoryId);
    await P.cancelProductionOrder(o._id, ctx.userId, ctx.factoryId);
    const inst = await ApprovalInstance.findOne({ documentId: o._id });
    assert.equal(inst.status, 'CANCELLED');
    const after = await rmTotals(ctx, fabric._id);
    assert.ok(Math.abs(before.reserved - after.reserved - 6.3) < 1e-9, 'released 3 × 2.1 m');
    assert.equal(after.onHand, before.onHand);
  });
});

describe('production status transitions', () => {
  it('invalid order and batch transitions are refused with ConflictError', async () => {
    const o = await P.createProductionOrder({ factoryId: ctx.factoryId, organizationId: ctx.orgId, skuId: sku._id, plannedQuantity: 2 }, ctx.userId);
    await rejectsConflict(P.reserveProductionMaterials(o._id, ctx.userId, ctx.factoryId), /Run MRP first/);
    await rejectsConflict(P.submitProductionOrderForApproval(o._id, ctx.userId, ctx.factoryId));
    await rejectsConflict(P.approveProductionOrder(o._id, ctx.approver._id, { factoryId: ctx.factoryId }));
    await rejectsConflict(newBatch(o, 1), /APPROVED/);
    await P.runProductionMrp(o._id, ctx.userId, ctx.factoryId);
    await P.reserveProductionMaterials(o._id, ctx.userId, ctx.factoryId);
    await rejectsConflict(P.runProductionMrp(o._id, ctx.userId, ctx.factoryId));
    await rejectsConflict(P.updateProductionOrder(o._id, { plannedQuantity: 5 }, ctx.userId, ctx.factoryId), /reserved/);
    await P.submitProductionOrderForApproval(o._id, ctx.userId, ctx.factoryId);
    await P.approveProductionOrder(o._id, ctx.approver._id, { factoryId: ctx.factoryId });
    await rejectsConflict(P.approveProductionOrder(o._id, ctx.approver._id, { factoryId: ctx.factoryId }));

    const b = await newBatch(o, 2);
    await rejectsConflict(P.completeBatchStage(b._id, ctx.userId, { skipQcGate: true }, ctx.factoryId), /not in progress/);
    await rejectsConflict(P.rollbackBatchStage(b._id, ctx.userId, ctx.factoryId));
    await rejectsConflict(qualityService.createFinalInspection(b._id, ctx.userId, {}, ctx.factoryId), /completed before final QC/);
    await start(b);
    await rejectsConflict(start(b), /already started/);
    const done = await finishLine(b);
    await rejectsConflict(P.completeBatchStage(done._id, ctx.userId, { skipQcGate: true }, ctx.factoryId));
    await finalQc(done, { result: 'PASS' });
    await rejectsConflict(qualityService.createFinalInspection(b._id, ctx.userId, {}, ctx.factoryId), /already completed/);
    await rejectsConflict(P.cancelProductionOrder(o._id, ctx.userId, ctx.factoryId), /already completed/);
  });
});
