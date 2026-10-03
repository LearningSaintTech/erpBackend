import mongoose from 'mongoose';
import { env } from './env.js';
import { ensureDesignIndexes } from '../modules/design/design.model.js';
import {
  ensureInventoryBalanceIndexes,
  migrateRmBalanceLocations,
} from '../modules/inventory/inventoryStock.service.js';
import { ensurePurchaseProcess } from '../modules/purchase/purchase.process.migrate.js';

export async function connectDatabase() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(env.mongodbUri);
  await ensureDesignIndexes();
  await ensureInventoryBalanceIndexes();
  const migrated = await migrateRmBalanceLocations();
  if (migrated > 0) {
    console.log(`Migrated ${migrated} RM balance location(s) to storageBinId`);
  }
  const purchaseChanged = await ensurePurchaseProcess();
  if (purchaseChanged > 0) {
    console.log(`Aligned purchase process (${purchaseChanged} document(s))`);
  }
  console.log('MongoDB connected');
}
