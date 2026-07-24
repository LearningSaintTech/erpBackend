import { InventoryBalance } from './inventoryBalance.model.js';

/** All RM balance rows for a material (unallocated + per-bin). */
export async function findRmBalances(factoryId, materialId) {
  return InventoryBalance.find({
    factoryId,
    materialId,
    inventoryType: 'RAW_MATERIAL',
    isDeleted: false,
  }).sort({ storageBinId: 1 });
}

export async function aggregateRmTotals(factoryId, materialId) {
  const balances = await findRmBalances(factoryId, materialId);
  return balances.reduce(
    (acc, b) => ({
      onHand: acc.onHand + (b.onHand || 0),
      reserved: acc.reserved + (b.reserved || 0),
      available: acc.available + (b.available || 0),
    }),
    { onHand: 0, reserved: 0, available: 0 },
  );
}

/**
 * Get or create an RM balance row.
 * storageBinId null = unallocated factory stock (receiving dock).
 */
export async function getOrCreateRmBalance(factoryId, organizationId, materialId, unit, storageBinId = null) {
  const binKey = storageBinId || null;
  let balance = await InventoryBalance.findOne({
    factoryId,
    materialId,
    inventoryType: 'RAW_MATERIAL',
    isDeleted: false,
    storageBinId: binKey,
  });
  if (!balance) {
    balance = await InventoryBalance.create({
      organizationId,
      factoryId,
      inventoryType: 'RAW_MATERIAL',
      materialId,
      storageBinId: binKey,
      locationId: binKey,
      unit,
      onHand: 0,
      reserved: 0,
      available: 0,
    });
  }
  return balance;
}

/** Copy legacy locationId → storageBinId for rows that predate per-bin balances. */
export async function migrateRmBalanceLocations() {
  const rows = await InventoryBalance.find({
    inventoryType: 'RAW_MATERIAL',
    isDeleted: false,
    locationId: { $ne: null },
    $or: [{ storageBinId: null }, { storageBinId: { $exists: false } }],
  });
  for (const row of rows) {
    row.storageBinId = row.locationId;
    await row.save();
  }
  return rows.length;
}

export async function ensureInventoryBalanceIndexes() {
  const coll = InventoryBalance.collection;
  try {
    const indexes = await coll.indexes();
    const legacy = indexes.find(
      (idx) => idx.key?.factoryId === 1
        && idx.key?.inventoryType === 1
        && idx.key?.materialId === 1
        && !idx.key?.storageBinId
        && !idx.partialFilterExpression?.storageBinId,
    );
    if (legacy?.name) {
      await coll.dropIndex(legacy.name);
    }
  } catch {
    // fresh DB or index already dropped
  }
  await InventoryBalance.syncIndexes();
}
