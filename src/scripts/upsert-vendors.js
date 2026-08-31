/**
 * Upsert the vendor master from suppliers.seed.json into the DEMO / F01 factory.
 * Usage: node src/scripts/upsert-vendors.js
 */
import mongoose from 'mongoose';
import { connectDatabase } from '../config/database.js';
import { Organization } from '../modules/organization/organization.model.js';
import { Factory } from '../modules/organization/factory.model.js';
import { User } from '../modules/user/user.model.js';
import { loadSeedJson } from './seed/seedHelpers.js';
import * as purchaseService from '../modules/purchase/purchase.service.js';
import { Supplier } from '../modules/purchase/supplier.model.js';

async function main() {
  await connectDatabase();

  const org = await Organization.findOne({ code: 'DEMO' });
  if (!org) throw new Error('Organization DEMO not found — run seed first');
  const factory = await Factory.findOne({ organizationId: org._id, code: 'F01' });
  if (!factory) throw new Error('Factory F01 not found — run seed first');
  const admin = await User.findOne({ email: 'admin@demo.local' })
    || await User.findOne({ organizationId: org._id });
  if (!admin) throw new Error('No admin user found');

  const rows = loadSeedJson('suppliers.seed.json');
  let created = 0;
  let updated = 0;

  for (const row of rows) {
    const existing = await Supplier.findOne({ factoryId: factory._id, supplierCode: row.supplierCode });
    if (!existing) {
      await purchaseService.createSupplier({
        organizationId: org._id,
        factoryId: factory._id,
        ...row,
      }, admin._id);
      created += 1;
      console.log(`Created ${row.supplierCode} — ${row.name}`);
    } else {
      await purchaseService.updateSupplier(existing._id, factory._id, {
        name: row.name,
        contactPerson: row.contactPerson ?? '',
        contactEmail: row.contactEmail ?? '',
        phone: row.phone ?? '',
        gstNumber: row.gstNumber ?? '',
        materialsSupplied: row.materialsSupplied ?? '',
        paymentTerms: row.paymentTerms ?? '',
        status: row.status || 'ACTIVE',
      }, admin._id);
      updated += 1;
      console.log(`Updated ${row.supplierCode} — ${row.name}`);
    }
  }

  const total = await Supplier.countDocuments({ factoryId: factory._id, isDeleted: { $ne: true } });
  console.log(`\nDone. created=${created} updated=${updated} totalSuppliers=${total}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
