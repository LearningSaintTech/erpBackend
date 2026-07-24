import { seedCore, printRbacSeedSummary } from './seedCore.js';
import { seedInventory } from './seedInventory.js';
import { seedDesigns } from './seedDesigns.js';
import { seedProduction } from './seedProduction.js';
import { seedPurchase } from './seedPurchase.js';
import { seedWarehouse } from './seedWarehouse.js';
import { seedQuality } from './seedQuality.js';
import { seedCollaboration } from './seedCollaboration.js';
import { seedPlatform } from './seedPlatform.js';
import { seedModalConditions, printConditionsSummary } from './seedConditions.js';
import { getSeedProfile, isRbacOnly, isConditionsSeed, isDemoSeed } from './seedHelpers.js';

async function runPhase(name, fn, ctx) {
  const start = Date.now();
  await fn(ctx);
  console.log(`[${name}] done in ${Date.now() - start}ms`);
}

export async function runSeed() {
  const profile = getSeedProfile();
  console.log(`\n=== Seed profile: ${profile} ===\n`);

  const ctx = await seedCore();

  if (isRbacOnly()) {
    printRbacSeedSummary(ctx);
    console.log('RBAC seed complete');
    return ctx;
  }

  await runPhase('inventory', seedInventory, ctx);
  await runPhase('designs', seedDesigns, ctx);
  await runPhase('production', seedProduction, ctx);
  await runPhase('purchase', seedPurchase, ctx);
  await runPhase('warehouse', seedWarehouse, ctx);
  await runPhase('quality', seedQuality, ctx);
  await runPhase('collaboration', seedCollaboration, ctx);
  await runPhase('platform', seedPlatform, ctx);

  if (isConditionsSeed()) {
    await runPhase('conditions', seedModalConditions, ctx);
    await printConditionsSummary(ctx);
    console.log('Conditions seed complete');
    return ctx;
  }

  const { printSeedWalkthrough } = await import('../seedWalkthrough.js');
  await printSeedWalkthrough(ctx.factory._id);
  console.log('Demo seed complete');
  return ctx;
}
