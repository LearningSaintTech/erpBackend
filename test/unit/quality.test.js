import {
  startDb, stopDb, seedBase, makeMaterial, makeSentPo, makeWarehouse, rmTotals, rmRows, rejectsWith, rejectsConflict,
} from '../helpers/db.js';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import * as purchaseService from '../../src/modules/purchase/purchase.service.js';
import * as qualityService from '../../src/modules/quality/quality.service.js';
import { GoodsReceipt } from '../../src/modules/purchase/goodsReceipt.model.js';
import { PurchaseOrder } from '../../src/modules/purchase/purchaseOrder.model.js';
import { QualityInspection } from '../../src/modules/quality/qualityInspection.model.js';
import { ValidationError } from '../../src/shared/errors/AppError.js';

let ctx;
let a;
let b;

/** Two-line GRN (a: 10, b: 20) submitted for QC; returns { grn, inspectionId, po }. */
async function pendingGrn(qtyA = 10, qtyB = 20) {
  const poLines = [{ material: a, qty: qtyA, unitPrice: 5 }];
  if (qtyB) poLines.push({ material: b, qty: qtyB, unitPrice: 1 });
  const po = await makeSentPo(ctx, poLines);
  const lines = [{ materialId: a._id, receivedQty: qtyA }];
  if (qtyB) lines.push({ materialId: b._id, receivedQty: qtyB });
  const grn = await purchaseService.createGoodsReceipt({
    factoryId: ctx.factoryId, organizationId: ctx.orgId, poId: po._id, lines,
  }, ctx.userId);
  await purchaseService.submitGrnForQc(grn._id, ctx.factoryId, ctx.userId);
  const fresh = await GoodsReceipt.findById(grn._id);
  return { grn: fresh, inspectionId: fresh.qcInspectionId, po };
}
const complete = (id, body) => qualityService.completeInspection(id, body, ctx.userId, ctx.factoryId);

before(async () => {
  await startDb();
  ctx = await seedBase();
  a = await makeMaterial(ctx);
  b = await makeMaterial(ctx, { unit: 'PIECES' });
});
after(stopDb);

