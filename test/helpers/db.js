// env.js must be evaluated before anything under src/ (it pins MONGODB_URI etc. ahead of dotenv).
import './env.js';
// Load every module in the same order the API does, so the services' circular imports resolve
// exactly as in production (importing a single service first can hit TDZ errors in the cycle).
import '../../src/app.js';

import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import { Organization } from '../../src/modules/organization/organization.model.js';
import { FactorySettings } from '../../src/modules/organization/factorySettings.model.js';
import { createFactory } from '../../src/modules/organization/organization.service.js';
import { User } from '../../src/modules/user/user.model.js';
import { Role } from '../../src/modules/user/role.model.js';
import { UserRoleAssignment } from '../../src/modules/user/userRoleAssignment.model.js';
import { Material } from '../../src/modules/inventory/material.model.js';
import { InventoryBalance } from '../../src/modules/inventory/inventoryBalance.model.js';
import { StockReservation } from '../../src/modules/inventory/stockReservation.model.js';
import { Sku } from '../../src/modules/sku/sku.model.js';
import { Bom } from '../../src/modules/bom/bom.model.js';
import { Supplier } from '../../src/modules/purchase/supplier.model.js';
import * as warehouseService from '../../src/modules/warehouse/warehouse.service.js';
import * as productionService from '../../src/modules/production/production.service.js';
import * as purchaseService from '../../src/modules/purchase/purchase.service.js';
import { ConflictError, AppError } from '../../src/shared/errors/AppError.js';

let mongod = null;

/** How often each concurrency scenario is repeated (override with CONCURRENCY_ITERATIONS). */
export const ITERATIONS = Math.max(1, Number(process.env.CONCURRENCY_ITERATIONS) || 10);

/** One MongoMemoryServer per test file. Never touches MONGODB_URI / connectDatabase(). */
export async function startDb() {
  mongod = await MongoMemoryServer.create({ instance: { launchTimeout: 120000 } });
  const uri = mongod.getUri();
  assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:\d+\//, 'tests may only connect to the in-memory server');
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri);
  // Unique / partial indexes (e.g. one dock balance row per material) are part of the rules under test.
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
}

export async function stopDb() {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
  mongod = null;
}

