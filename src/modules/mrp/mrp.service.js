import { Bom } from '../bom/bom.model.js';
import { Material } from '../inventory/material.model.js';
import { MaterialRequirement } from './materialRequirement.model.js';
import * as inventoryService from '../inventory/inventory.service.js';

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
  const bom = await Bom.findById(bomId);
  if (!bom) throw new Error('BOM not found');

  const lines = [];
  let totalCost = 0;
  let hasShortage = false;

  for (const bomLine of bom.lines) {
    const material = await Material.findById(bomLine.materialId);
    const requiredQty = bomLine.effectiveQuantity * orderQuantity;
    const availableQty = await inventoryService.getAvailableQty(factoryId, bomLine.materialId);
    const shortageQty = Math.max(0, requiredQty - availableQty);
    if (shortageQty > 0) hasShortage = true;

    const extendedCost = requiredQty * (bomLine.unitCost || material?.unitCost || 0);
    totalCost += extendedCost;

    lines.push({
      materialId: bomLine.materialId,
      requiredQty,
      availableQty,
      shortageQty,
      unit: bomLine.unit || material?.unit,
      unitCost: bomLine.unitCost || material?.unitCost || 0,
      extendedCost,
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
