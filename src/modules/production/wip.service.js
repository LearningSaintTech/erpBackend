import { ProductionBatch } from './productionBatch.model.js';
import { ProductionOrder } from './productionOrder.model.js';
import { InventoryBalance } from '../inventory/inventoryBalance.model.js';
import { InventoryTransaction } from '../inventory/inventoryTransaction.model.js';

/**
 * Per-SKU WIP balance, derived from the batches themselves.
 *
 * WIP for a SKU = Σ (plannedQuantity − rejectedQuantity) over its IN_PROGRESS / REWORK batches.
 * The balance is recomputed from that source of truth after every batch transition (start, stage
 * advance, in-process reject, completion, close), so concurrent batches of the same SKU can no longer
 * overwrite each other (the old recordWip set onHand = "this batch's qty"). Recomputing is idempotent
 * and self-healing: a missed update is corrected by the next one. A TRANSFER ledger row carries the
 * delta, referenced to the batch that caused it.
 */
export async function computeSkuWip(factoryId, skuId) {
  const orderIds = await ProductionOrder.find({ factoryId, skuId, isDeleted: false }).distinct('_id');
  if (!orderIds.length) return 0;
  const batches = await ProductionBatch.find({
    factoryId,
    productionOrderId: { $in: orderIds },
    status: { $in: ['IN_PROGRESS', 'REWORK'] },
    isDeleted: false,
  }).select('plannedQuantity rejectedQuantity');
  return batches.reduce(
    (sum, b) => sum + Math.max(0, (b.plannedQuantity || 0) - (b.rejectedQuantity || 0)),
    0,
  );
}

export async function syncWipForSku({ factoryId, organizationId, skuId, batchId, userId }) {
  if (!skuId) return null;
  const qty = await computeSkuWip(factoryId, skuId);
  const filter = { factoryId, skuId, inventoryType: 'WIP', isDeleted: false };
  const before = await InventoryBalance.findOne(filter).select('onHand');
  const prev = before?.onHand || 0;

  const balance = await InventoryBalance.findOneAndUpdate(
    filter,
    {
      $set: { onHand: qty, available: qty, reserved: 0, updatedBy: userId, updatedAt: new Date() },
      $setOnInsert: { organizationId, unit: 'PIECES', createdBy: userId },
    },
    { new: true, upsert: true },
  );

  const delta = qty - prev;
  if (delta !== 0) {
    await InventoryTransaction.create({
      organizationId,
      factoryId,
      type: 'TRANSFER',
      skuId,
      quantity: Math.abs(delta),
      direction: delta > 0 ? 'IN' : 'OUT',
      unit: 'PIECES',
      referenceType: 'WIP_BATCH',
      referenceId: batchId,
      performedBy: userId,
      createdBy: userId,
    });
  }
  return balance;
}

/** Convenience: resync WIP for the SKU of a batch's production order (best-effort). */
export async function syncWipForBatch(batch, userId) {
  try {
    const orderId = batch.productionOrderId?._id || batch.productionOrderId;
    const order = await ProductionOrder.findOne({ _id: orderId, factoryId: batch.factoryId }).select('skuId organizationId');
    if (!order) return null;
    return await syncWipForSku({
      factoryId: batch.factoryId,
      organizationId: order.organizationId,
      skuId: order.skuId,
      batchId: batch._id,
      userId,
    });
  } catch (err) {
    // WIP is a derived view — never fail a production transition because of it.
    console.warn('[wip] sync failed:', err?.message || err);
    return null;
  }
}