let seq = 0;
/** Unique suffix for codes inside one test file (the DB is shared by the file's tests). */
export function uid(prefix = 'X') {
  seq += 1;
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

/**
 * Minimal tenant: org, factory (with short production stages), an admin, a second approver
 * and a QC user — all holding a full-permission role in the factory.
 */
export async function seedBase({ stages = ['CUTTING', 'STITCHING'] } = {}) {
  const superAdmin = await User.create({
    email: `super-${uid()}@test.local`, passwordHash: 'x', firstName: 'Super', lastName: 'Admin', isSuperAdmin: true, status: 'ACTIVE',
  });
  const org = await Organization.create({ code: uid('ORG'), name: 'Test Org', status: 'ACTIVE', createdBy: superAdmin._id });
  const factory = await createFactory(org._id, { code: uid('F'), name: 'Test Factory' }, superAdmin._id);
  await FactorySettings.updateOne({ factoryId: factory._id }, { $set: { productionStages: stages } });
  const role = await Role.create({
    organizationId: org._id, code: uid('ROLE'), name: 'All', permissions: ['*'], isSystem: true,
  });
  const mkUser = async (name) => {
    const user = await User.create({
      organizationId: org._id,
      email: `${name}-${uid()}@test.local`,
      passwordHash: 'x',
      firstName: name,
      lastName: 'Test',
      status: 'ACTIVE',
    });
    await UserRoleAssignment.create({
      organizationId: org._id, userId: user._id, roleId: role._id, factoryId: factory._id, assignedBy: superAdmin._id,
    });
    return user;
  };
  const admin = await mkUser('admin');
  const approver = await mkUser('approver');
  const approver2 = await mkUser('approver2');
  return {
    org,
    factory,
    superAdmin,
    admin,
    approver,
    approver2,
    orgId: org._id,
    factoryId: factory._id,
    userId: admin._id,
  };
}

export async function makeMaterial(ctx, {
  unit = 'METERS', unitCost = 0, reorderLevel = 0, category = 'FABRIC', name,
} = {}) {
  const code = uid('MAT');
  return Material.create({
    organizationId: ctx.orgId,
    factoryId: ctx.factoryId,
    materialCode: code,
    name: name || `Material ${code}`,
    category,
    unit,
    unitCost,
    reorderLevel,
    createdBy: ctx.userId,
  });
}

/** Warehouse of `type` with `count` active bins. */
export async function makeWarehouse(ctx, { type = 'RAW_MATERIAL', bins = 2 } = {}) {
  const wh = await warehouseService.createWarehouse({
    factoryId: ctx.factoryId,
    organizationId: ctx.orgId,
    warehouseCode: uid('WH'),
    name: `${type} store`,
    type,
    isDefault: true,
  }, ctx.userId);
  const binDocs = [];
  for (let i = 0; i < bins; i += 1) {
    binDocs.push(await warehouseService.createStorageBin({
      factoryId: ctx.factoryId,
      organizationId: ctx.orgId,
      warehouseId: wh._id,
      binCode: uid('B'),
    }, ctx.userId));
  }
  return { warehouse: wh, bins: binDocs };
}

export async function makeSupplier(ctx) {
  return Supplier.create({
    organizationId: ctx.orgId, factoryId: ctx.factoryId, supplierCode: uid('SUP'), name: `Supplier ${uid()}`, createdBy: ctx.userId,
  });
}

/** SKU + ACTIVE BOM. lines: [{ material, qty, wastagePercent?, unitCost? }] */
export async function makeSkuWithBom(ctx, lines) {
  const code = uid('SKU');
  const sku = await Sku.create({
    organizationId: ctx.orgId, factoryId: ctx.factoryId, skuCode: code, name: `Sku ${code}`, status: 'ACTIVE', createdBy: ctx.userId,
  });
  const bom = new Bom({
    organizationId: ctx.orgId,
    factoryId: ctx.factoryId,
    bomCode: `BOM-${code}`,
    skuId: sku._id,
    status: 'ACTIVE',
    lines: lines.map((l) => ({
      materialId: l.material._id,
      quantityPerPiece: l.qty,
      unit: l.material.unit,
      wastagePercent: l.wastagePercent || 0,
      unitCost: l.unitCost ?? l.material.unitCost ?? 0,
    })),
    createdBy: ctx.userId,
  });
  await bom.save();
  return { sku, bom };
}

/** CREATED → MRP → reserve → approval → APPROVED. */
export async function makeApprovedOrder(ctx, sku, plannedQuantity) {
  const order = await productionService.createProductionOrder({
    factoryId: ctx.factoryId, organizationId: ctx.orgId, skuId: sku._id, plannedQuantity,
  }, ctx.userId);
  await productionService.runProductionMrp(order._id, ctx.userId, ctx.factoryId);
  await productionService.reserveProductionMaterials(order._id, ctx.userId, ctx.factoryId);
  await productionService.submitProductionOrderForApproval(order._id, ctx.userId, ctx.factoryId);
  return productionService.approveProductionOrder(order._id, ctx.approver._id, { factoryId: ctx.factoryId });
}

/** Approved, sent PO for [{ material, qty, unitPrice }] (via an approved PR). */
export async function makeSentPo(ctx, lines) {
  const supplier = await makeSupplier(ctx);
  const po = await purchaseService.createPurchaseOrder({
    factoryId: ctx.factoryId,
    organizationId: ctx.orgId,
    supplierId: supplier._id,
    lines: lines.map((l) => ({ materialId: l.material._id, orderedQty: l.qty, unitPrice: l.unitPrice ?? 0 })),
  }, ctx.userId);
  return purchaseService.sendPurchaseOrder(po._id, ctx.factoryId, ctx.userId);
}

// ── stock read-outs ──

export async function rmRows(ctx, materialId) {
  return InventoryBalance.find({
    factoryId: ctx.factoryId, materialId, inventoryType: 'RAW_MATERIAL', isDeleted: false,
  }).sort({ storageBinId: 1 }).lean();
}

export async function rmTotals(ctx, materialId) {
  const rows = await rmRows(ctx, materialId);
  return rows.reduce((a, r) => ({
    onHand: a.onHand + (r.onHand || 0),
    reserved: a.reserved + (r.reserved || 0),
    available: a.available + (r.available || 0),
  }), { onHand: 0, reserved: 0, available: 0 });
}

export async function activeReservedQty(ctx, materialId, filter = {}) {
  const rows = await StockReservation.find({
    factoryId: ctx.factoryId, materialId, status: 'ACTIVE', isDeleted: false, ...filter,
  }).lean();
  return rows.reduce((s, r) => s + (r.quantity || 0), 0);
}

/** Row-level stock invariants that must hold after any sequence of operations. */
export async function assertStockInvariants(ctx, materialId) {
  const rows = await rmRows(ctx, materialId);
  for (const r of rows) {
    assert.ok(r.onHand >= -1e-9, `onHand negative on row ${r._id}: ${r.onHand}`);
    assert.ok(r.reserved >= -1e-9, `reserved negative on row ${r._id}: ${r.reserved}`);
    assert.ok(r.reserved <= r.onHand + 1e-9, `reserved ${r.reserved} exceeds onHand ${r.onHand} on row ${r._id}`);
    assert.ok(Math.abs(r.available - (r.onHand - r.reserved)) < 1e-9, `available out of sync on row ${r._id}`);
  }
  const totals = await rmTotals(ctx, materialId);
  const held = await activeReservedQty(ctx, materialId);
  assert.ok(
    Math.abs(totals.reserved - held) < 1e-9,
    `balance.reserved total (${totals.reserved}) != Σ ACTIVE reservations (${held})`,
  );
  return totals;
}

export function isConflict(err) {
  return err instanceof ConflictError || err?.statusCode === 409 || err?.name === 'VersionError';
}

/** assert.rejects with ConflictError (409). */
export async function rejectsConflict(promise, msg) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof ConflictError, `expected ConflictError, got ${err?.name}: ${err?.message}`);
    if (msg) assert.match(err.message, msg);
    return true;
  });
}

export async function rejectsWith(promise, ErrorClass, msg) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof ErrorClass, `expected ${ErrorClass.name}, got ${err?.name}: ${err?.message}`);
    if (msg) assert.match(err.message, msg);
    return true;
  });
}

/** Promise.allSettled split into fulfilled values / rejection reasons. */
export async function settle(promises) {
  const results = await Promise.allSettled(promises);
  return {
    ok: results.filter((r) => r.status === 'fulfilled').map((r) => r.value),
    failed: results.filter((r) => r.status === 'rejected').map((r) => r.reason),
  };
}

export { mongoose, AppError };
