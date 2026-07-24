import { connectDatabase } from '../config/database.js';
import { Factory } from '../modules/organization/factory.model.js';
import mongoose from 'mongoose';
import { printSeedWalkthrough } from './seedWalkthrough.js';

async function main() {
  await connectDatabase();
  const factory = await Factory.findOne({ code: 'F01' });
  if (!factory) {
    console.error('No factory F01 found. Run npm run seed first.');
    process.exit(1);
  }
  await printSeedWalkthrough(factory._id);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
