import {
  startDb, stopDb, seedBase, makeMaterial, makeSupplier, makeSentPo, makeSkuWithBom, rmTotals,
  rejectsConflict, rejectsWith, mongoose,
} from '../helpers/db.js';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import * as purchaseService from '../../src/modules/purchase/purchase.service.js';
import * as qualityService from '../../src/modules/quality/quality.service.js';
import * as mrpService from '../../src/modules/mrp/mrp.service.js';
import { PurchaseOrder } from '../../src/modules/purchase/purchaseOrder.model.js';
import { PurchaseRequisition } from '../../src/modules/purchase/purchaseRequisition.model.js';
import { GoodsReceipt } from '../../src/modules/purchase/goodsReceipt.model.js';
import { Material } from '../../src/modules/inventory/material.model.js';
import { ValidationError, NotFoundError } from '../../src/shared/errors/AppError.js';

let ctx;
const oid = () => new mongoose.Types.ObjectId();

function grn(po, lines) {
  return purchaseService.createGoodsReceipt({
    factoryId: ctx.factoryId, organizationId: ctx.orgId, poId: po._id,
    lines: lines.map((l) => ({ materialId: l.material._id, receivedQty: l.qty, unit: l.unit })),
  }, ctx.userId);
}
async function submitForQc(g) {
  await purchaseService.submitGrnForQc(g._id, ctx.factoryId, ctx.userId);
  return GoodsReceipt.findById(g._id);
}
async function approvedPr(lines) {
  const pr = await purchaseService.createPurchaseRequisition({
    factoryId: ctx.factoryId, organizationId: ctx.orgId,
    lines: lines.map((l) => ({ materialId: l.material._id, requiredQty: l.qty, estimatedUnitCost: l.cost ?? 1 })),
  }, ctx.userId);
  await purchaseService.submitPurchaseRequisition(pr._id, ctx.factoryId, ctx.userId);
  return purchaseService.approvePurchaseRequisition(pr._id, ctx.factoryId, ctx.approver._id, { permissions: ['*'] });
}
const poLine = (po, mat) => po.lines.find((l) => String(l.materialId?._id || l.materialId) === String(mat._id));

before(async () => {
  await startDb();
  ctx = await seedBase();
});
after(stopDb);

describe('purchase order totals', () => {
  it('PO total = Σ orderedQty × unitPrice, per-line extendedPrice', async () => {
    const a = await makeMaterial(ctx);
    const b = await makeMaterial(ctx, { unit: 'PIECES' });
    const po = await makeSentPo(ctx, [{ material: a, qty: 12.5, unitPrice: 80 }, { material: b, qty: 300, unitPrice: 1.75 }]);
    assert.equal(poLine(po, a).extendedPrice, 1000);
    assert.equal(poLine(po, b).extendedPrice, 525);
    assert.equal(po.totalAmount, 1525);
    assert.equal(po.status, 'SENT');
  });

  it('PO from a PR may not exceed the approved PR qty; the PR is converted once', async () => {
    const m = await makeMaterial(ctx, { unitCost: 4 });
    const pr = await approvedPr([{ material: m, qty: 20, cost: 4 }]);
    assert.equal(pr.status, 'APPROVED');
    const supplier = await makeSupplier(ctx);
    await rejectsWith(purchaseService.createPurchaseOrder({
      factoryId: ctx.factoryId, organizationId: ctx.orgId, supplierId: supplier._id, prId: pr._id,
      lines: [{ materialId: m._id, orderedQty: 21, unitPrice: 4 }],
    }, ctx.userId), ValidationError, /exceeds approved PR qty/);
    const po = await purchaseService.createPurchaseOrder({
      factoryId: ctx.factoryId, organizationId: ctx.orgId, supplierId: supplier._id, prId: pr._id,
    }, ctx.userId);
    assert.equal(po.totalAmount, 80);
    assert.equal((await PurchaseRequisition.findById(pr._id)).status, 'CONVERTED');
    await rejectsConflict(purchaseService.createPurchaseOrder({
      factoryId: ctx.factoryId, organizationId: ctx.orgId, supplierId: supplier._id, prId: pr._id,
    }, ctx.userId), /must be APPROVED/);
  });
});

