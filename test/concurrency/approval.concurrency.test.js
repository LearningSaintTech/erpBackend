import {
  startDb, stopDb, seedBase, makeMaterial, settle, isConflict, ITERATIONS,
} from '../helpers/db.js';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import * as approvalService from '../../src/modules/approval/approval.service.js';
import * as purchaseService from '../../src/modules/purchase/purchase.service.js';
import { findPendingApproval } from '../../src/shared/services/approvalSync.js';
import { ApprovalInstance } from '../../src/modules/approval/approvalInstance.model.js';
import { PurchaseRequisition } from '../../src/modules/purchase/purchaseRequisition.model.js';
import { Notification } from '../../src/modules/notification/notification.model.js';

before(startDb);
after(stopDb);

async function submittedPr(ctx) {
  const m = await makeMaterial(ctx);
  const pr = await purchaseService.createPurchaseRequisition({
    factoryId: ctx.factoryId, organizationId: ctx.orgId, lines: [{ materialId: m._id, requiredQty: 1 }],
  }, ctx.userId);
  await purchaseService.submitPurchaseRequisition(pr._id, ctx.factoryId, ctx.userId);
  return { pr, inst: await findPendingApproval('PURCHASE_REQUISITION', pr._id) };
}

describe('parallel approvals of one instance', () => {
  let ctx;
  before(async () => { ctx = await seedBase(); });
  const opts = () => ({ factoryId: ctx.factoryId, permissions: ['*'] });

  it(`two approvers at once → exactly one wins, document approved once (×${ITERATIONS})`, async () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const { pr, inst } = await submittedPr(ctx);
      const { ok, failed } = await settle([
        approvalService.approveInstance(inst._id, ctx.approver._id, 'a', opts()),
        approvalService.approveInstance(inst._id, ctx.approver2._id, 'b', opts()),
      ]);
      assert.equal(ok.length, 1, `iteration ${i}: exactly one approval succeeds`);
      assert.equal(failed.length, 1);
      assert.ok(isConflict(failed[0]), `iteration ${i}: loser gets a conflict, got ${failed[0]?.message}`);
      const fresh = await ApprovalInstance.findById(inst._id);
      assert.equal(fresh.status, 'APPROVED');
      assert.equal(fresh.steps.length, 1, 'one approval step recorded');
      assert.equal((await PurchaseRequisition.findById(pr._id)).status, 'APPROVED');
      assert.equal(await Notification.countDocuments({ referenceId: pr._id, eventType: 'pr.approved' }), 1, 'approved once');
    }
  });

  it(`approve vs reject at once → one outcome only (×${ITERATIONS})`, async () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const { pr, inst } = await submittedPr(ctx);
      const { ok, failed } = await settle([
        approvalService.approveInstance(inst._id, ctx.approver._id, 'a', opts()),
        approvalService.rejectInstance(inst._id, ctx.approver2._id, 'no', opts()),
      ]);
      assert.equal(ok.length, 1);
      assert.ok(isConflict(failed[0]), failed[0]?.message);
      const fresh = await ApprovalInstance.findById(inst._id);
      const prStatus = (await PurchaseRequisition.findById(pr._id)).status;
      assert.equal(fresh.steps.length, 1);
      assert.equal(prStatus, fresh.status === 'APPROVED' ? 'APPROVED' : 'REJECTED', 'document matches the winning action');
    }
  });
});

describe('parallel approvals at a workflow level', () => {
  let ctx;
  before(async () => {
    ctx = await seedBase();
    await approvalService.createWorkflow({
      organizationId: ctx.orgId, factoryId: ctx.factoryId, documentType: 'PURCHASE_REQUISITION', name: 'two-level',
      levels: [{ approverRoles: ['purchase.authorize'] }, { approverRoles: ['purchase.authorize'] }],
    });
  });

  it(`two level-1 approvals at once advance the level once (×${ITERATIONS})`, async () => {
    const opts = { factoryId: ctx.factoryId, permissions: ['purchase.authorize'] };
    for (let i = 0; i < ITERATIONS; i += 1) {
      const { pr, inst } = await submittedPr(ctx);
      const { ok, failed } = await settle([
        approvalService.approveInstance(inst._id, ctx.approver._id, 'a', opts),
        approvalService.approveInstance(inst._id, ctx.approver2._id, 'b', opts),
      ]);
      for (const err of failed) assert.ok(isConflict(err), err?.message);
      const fresh = await ApprovalInstance.findById(inst._id);
      // The API carries no "expected level": a request that reads the instance after the other
      // one advanced it legitimately acts on level 2. What must never happen is a level being
      // approved twice or skipped.
      const levels = fresh.steps.map((s) => s.level);
      assert.deepEqual(levels, levels.map((_, idx) => idx + 1), `levels strictly sequential, got ${levels}`);
      assert.equal(fresh.steps.length, ok.length, 'one step per successful call');
      const prStatus = (await PurchaseRequisition.findById(pr._id)).status;
      if (ok.length === 1) {
        assert.equal(fresh.status, 'PENDING');
        assert.equal(fresh.currentLevel, 2, 'level advanced exactly once');
        assert.equal(prStatus, 'SUBMITTED');
      } else {
        assert.equal(fresh.status, 'APPROVED');
        assert.equal(prStatus, 'APPROVED');
      }
    }
  });
});
