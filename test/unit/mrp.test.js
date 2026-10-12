import {
  startDb, stopDb, seedBase, makeMaterial, makeSkuWithBom, makeSentPo, mongoose,
} from '../helpers/db.js';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import * as mrpService from '../../src/modules/mrp/mrp.service.js';
import * as inventoryService from '../../src/modules/inventory/inventory.service.js';
import * as purchaseService from '../../src/modules/purchase/purchase.service.js';

let ctx;
before(async () => {
  await startDb();
  ctx = await seedBase();
});
after(stopDb);

const close = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 1e-9, `${msg}: ${actual} != ${expected}`);

describe('MRP', () => {
  it('groups demand per material across BOM lines; shortage vs available; onOrder and net shortage', async () => {
    const fabric = await makeMaterial(ctx, { unitCost: 50 });
    const thread = await makeMaterial(ctx, { unit: 'CONES', unitCost: 3, category: 'THREAD' });
    // fabric twice: 2 m and 1 m + 10 % → 3.1 m / piece
    const { sku, bom } = await makeSkuWithBom(ctx, [
      { material: fabric, qty: 2, unitCost: 50 },
      { material: fabric, qty: 1, wastagePercent: 10, unitCost: 60 },
      { material: thread, qty: 0.5, unitCost: 3 },
    ]);
    const rec = (m, q) => inventoryService.receiptMaterial({
      factoryId: ctx.factoryId, organizationId: ctx.orgId, materialId: m._id, quantity: q, userId: ctx.userId,
    });
    await rec(fabric, 20);
    await rec(thread, 100);
    // someone else holds 5 m → available 15
    await inventoryService.reserveMaterial({
      factoryId: ctx.factoryId, organizationId: ctx.orgId, materialId: fabric._id, quantity: 5, unit: 'METERS',
      referenceType: 'MANUAL', referenceId: new mongoose.Types.ObjectId(), userId: ctx.userId,
    });
    // on order: open PR 4 + PO (10 ordered, 3 on a DRAFT GRN → 7 open) + that GRN 3 = 14
    await purchaseService.createPurchaseRequisition({
      factoryId: ctx.factoryId, organizationId: ctx.orgId, lines: [{ materialId: fabric._id, requiredQty: 4 }],
    }, ctx.userId);
    const po = await makeSentPo(ctx, [{ material: fabric, qty: 10, unitPrice: 50 }]);
    await purchaseService.createGoodsReceipt({
      factoryId: ctx.factoryId, organizationId: ctx.orgId, poId: po._id, lines: [{ materialId: fabric._id, receivedQty: 3 }],
    }, ctx.userId);

    const mrp = await mrpService.calculateMrp({
      bomId: bom._id, skuId: sku._id, factoryId: ctx.factoryId, organizationId: ctx.orgId,
      orderQuantity: 10, userId: ctx.userId, referenceType: 'PRODUCTION_ORDER', referenceId: new mongoose.Types.ObjectId(),
    });
    assert.equal(mrp.lines.length, 2, 'one line per material');
    const f = mrp.lines.find((l) => String(l.materialId) === String(fabric._id));
    const t = mrp.lines.find((l) => String(l.materialId) === String(thread._id));

    close(f.requiredQty, 31, 'fabric required');
    assert.equal(f.availableQty, 15);
    close(f.shortageQty, 16, 'fabric shortage');
    assert.equal(f.onOrderQty, 14);
    close(f.netShortageQty, 2, 'fabric net shortage');
    close(f.extendedCost, 20 * 50 + 11 * 60, 'fabric cost');
    close(f.unitCost, (20 * 50 + 11 * 60) / 31, 'weighted unit cost');
    assert.equal(f.unit, 'METERS');

    close(t.requiredQty, 5, 'thread required');
    assert.equal(t.shortageQty, 0);
    assert.equal(t.netShortageQty, 0);
    assert.equal(t.unit, 'CONES');

    assert.equal(mrp.hasShortage, true);
    close(mrp.totalCost, 1660 + 15, 'total');
  });

  it('net shortage never goes below zero and no shortage when stock covers demand', async () => {
    const m = await makeMaterial(ctx, { unitCost: 1 });
    const { sku, bom } = await makeSkuWithBom(ctx, [{ material: m, qty: 1 }]);
    await inventoryService.receiptMaterial({
      factoryId: ctx.factoryId, organizationId: ctx.orgId, materialId: m._id, quantity: 4, userId: ctx.userId,
    });
    await purchaseService.createPurchaseRequisition({
      factoryId: ctx.factoryId, organizationId: ctx.orgId, lines: [{ materialId: m._id, requiredQty: 100 }],
    }, ctx.userId);
    const run = (orderQuantity) => mrpService.calculateMrp({
      bomId: bom._id, skuId: sku._id, factoryId: ctx.factoryId, organizationId: ctx.orgId, orderQuantity, userId: ctx.userId,
    });
    const short = await run(10);
    assert.equal(short.lines[0].shortageQty, 6);
    assert.equal(short.lines[0].netShortageQty, 0);
    assert.equal(short.hasShortage, true, 'physical shortage still gates production');
    const ok = await run(4);
    assert.equal(ok.lines[0].shortageQty, 0);
    assert.equal(ok.hasShortage, false);
  });
});
