import { Material } from '../../modules/inventory/material.model.js';
import { loadSeedJson, seedLimit, isConditionsSeed, isHeavy, logAudit, safeSeed } from './seedHelpers.js';

export async function seedInventory(ctx) {
  const { org, factory, admin } = ctx;
  const inventoryService = await import('../../modules/inventory/inventory.service.js');

  if (!isConditionsSeed()) {
    const { seedInventoryCodesFromFile, seedSkuFormulaConfig } = await import('../../modules/inventoryCode/inventoryCode.service.js');
    const codeCount = await seedInventoryCodesFromFile();
    console.log(`Seeded ${codeCount} inventory codes`);
    await seedSkuFormulaConfig();
    console.log('Seeded SKU formula config');
  }

  const rows = loadSeedJson('materials.seed.json');
  const limit = seedLimit({ heavy: rows.length, conditions: 4, light: 2 });

  for (const row of rows.slice(0, limit)) {
    let material = await Material.findOne({ factoryId: factory._id, materialCode: row.materialCode });
    if (!material) {
      material = await Material.create({
        organizationId: org._id,
        factoryId: factory._id,
        materialCode: row.materialCode,
        name: row.name,
        category: row.category,
        unit: row.unit,
        unitCost: row.unitCost,
        status: 'ACTIVE',
        createdBy: admin._id,
        updatedBy: admin._id,
      });
      await inventoryService.receiptMaterial({
        factoryId: factory._id,
        organizationId: org._id,
        materialId: material._id,
        quantity: row.receiptQty,
        unit: row.unit,
        userId: admin._id,
      });
      console.log(`Seeded material ${row.materialCode} (${row.receiptQty} ${row.unit})`);
      await logAudit(ctx, {
        module: 'inventory',
        action: 'material.receipt',
        documentType: 'Material',
        documentId: material._id,
        updatedData: { materialCode: row.materialCode, quantity: row.receiptQty },
      });
    }
    ctx.materials.set(row.materialCode, material);
  }

  ctx.fabric = ctx.materials.get('FAB-COT-001');
  ctx.buttons = ctx.materials.get('BTN-001');
  return ctx;
}
