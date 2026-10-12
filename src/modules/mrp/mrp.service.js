import { NotFoundError } from '../../shared/errors/AppError.js';
import { Bom } from '../bom/bom.model.js';
import { Material } from '../inventory/material.model.js';
import { MaterialRequirement } from './materialRequirement.model.js';
import * as inventoryService from '../inventory/inventory.service.js';
import { computeOnOrderByMaterial } from '../purchase/purchase.onOrder.js';

export async function calculateMrpPreview({ bomId, skuId, factoryId, organizationId, orderQuantity = 1, userId }) {
  return calculateMrp({
    bomId,
    skuId,
    factoryId,
    organizationId,
    orderQuantity,
    userId,
    referenceType: 'BOM_PREVIEW',
    referenceId: bomId,
  });
}

export async function calculateMrp({
  bomId,
  skuId,
  factoryId,
  organizationId,
  orderQuantity = 1,
  userId,
  referenceType = 'BOM_PREVIEW',
  referenceId,
}) {
  const bom = await Bom.findOne(factoryId ? { _id: bomId, factoryId } : { _id: bomId });
  if (!bom) throw new NotFoundError('BOM not found');

  const lines = [];
  let totalCost = 0;
  let hasShortage = false;

  // The same material can appear on several BOM lines — sum demand per material before
  // comparing to stock, otherwise each line is checked against the full available qty.
  const byMaterial = new Map();
  for (const bomLine of bom.lines) {
    const key = bomLine.materialId?.toString();
    if (!key) continue;
    const material = await Material.findById(bomLine.materialId);
    const requiredQty = bomLine.effectiveQuantity * orderQuantity;
    const unitCost = bomLine.unitCost || material?.unitCost || 0;
    const cur = byMaterial.get(key) || {
      materialId: bomLine.materialId,
      requiredQty: 0,
      extendedCost: 0,
      // Stock and purchasing are in the material master unit (BOM may carry pattern spellings like M / PC)
      unit: material?.unit || bomLine.unit,
    };
    cur.requiredQty += requiredQty;
    cur.extendedCost += requiredQty * unitCost;
    byMaterial.set(key, cur);
  }

  const onOrder = byMaterial.size
    ? await computeOnOrderByMaterial(factoryId || bom.factoryId, {
      materialIds: [...byMaterial.values()].map((r) => r.materialId),
    })
    : new Map();

  // Quantities are sums of float products (1.12 m × 1.5 wastage …) — keep 3 decimals so
  // 1.68 never becomes 1.6800000000000002 in reservations, PRs and screens.
  const q3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
  for (const row of byMaterial.values()) {
    row.requiredQty = q3(row.requiredQty);
    row.extendedCost = Math.round(row.extendedCost * 100) / 100;
    const availableQty = q3(await inventoryService.getAvailableQty(factoryId, row.materialId));
    const shortageQty = q3(Math.max(0, row.requiredQty - availableQty));
    const onOrderQty = q3(onOrder.get(row.materialId.toString()) || 0);
    const netShortageQty = q3(Math.max(0, row.requiredQty - availableQty - onOrderQty));
    if (shortageQty > 0) hasShortage = true;
    totalCost += row.extendedCost;

    lines.push({
      materialId: row.materialId,
      requiredQty: row.requiredQty,
      availableQty,
      shortageQty,
      onOrderQty,
      netShortageQty,
      unit: row.unit,
      unitCost: row.requiredQty ? row.extendedCost / row.requiredQty : 0,
      extendedCost: row.extendedCost,
    });
  }

  const mrp = await MaterialRequirement.create({
    organizationId,
    factoryId,
    referenceType,
    referenceId: referenceId || bomId,
    skuId,
    bomId,
    orderQuantity,
    lines,
    totalCost,
    hasShortage,
    createdBy: userId,
  });

  return mrp;
}

export async function getMrpForBom(bomId) {
  return MaterialRequirement.findOne({ referenceId: bomId, referenceType: 'BOM_PREVIEW' }).sort({ createdAt: -1 });
}

export async function getMrpForReference(referenceId, referenceType) {
  return MaterialRequirement.findOne({ referenceId, referenceType }).sort({ createdAt: -1 });
}
