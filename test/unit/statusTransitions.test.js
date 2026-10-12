import {
  startDb, stopDb, seedBase, uid, rejectsConflict,
} from '../helpers/db.js';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import * as designService from '../../src/modules/design/design.service.js';
import * as sampleService from '../../src/modules/sampling/sample.service.js';
import { Design } from '../../src/modules/design/design.model.js';
import { Sample } from '../../src/modules/sampling/sample.model.js';

let ctx;
before(async () => {
  await startDb();
  ctx = await seedBase();
});
after(stopDb);

async function design(status) {
  return Design.create({
    organizationId: ctx.orgId, factoryId: ctx.factoryId, designCode: uid('DSN'), title: 'T', status, createdBy: ctx.userId,
  });
}
async function sample(status) {
  const d = await design('RELEASED');
  return Sample.create({
    organizationId: ctx.orgId, factoryId: ctx.factoryId, sampleCode: uid('SMP'), designId: d._id, status, createdBy: ctx.userId,
  });
}

describe('design transitions', () => {
  it('approve / reject / revise only from review; release only from APPROVED; submit only from DRAFT/REVISION', async () => {
    const opts = { factoryId: ctx.factoryId };
    for (const status of ['DRAFT', 'APPROVED', 'RELEASED', 'REJECTED']) {
      const d = await design(status);
      await rejectsConflict(designService.approveDesign(d._id, ctx.approver._id, opts), /not in review/);
      await rejectsConflict(designService.rejectDesign(d._id, ctx.approver._id, 'x', opts), /not in review/);
      await rejectsConflict(designService.requestRevision(d._id, ctx.approver._id, 'x', opts), /not in review/);
      assert.equal((await Design.findById(d._id)).status, status);
    }
    for (const status of ['DRAFT', 'IN_REVIEW', 'RELEASED']) {
      const d = await design(status);
      await rejectsConflict(designService.releaseDesign(d._id, ctx.userId, opts), /Only APPROVED/);
    }
    for (const status of ['IN_REVIEW', 'APPROVED', 'RELEASED']) {
      const d = await design(status);
      await rejectsConflict(
        designService.submitDesign(d._id, ctx.userId, { factoryId: ctx.factoryId, permissions: ['*'], viewer: { _id: ctx.userId, isSuperAdmin: true } }),
        /Invalid status/,
      );
    }
  });
});

describe('sample transitions', () => {
  it('reserve / issue / approve / cancel guard their source states', async () => {
    const created = await sample('CREATED');
    await rejectsConflict(sampleService.reserveMaterials(created._id, ctx.factoryId, ctx.userId), /approved before reserve/);
    await rejectsConflict(sampleService.issueMaterials(created._id, ctx.factoryId, ctx.userId), /reserved before issue/);
    await rejectsConflict(sampleService.approveSample(created._id, ctx.factoryId, ctx.approver._id), /pending approval/);
    await rejectsConflict(sampleService.rejectSample(created._id, ctx.factoryId, ctx.approver._id, 'no'), /not pending approval/);

    for (const status of ['APPROVED', 'REJECTED', 'COMPLETED']) {
      const s = await sample(status);
      await rejectsConflict(sampleService.cancelSample(s._id, ctx.factoryId, ctx.userId, 'x'), /already/);
      assert.equal((await Sample.findById(s._id)).status, status);
    }
  });
});
