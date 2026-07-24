import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { User } from '../../modules/user/user.model.js';
import { AuditLog } from '../../modules/audit/audit.model.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '../../data');

export const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export const MATRIX_SIZE_LABELS = ['XS', 'S', 'M', 'L', 'XL'];

export const MATRIX_ROWS = [
  { measurementName: 'Chest', values: new Map([['XS', 34], ['S', 36], ['M', 38], ['L', 40], ['XL', 42]]) },
  { measurementName: 'Waist', values: new Map([['XS', 28], ['S', 30], ['M', 32], ['L', 34], ['XL', 36]]) },
  { measurementName: 'Hip', values: new Map([['XS', 36], ['S', 38], ['M', 40], ['L', 42], ['XL', 44]]) },
  { measurementName: 'Shoulder', values: new Map([['XS', 15], ['S', 16], ['M', 17], ['L', 18], ['XL', 19]]) },
  { measurementName: 'Sleeve', values: new Map([['XS', 23], ['S', 24], ['M', 25], ['L', 26], ['XL', 27]]) },
  { measurementName: 'Length', values: new Map([['XS', 27], ['S', 28], ['M', 29], ['L', 30], ['XL', 31]]) },
];

const QC_GATED_STAGES = new Set(['CUTTING', 'STITCHING', 'FINISHING', 'PACKING', 'SEWING']);

/** Default seed: RBAC + inventory codes + modal/workflow fixtures. Use SEED_PROFILE=rbac|heavy|light. */
export function getSeedProfile() {
  return process.env.SEED_PROFILE || 'conditions';
}

export function isRbacOnly() {
  return getSeedProfile() === 'rbac';
}

export function isConditionsSeed() {
  return getSeedProfile() === 'conditions';
}

export function isHeavy() {
  return getSeedProfile() === 'heavy';
}

export function isLightSeed() {
  return getSeedProfile() === 'light';
}

export function isDemoSeed() {
  const profile = getSeedProfile();
  return profile === 'heavy' || profile === 'light';
}

export function isFixtureSeed() {
  return isConditionsSeed() || isDemoSeed();
}

/** Pick array/count limits by active seed profile. */
export function seedLimit({ heavy, conditions, light = 1 }) {
  if (isHeavy()) return heavy;
  if (isConditionsSeed()) return conditions;
  return light;
}

export function loadSeedJson(filename) {
  const seedPath = join(DATA_DIR, filename);
  return JSON.parse(readFileSync(seedPath, 'utf8'));
}

export async function ensureOne(Model, filter, createFn) {
  let doc = await Model.findOne(filter);
  if (!doc) {
    doc = await createFn();
  }
  return doc;
}

export async function userByEmail(email) {
  return User.findOne({ email });
}

export async function buildRoleUsers() {
  const emails = {
    admin: 'admin@demo.local',
    designer: 'designer@demo.local',
    designManager: 'design-manager@demo.local',
    pattern: 'pattern@demo.local',
    sampling: 'sampling@demo.local',
    planner: 'planner@demo.local',
    qc: 'qc@demo.local',
    purchase: 'purchase@demo.local',
    warehouse: 'warehouse@demo.local',
    store: 'storekeeper@demo.local',
    productionManager: 'production-manager@demo.local',
    worker: 'operator@demo.local',
  };
  const users = {};
  for (const [key, email] of Object.entries(emails)) {
    users[key] = await User.findOne({ email });
  }
  return users;
}

export async function advanceBatchToCompletion(batchId, userId, factoryId) {
  const productionService = await import('../../modules/production/production.service.js');
  const qualityExt = await import('../../modules/quality/qualityExtended.service.js');
  const qualityService = await import('../../modules/quality/quality.service.js');

  let batch = await productionService.getBatch(batchId, factoryId);
  let guard = 0;
  while (batch.status === 'IN_PROGRESS' && batch.currentStage !== 'COMPLETED' && guard < 20) {
    guard += 1;
    if (QC_GATED_STAGES.has(batch.currentStage)) {
      const inQc = await qualityExt.createInProcessInspection(batch._id, userId);
      await qualityService.completeInspection(inQc._id, {
        passedQuantity: batch.plannedQuantity,
        failedQuantity: 0,
        result: 'PASS',
      }, userId, factoryId);
    }
    batch = await productionService.completeBatchStage(batch._id, userId, {}, factoryId);
  }
  if (batch.status !== 'COMPLETED') {
    throw new Error(`Batch ${batchId} did not complete (status=${batch.status}, stage=${batch.currentStage})`);
  }
  return batch;
}

export async function logAudit(ctx, {
  module, action, documentType, documentId, previousData, updatedData, metadata,
}) {
  if (!ctx.auditCount) ctx.auditCount = 0;
  const target = isHeavy() ? 50 : 10;
  if (ctx.auditCount >= target) return;

  const user = ctx.admin;
  await AuditLog.create({
    organizationId: ctx.org._id,
    factoryId: ctx.factory._id,
    userId: user?._id,
    userEmail: user?.email,
    module,
    action,
    documentType,
    documentId,
    previousData,
    updatedData,
    metadata,
    timestamp: new Date(Date.now() - (ctx.auditCount * 60000)),
  });
  ctx.auditCount += 1;
}

export function matrixSizeChartData() {
  return {
    unit: 'INCHES',
    sizeLabels: MATRIX_SIZE_LABELS,
    rows: MATRIX_ROWS.map((r) => ({
      measurementName: r.measurementName,
      values: Object.fromEntries(r.values),
    })),
  };
}

export function colorVariantsWithSizes(colors) {
  return colors.map((c) => ({
    ...c,
    sizes: MATRIX_SIZE_LABELS.map((size) => ({ size, quantity: 0 })),
  }));
}

export async function safeSeed(label, fn) {
  try {
    return await fn();
  } catch (err) {
    console.warn(`Seed warning [${label}]: ${err.message}`);
    return null;
  }
}
