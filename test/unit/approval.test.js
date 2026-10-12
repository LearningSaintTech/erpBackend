import {
  startDb, stopDb, seedBase, makeMaterial, rejectsConflict, rejectsWith,
} from '../helpers/db.js';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import * as approvalService from '../../src/modules/approval/approval.service.js';
import * as purchaseService from '../../src/modules/purchase/purchase.service.js';
import { cancelPendingApproval, findPendingApproval } from '../../src/shared/services/approvalSync.js';
import { ApprovalInstance } from '../../src/modules/approval/approvalInstance.model.js';
import { PurchaseRequisition } from '../../src/modules/purchase/purchaseRequisition.model.js';
import { ForbiddenError, ValidationError } from '../../src/shared/errors/AppError.js';

before(startDb);
after(stopDb);

async function submittedPr(ctx) {
  const m = await makeMaterial(ctx);
  const pr = await purchaseService.createPurchaseRequisition({
    factoryId: ctx.factoryId, organizationId: ctx.orgId, lines: [{ materialId: m._id, requiredQty: 5 }],
  }, ctx.userId);
  await purchaseService.submitPurchaseRequisition(pr._id, ctx.factoryId, ctx.userId);
  const inst = await findPendingApproval('PURCHASE_REQUISITION', pr._id);
  assert.ok(inst, 'submit opens a PENDING instance');
  return { pr, inst };
}
const prStatus = async (pr) => (await PurchaseRequisition.findById(pr._id)).status;

describe('multi-level workflow', () => {
  let ctx;
  before(async () => {
    ctx = await seedBase();
    await approvalService.createWorkflow({
      organizationId: ctx.orgId,
      factoryId: ctx.factoryId,
      documentType: 'PURCHASE_REQUISITION',
      name: 'PR two-level',
      levels: [{ approverRoles: ['purchase.authorize'] }, { approverRoles: ['approval.configure'] }],
    });
  });

  it('level 1 → level 2 → APPROVED; each level enforces its own roles', async () => {
    const { pr, inst } = await submittedPr(ctx);
    const opts = (permissions) => ({ factoryId: ctx.factoryId, permissions });

    await rejectsWith(
      approvalService.approveInstance(inst._id, ctx.approver._id, '', opts(['approval.configure'])),
      ForbiddenError,
    );
    const l2 = await approvalService.approveInstance(inst._id, ctx.approver._id, 'ok L1', opts(['purchase.authorize']));
    assert.equal(l2.status, 'PENDING');
    assert.equal(l2.currentLevel, 2);
    assert.equal(l2.steps.length, 1);
    assert.equal(await prStatus(pr), 'SUBMITTED', 'document untouched until the last level');

    await rejectsWith(
      approvalService.approveInstance(inst._id, ctx.approver2._id, '', opts(['purchase.authorize'])),
      ForbiddenError,
    );
    // the original submitter may act at level 2
    const done = await approvalService.approveInstance(inst._id, ctx.userId, 'ok L2', opts(['approval.configure']));
    assert.equal(done.status, 'APPROVED');
    assert.equal(done.steps.length, 2);
    assert.deepEqual(done.steps.map((s) => s.level), [1, 2]);
    assert.equal(await prStatus(pr), 'APPROVED');
    await rejectsConflict(approvalService.approveInstance(inst._id, ctx.approver._id, '', opts(['*'])), /not pending/);
  });

  it('a direct module approve cannot skip the remaining levels', async () => {
    const { syncApprovalApproved } = await import('../../src/shared/services/approvalSync.js');
    const fresh = await submittedPr(ctx);
    await rejectsConflict(syncApprovalApproved('PURCHASE_REQUISITION', fresh.pr._id, ctx.approver._id), /2-level approval/);
    assert.equal((await findPendingApproval('PURCHASE_REQUISITION', fresh.pr._id)).currentLevel, 1);
  });
});

describe('single-level approvals', () => {
  let ctx;
  before(async () => { ctx = await seedBase(); });
  const opts = () => ({ factoryId: ctx.factoryId, permissions: ['*'] });

  it('self-approval is blocked at level 1, even with full permissions', async () => {
    const { pr, inst } = await submittedPr(ctx);
    await rejectsWith(approvalService.approveInstance(inst._id, ctx.userId, '', opts()), ForbiddenError, /own request/);
    assert.equal((await ApprovalInstance.findById(inst._id)).status, 'PENDING');
    assert.equal(await prStatus(pr), 'SUBMITTED');
  });

  it('finalize rolls the instance back to PENDING when the document action throws', async () => {
    const { pr, inst } = await submittedPr(ctx);
    // document moved on behind the instance's back → bridge approve refuses
    await PurchaseRequisition.updateOne({ _id: pr._id }, { $set: { status: 'DRAFT' } });
    await rejectsConflict(approvalService.approveInstance(inst._id, ctx.approver._id, 'x', opts()), /SUBMITTED/);
    const back = await ApprovalInstance.findById(inst._id);
    assert.equal(back.status, 'PENDING');
    assert.equal(back.steps.length, 0, 'the pushed step is pulled again');
    assert.equal(back.completedAt, null);
    assert.equal(await prStatus(pr), 'DRAFT');

    await PurchaseRequisition.updateOne({ _id: pr._id }, { $set: { status: 'SUBMITTED' } });
    const ok = await approvalService.approveInstance(inst._id, ctx.approver._id, 'x', opts());
    assert.equal(ok.status, 'APPROVED');
    assert.equal(ok.steps.length, 1);
    assert.equal(await prStatus(pr), 'APPROVED');
  });

  it('reject needs comments and moves the document to REJECTED', async () => {
    const { pr, inst } = await submittedPr(ctx);
    await rejectsWith(approvalService.rejectInstance(inst._id, ctx.approver._id, '  ', opts()), ValidationError);
    const r = await approvalService.rejectInstance(inst._id, ctx.approver._id, 'too expensive', opts());
    assert.equal(r.status, 'REJECTED');
    assert.equal(await prStatus(pr), 'REJECTED');
    assert.equal((await PurchaseRequisition.findById(pr._id)).rejectionComments, 'too expensive');
  });

  it('request changes sends the PR back to DRAFT', async () => {
    const { pr, inst } = await submittedPr(ctx);
    const r = await approvalService.requestChangesInstance(inst._id, ctx.approver._id, 'split the line', opts());
    assert.equal(r.status, 'CHANGES_REQUESTED');
    assert.equal(await prStatus(pr), 'DRAFT');
  });

  it('cancelPendingApproval closes the pending instance once; later actions conflict', async () => {
    const { pr, inst } = await submittedPr(ctx);
    const c = await cancelPendingApproval('PURCHASE_REQUISITION', pr._id, ctx.userId, 'withdrawn');
    assert.equal(c.status, 'CANCELLED');
    assert.equal(c.steps.at(-1).action, 'CANCELLED');
    assert.equal(c.steps.at(-1).comments, 'withdrawn');
    assert.equal(await cancelPendingApproval('PURCHASE_REQUISITION', pr._id, ctx.userId), null);
    await rejectsConflict(approvalService.approveInstance(inst._id, ctx.approver._id, '', opts()), /not pending/);
  });

  it('a second submission while one is pending is refused', async () => {
    const { pr } = await submittedPr(ctx);
    await rejectsConflict(approvalService.submitForApproval({
      organizationId: ctx.orgId, factoryId: ctx.factoryId, documentType: 'PURCHASE_REQUISITION', documentId: pr._id, submittedBy: ctx.userId,
    }), /already pending/);
  });
});