describe('goods receipt', () => {
  it('caps each GRN at the PO remaining and derives PARTIAL / RECEIVED', async () => {
    const m = await makeMaterial(ctx);
    const po = await makeSentPo(ctx, [{ material: m, qty: 100, unitPrice: 10 }]);
    await grn(po, [{ material: m, qty: 60 }]);
    let fresh = await PurchaseOrder.findById(po._id);
    assert.equal(fresh.status, 'PARTIAL');
    assert.equal(poLine(fresh, m).receivedQty, 60);
    await rejectsConflict(grn(po, [{ material: m, qty: 41 }]), /more than the \d+ still open on this payment/);
    await rejectsWith(grn(po, [{ material: m, qty: 0 }]), ValidationError);
    await rejectsWith(grn(po, [{ material: m, qty: 5, unit: 'PIECES' }]), ValidationError, /is received in \w+ \(the payment's unit\)/);
    const other = await makeMaterial(ctx);
    await rejectsConflict(grn(po, [{ material: other, qty: 1 }]), /is not on this payment/);
    await grn(po, [{ material: m, qty: 40 }]);
    fresh = await PurchaseOrder.findById(po._id);
    assert.equal(fresh.status, 'RECEIVED');
    assert.equal(poLine(fresh, m).receivedQty, 100);
    await rejectsConflict(grn(po, [{ material: m, qty: 1 }]), /not open/);
    assert.equal(await GoodsReceipt.countDocuments({ poId: po._id, isDeleted: false }), 2);
  });

  it('cancelling a DRAFT GRN returns its qty to the PO; only DRAFT can be cancelled', async () => {
    const m = await makeMaterial(ctx);
    const po = await makeSentPo(ctx, [{ material: m, qty: 10, unitPrice: 1 }]);
    const g = await grn(po, [{ material: m, qty: 10 }]);
    assert.equal((await PurchaseOrder.findById(po._id)).status, 'RECEIVED');
    await purchaseService.cancelGoodsReceipt(g._id, ctx.factoryId, ctx.userId);
    const fresh = await PurchaseOrder.findById(po._id);
    assert.equal(poLine(fresh, m).receivedQty, 0);
    assert.equal(fresh.status, 'SENT');
    await rejectsConflict(purchaseService.cancelGoodsReceipt(g._id, ctx.factoryId, ctx.userId), /Only a DRAFT/);
    const g2 = await grn(po, [{ material: m, qty: 4 }]);
    await submitForQc(g2);
    await rejectsConflict(purchaseService.submitGrnForQc(g2._id, ctx.factoryId, ctx.userId), /already submitted/);
    await rejectsConflict(purchaseService.cancelGoodsReceipt(g2._id, ctx.factoryId, ctx.userId));
  });
});

describe('incoming QC write-back', () => {
  it('accepted qty is receipted at PO price; rejected leaves receivedQty; PO goes PARTIAL; idempotent', async () => {
    const m = await makeMaterial(ctx, { unitCost: 0 });
    const po = await makeSentPo(ctx, [{ material: m, qty: 50, unitPrice: 12 }]);
    const g = await submitForQc(await grn(po, [{ material: m, qty: 50 }]));
    assert.equal((await PurchaseOrder.findById(po._id)).status, 'RECEIVED');

    const insp = await qualityService.completeInspection(g.qcInspectionId, {
      lines: [{ materialId: m._id, acceptedQty: 45, rejectedQty: 5 }],
    }, ctx.userId, ctx.factoryId);
    assert.equal(insp.passedQuantity, 45);
    assert.equal(insp.failedQuantity, 5);
    assert.equal(insp.result, 'PARTIAL');

    assert.deepEqual(await rmTotals(ctx, m._id), { onHand: 45, reserved: 0, available: 45 });
    assert.equal((await Material.findById(m._id)).unitCost, 12);

    const po1 = await PurchaseOrder.findById(po._id);
    const l1 = poLine(po1, m);
    assert.equal(l1.acceptedQty, 45);
    assert.equal(l1.rejectedQty, 5);
    assert.equal(l1.receivedQty, 45, 'received is net of rejects');
    assert.equal(po1.status, 'PARTIAL');
    const g1 = await GoodsReceipt.findById(g._id);
    assert.equal(g1.status, 'COMPLETED');
    assert.equal(g1.lines[0].acceptedQty, 45);

    // second write-back is a no-op
    const again = await purchaseService.recordIncomingQcResult({
      grnId: g._id, factoryId: ctx.factoryId, lines: [{ materialId: m._id, acceptedQty: 45, rejectedQty: 5 }], userId: ctx.userId,
    });
    assert.equal(again.applied, false);
    const l2 = poLine(await PurchaseOrder.findById(po._id), m);
    assert.deepEqual([l2.acceptedQty, l2.rejectedQty, l2.receivedQty], [45, 5, 45]);

    // completing the inspection again is refused and posts nothing
    await rejectsConflict(qualityService.completeInspection(g.qcInspectionId, { result: 'PASS' }, ctx.userId, ctx.factoryId));
    assert.equal((await rmTotals(ctx, m._id)).onHand, 45);

    // the rejected 5 can be re-received → RECEIVED
    const g2 = await submitForQc(await grn(po, [{ material: m, qty: 5 }]));
    await qualityService.completeInspection(g2.qcInspectionId, { result: 'PASS' }, ctx.userId, ctx.factoryId);
    const po2 = await PurchaseOrder.findById(po._id);
    assert.equal(po2.status, 'RECEIVED');
    assert.equal(poLine(po2, m).acceptedQty, 50);
    assert.equal((await rmTotals(ctx, m._id)).onHand, 50);
  });

  it('full reject posts no stock and reopens the PO', async () => {
    const m = await makeMaterial(ctx);
    const po = await makeSentPo(ctx, [{ material: m, qty: 8, unitPrice: 3 }]);
    const g = await submitForQc(await grn(po, [{ material: m, qty: 8 }]));
    const insp = await qualityService.completeInspection(g.qcInspectionId, { result: 'FAIL' }, ctx.userId, ctx.factoryId);
    assert.equal(insp.passedQuantity, 0);
    assert.equal(insp.failedQuantity, 8);
    assert.equal((await rmTotals(ctx, m._id)).onHand, 0);
    const fresh = await PurchaseOrder.findById(po._id);
    assert.equal(poLine(fresh, m).receivedQty, 0);
    // derivePoReceiptStatus: nothing net-received / accepted → back to SENT (open for a replacement GRN)
    assert.equal(fresh.status, 'SENT');
    assert.equal(poLine(fresh, m).rejectedQty, 8);
  });

  it('recordIncomingQcResult clamps rejected to received and accepted to the rest', async () => {
    const m = await makeMaterial(ctx);
    const po = await makeSentPo(ctx, [{ material: m, qty: 10, unitPrice: 1 }]);
    const g = await grn(po, [{ material: m, qty: 6 }]);
    const res = await purchaseService.recordIncomingQcResult({
      grnId: g._id, factoryId: ctx.factoryId, userId: ctx.userId,
      lines: [{ materialId: m._id, acceptedQty: 99, rejectedQty: 2 }],
    });
    assert.equal(res.applied, true);
    const l = poLine(await PurchaseOrder.findById(po._id), m);
    assert.deepEqual([l.acceptedQty, l.rejectedQty, l.receivedQty], [4, 2, 4]);
    await rejectsWith(purchaseService.recordIncomingQcResult({
      grnId: oid(), factoryId: ctx.factoryId, userId: ctx.userId, lines: [],
    }), NotFoundError);
  });
});

describe('PO cancel / close', () => {
  it('cancel: only APPROVED/SENT without receipts; PR returns to APPROVED', async () => {
    const m = await makeMaterial(ctx);
    const pr = await approvedPr([{ material: m, qty: 5 }]);
    const supplier = await makeSupplier(ctx);
    const po = await purchaseService.createPurchaseOrder({
      factoryId: ctx.factoryId, organizationId: ctx.orgId, supplierId: supplier._id, prId: pr._id,
    }, ctx.userId);
    const cancelled = await purchaseService.cancelPurchaseOrder(po._id, ctx.factoryId, ctx.userId, 'test');
    assert.equal(cancelled.status, 'CANCELLED');
    assert.equal((await PurchaseRequisition.findById(pr._id)).status, 'APPROVED');
    await rejectsConflict(purchaseService.cancelPurchaseOrder(po._id, ctx.factoryId, ctx.userId));
    await rejectsConflict(grn(po, [{ material: m, qty: 1 }]), /not open/);

    const po2 = await makeSentPo(ctx, [{ material: m, qty: 5, unitPrice: 1 }]);
    await grn(po2, [{ material: m, qty: 1 }]);
    await rejectsConflict(purchaseService.cancelPurchaseOrder(po2._id, ctx.factoryId, ctx.userId), /received|PARTIAL|APPROVED or SENT/);
  });

  it('close: only PARTIAL, and not while a DRAFT GRN exists', async () => {
    const m = await makeMaterial(ctx);
    const po = await makeSentPo(ctx, [{ material: m, qty: 10, unitPrice: 1 }]);
    await rejectsConflict(purchaseService.closePurchaseOrder(po._id, ctx.factoryId, ctx.userId), /Only a PARTIAL/);
    const g = await grn(po, [{ material: m, qty: 3 }]);
    await rejectsConflict(purchaseService.closePurchaseOrder(po._id, ctx.factoryId, ctx.userId), /DRAFT GRN/);
    const sub = await submitForQc(g);
    await qualityService.completeInspection(sub.qcInspectionId, { result: 'PASS' }, ctx.userId, ctx.factoryId);
    const closed = await purchaseService.closePurchaseOrder(po._id, ctx.factoryId, ctx.userId, 'short');
    assert.equal(closed.status, 'CLOSED');
    await rejectsConflict(grn(po, [{ material: m, qty: 1 }]), /not open/);
    await rejectsConflict(purchaseService.sendPurchaseOrder(po._id, ctx.factoryId, ctx.userId));
  });
});

describe('PR status transitions', () => {
  it('invalid transitions are refused with ConflictError', async () => {
    const m = await makeMaterial(ctx);
    const pr = await purchaseService.createPurchaseRequisition({
      factoryId: ctx.factoryId, organizationId: ctx.orgId, lines: [{ materialId: m._id, requiredQty: 3 }],
    }, ctx.userId);
    await rejectsConflict(purchaseService.approvePurchaseRequisition(pr._id, ctx.factoryId, ctx.approver._id), /SUBMITTED/);
    await purchaseService.submitPurchaseRequisition(pr._id, ctx.factoryId, ctx.userId);
    await rejectsConflict(purchaseService.submitPurchaseRequisition(pr._id, ctx.factoryId, ctx.userId));
    await rejectsConflict(purchaseService.cancelPurchaseRequisition(pr._id, ctx.factoryId, ctx.userId));
    await rejectsConflict(purchaseService.updatePurchaseRequisition(pr._id, ctx.factoryId, {
      lines: [{ materialId: m._id, requiredQty: 4 }],
    }, ctx.userId));
    await purchaseService.approvePurchaseRequisition(pr._id, ctx.factoryId, ctx.approver._id, { permissions: ['*'] });
    await rejectsConflict(purchaseService.rejectPurchaseRequisition(pr._id, ctx.factoryId, ctx.approver._id, 'no', { syncApproval: false }));
    await rejectsConflict(purchaseService.requestPurchaseRequisitionChanges(pr._id, ctx.factoryId, ctx.approver._id, 'please fix'));
    assert.equal((await PurchaseRequisition.findById(pr._id)).status, 'APPROVED');
  });
});

describe('createPrFromMrp', () => {
  it('raises a PR for the shortage once; later runs only request the uncovered delta', async () => {
    const m = await makeMaterial(ctx, { unitCost: 5 });
    const { sku, bom } = await makeSkuWithBom(ctx, [{ material: m, qty: 2 }]);
    const ref = oid();
    const run = (orderQuantity) => mrpService.calculateMrp({
      bomId: bom._id, skuId: sku._id, factoryId: ctx.factoryId, organizationId: ctx.orgId,
      orderQuantity, userId: ctx.userId, referenceType: 'PRODUCTION_ORDER', referenceId: ref,
    });
    const mrp1 = await run(10); // need 20, stock 0
    assert.equal(mrp1.lines[0].shortageQty, 20);
    const pr1 = await purchaseService.createPrFromMrp(mrp1._id, ctx.factoryId, ctx.userId);
    assert.equal(pr1.lines[0].requiredQty, 20);
    assert.equal(pr1.sourceType, 'MRP');
    const again = await purchaseService.createPrFromMrp(mrp1._id, ctx.factoryId, ctx.userId);
    assert.equal(String(again._id), String(pr1._id), 'same MRP run → same PR');

    const mrp2 = await run(10);
    const same = await purchaseService.createPrFromMrp(mrp2._id, ctx.factoryId, ctx.userId);
    assert.equal(String(same._id), String(pr1._id), 'covered by the earlier PR → no new PR');

    const mrp3 = await run(15); // need 30, 20 already requested
    const pr3 = await purchaseService.createPrFromMrp(mrp3._id, ctx.factoryId, ctx.userId);
    assert.notEqual(String(pr3._id), String(pr1._id));
    assert.equal(pr3.lines[0].requiredQty, 10);
    assert.equal(await PurchaseRequisition.countDocuments({ mrpId: { $in: [mrp1._id, mrp2._id, mrp3._id] } }), 2);

    // a rejected/cancelled PR no longer covers anything
    await purchaseService.cancelPurchaseRequisition(pr1._id, ctx.factoryId, ctx.userId);
    const mrp4 = await run(15);
    const pr4 = await purchaseService.createPrFromMrp(mrp4._id, ctx.factoryId, ctx.userId);
    assert.equal(pr4.lines[0].requiredQty, 20);
  });
});