describe('incoming QC quantity rules', () => {
  it('multi-line GRN: per-line results required when quantities are given', async () => {
    const { inspectionId } = await pendingGrn();
    await rejectsWith(complete(inspectionId, { passedQuantity: 30, failedQuantity: 0 }), ValidationError, /lines\[\]/);
    await rejectsWith(complete(inspectionId, { result: 'PARTIAL' }), ValidationError, /lines\[\]/);
    await rejectsWith(complete(inspectionId, {
      lines: [{ materialId: a._id, acceptedQty: 10, rejectedQty: 0 }],
    }), ValidationError, /every GRN line/);
    await rejectsWith(complete(inspectionId, {
      lines: [
        { materialId: a._id, acceptedQty: 8, rejectedQty: 3 },
        { materialId: b._id, acceptedQty: 20, rejectedQty: 0 },
      ],
    }), ValidationError, /must equal the received/);
    await rejectsWith(complete(inspectionId, {
      lines: [
        { materialId: a._id, acceptedQty: 10 },
        { materialId: a._id, acceptedQty: 10 },
      ],
    }), ValidationError, /listed twice/);
    await rejectsWith(complete(inspectionId, { result: 'REWORK' }), ValidationError, /REWORK/);
    // nothing was posted or claimed by the failed attempts
    const insp = await QualityInspection.findById(inspectionId);
    assert.equal(insp.status, 'PENDING');
    assert.equal(insp.completingAt ?? null, null);
    assert.equal((await rmTotals(ctx, a._id)).onHand, 0);
  });

  it('per-line accept/reject sums become the inspection totals and post per material', async () => {
    const beforeA = (await rmTotals(ctx, a._id)).onHand;
    const beforeB = (await rmTotals(ctx, b._id)).onHand;
    const { inspectionId, po } = await pendingGrn();
    const insp = await complete(inspectionId, {
      lines: [
        { materialId: a._id, acceptedQty: 7, rejectedQty: 3 },
        { materialId: b._id, acceptedQty: 20, rejectedQty: 0 },
      ],
    });
    assert.equal(insp.passedQuantity, 27);
    assert.equal(insp.failedQuantity, 3);
    assert.equal(insp.result, 'PARTIAL');
    assert.equal(insp.disposition, 'PASS');
    assert.equal(insp.lineResults.length, 2);
    assert.equal((await rmTotals(ctx, a._id)).onHand - beforeA, 7);
    assert.equal((await rmTotals(ctx, b._id)).onHand - beforeB, 20);
    const fresh = await PurchaseOrder.findById(po._id);
    const la = fresh.lines.find((l) => String(l.materialId) === String(a._id));
    assert.deepEqual([la.acceptedQty, la.rejectedQty, la.receivedQty], [7, 3, 7]);
    assert.equal(fresh.status, 'PARTIAL');
  });

  it('multi-line all-PASS / all-REJECT verdict without quantities applies to every line', async () => {
    const before = (await rmTotals(ctx, b._id)).onHand;
    const g1 = await pendingGrn(4, 6);
    const pass = await complete(g1.inspectionId, { result: 'PASS' });
    assert.deepEqual([pass.passedQuantity, pass.failedQuantity, pass.result], [10, 0, 'PASS']);
    assert.equal((await rmTotals(ctx, b._id)).onHand - before, 6);
    const g2 = await pendingGrn(4, 6);
    const fail = await complete(g2.inspectionId, { disposition: 'REJECT' });
    assert.deepEqual([fail.passedQuantity, fail.failedQuantity, fail.result, fail.disposition], [0, 10, 'FAIL', 'REJECT']);
    assert.equal((await rmTotals(ctx, b._id)).onHand - before, 6, 'rejected lot posts nothing');
  });

  it('single-line lot rules: defaults, partial fill-in, explicit 0, every piece accounted for', async () => {
    const one = async () => (await pendingGrn(10, 0)).inspectionId;
    await rejectsWith(complete(await one(), { passedQuantity: 8, failedQuantity: 3 }), ValidationError, /must equal/);

    let r = await complete(await one(), {});
    assert.deepEqual([r.passedQuantity, r.failedQuantity, r.result], [10, 0, 'PASS'], 'no input → whole lot passes');

    r = await complete(await one(), { failedQuantity: 4 });
    assert.deepEqual([r.passedQuantity, r.failedQuantity, r.result], [6, 4, 'PARTIAL'], 'passed = lot − failed');

    r = await complete(await one(), { passedQuantity: 7, result: 'PARTIAL' });
    assert.deepEqual([r.passedQuantity, r.failedQuantity], [7, 3], 'PARTIAL fills failed = lot − passed');

    // Under-accounting is refused: the 3 missing pieces would be neither in stock nor re-orderable.
    await rejectsWith(complete(await one(), { passedQuantity: 7, result: 'PASS' }), ValidationError, /must equal/);

    r = await complete(await one(), { passedQuantity: 0, failedQuantity: 10 });
    assert.deepEqual([r.passedQuantity, r.failedQuantity], [0, 10], 'explicit 0 stays 0 (not defaulted to the lot)');

    r = await complete(await one(), { passedQuantity: 10, result: 'FAIL' });
    assert.equal(r.result, 'PASS', 'quantities win over the client label');
  });

  it('a RAW_MATERIAL bin is validated up front and receives the accepted qty', async () => {
    const rm = await makeWarehouse(ctx, { type: 'RAW_MATERIAL', bins: 1 });
    const fg = await makeWarehouse(ctx, { type: 'FINISHED_GOODS', bins: 1 });
    const { inspectionId } = await pendingGrn(5, 0);
    await rejectsConflict(complete(inspectionId, { result: 'PASS', storageBinId: fg.bins[0]._id }), /RAW_MATERIAL/);
    assert.equal((await QualityInspection.findById(inspectionId)).status, 'PENDING');
    await complete(inspectionId, { result: 'PASS', storageBinId: rm.bins[0]._id });
    const row = (await rmRows(ctx, a._id)).find((x) => String(x.storageBinId) === String(rm.bins[0]._id));
    assert.equal(row.onHand, 5);
  });
});
