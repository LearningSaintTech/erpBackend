import mongoose from 'mongoose';
import { env } from './env.js';
import { ensureDesignIndexes } from '../modules/design/design.model.js';
import {
  ensureInventoryBalanceIndexes,
  migrateRmBalanceLocations,
} from '../modules/inventory/inventoryStock.service.js';

export async function connectDatabase() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(env.mongodbUri);
  await ensureDesignIndexes();
  await ensureInventoryBalanceIndexes();
  const migrated = await migrateRmBalanceLocations();
  if (migrated > 0) {
    console.log(`Migrated ${migrated} RM balance location(s) to storageBinId`);
  }
  console.log('MongoDB connected');
}
