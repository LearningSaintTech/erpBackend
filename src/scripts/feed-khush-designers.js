/**
 * One-shot: create Khush designer logins in ERP (DESIGNER role).
 * Source: test.designerauths.json (pushparaj excluded).
 * Usage: node src/scripts/feed-khush-designers.js
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { User } from '../modules/user/user.model.js';
import { Role } from '../modules/user/role.model.js';
import { Organization } from '../modules/organization/organization.model.js';
import { Factory } from '../modules/organization/factory.model.js';
import { UserRoleAssignment } from '../modules/user/userRoleAssignment.model.js';

const PASSWORD = 'Demo@123!';

/** Email = {slug}@khush.com — pushparaj intentionally omitted. */
const DESIGNERS = [
  { name: 'saumya', phone: '7289098759' },
  { name: 'sakshi', phone: '8707454797' },
  { name: 'rajat', phone: '8218748799' },
  { name: 'Anisha Gupta', phone: '9755987040' },
  { name: 'Prachi', phone: '6206786331', employeeId: undefined },
  { name: 'pushkar', phone: '9829699382', employeeId: 'eede' },
  { name: 'abhishek sharma', phone: '7844903043' },
  { name: 'Vaibhav', phone: '9536166936', employeeId: 'test1' },
];

const REMOVE_EMAILS = ['pushparaj@khush.com'];

function splitName(name) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  const firstName = parts[0] ? parts[0][0].toUpperCase() + parts[0].slice(1).toLowerCase() : 'Designer';
  const lastName = parts.slice(1).map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase()).join(' ') || 'Designer';
  return { firstName, lastName };
}

function emailFromName(name) {
  const slug = String(name).trim().toLowerCase().replace(/\s+/g, '.');
  return `${slug}@khush.com`;
}

async function main() {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/erpFactory';
  await mongoose.connect(uri);

  const org = await Organization.findOne({ code: 'DEMO' });
  if (!org) throw new Error('Organization DEMO not found — run RBAC seed first');
  const factory = await Factory.findOne({ organizationId: org._id, code: 'F01' });
  if (!factory) throw new Error('Factory F01 not found — run RBAC seed first');
  const role = await Role.findOne({ organizationId: org._id, code: 'DESIGNER' });
  if (!role) throw new Error('DESIGNER role not found — run RBAC seed first');
  const superAdmin = await User.findOne({ isSuperAdmin: true });

  for (const email of REMOVE_EMAILS) {
    const user = await User.findOne({ email });
    if (!user) {
      console.log(`  [skip remove] ${email} not found`);
      continue;
    }
    await UserRoleAssignment.deleteMany({ userId: user._id });
    user.status = 'INACTIVE';
    user.isDeleted = true;
    user.deletedAt = new Date();
    await user.save();
    console.log(`  [removed] ${email}`);
  }

  const passwordHash = await User.hashPassword(PASSWORD);
  const results = [];

  for (const d of DESIGNERS) {
    const email = emailFromName(d.name);
    const { firstName, lastName } = splitName(d.name);
    let user = await User.findOne({ email });
    let action = 'exists';

    if (!user) {
      user = await User.create({
        organizationId: org._id,
        email,
        passwordHash,
        firstName,
        lastName,
        phone: d.phone || undefined,
        employeeId: d.employeeId || undefined,
        status: 'ACTIVE',
        createdBy: superAdmin?._id,
      });
      action = 'created';
    } else {
      user.passwordHash = passwordHash;
      user.firstName = firstName;
      user.lastName = lastName;
      if (d.phone) user.phone = d.phone;
      if (d.employeeId) user.employeeId = d.employeeId;
      user.status = 'ACTIVE';
      user.isDeleted = false;
      user.deletedAt = undefined;
      await user.save();
      action = 'updated';
    }

    const existing = await UserRoleAssignment.findOne({
      organizationId: org._id,
      userId: user._id,
      roleId: role._id,
      factoryId: factory._id,
    });
    if (!existing) {
      await UserRoleAssignment.create({
        organizationId: org._id,
        userId: user._id,
        roleId: role._id,
        factoryId: factory._id,
        assignedBy: superAdmin?._id,
      });
    }

    results.push({ action, email, name: `${firstName} ${lastName}`, password: PASSWORD });
  }

  console.log(`\nFed ${results.length} Khush designers (DESIGNER @ F01)\n`);
  for (const r of results) {
    console.log(`  [${r.action}] ${r.email}  /  ${r.password}  (${r.name})`);
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
