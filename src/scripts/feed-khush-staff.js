/**
 * Replace demo email/password users with Khush staff (phone OTP).
 * One person can hold many roles on F01. 9829699382 gets every role + super admin.
 *
 * Usage: node src/scripts/feed-khush-staff.js
 */
import 'dotenv/config';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { User } from '../modules/user/user.model.js';
import { Role } from '../modules/user/role.model.js';
import { Organization } from '../modules/organization/organization.model.js';
import { Factory } from '../modules/organization/factory.model.js';
import { UserRoleAssignment } from '../modules/user/userRoleAssignment.model.js';
import { Session } from '../modules/auth/session.model.js';
import { SYSTEM_ROLES } from '../config/systemRoles.js';

const ALL_ROLE_CODES = SYSTEM_ROLES.map((r) => r.code);

const STAFF = [
  {
    name: 'Khushi',
    phone: '9315920837',
    email: 'khushi@khush.com',
    isSuperAdmin: true,
    roles: ['FACTORY_ADMIN'],
  },
  {
    name: 'Abhishek',
    phone: '7844903043',
    email: 'abhishek@khush.com',
    isSuperAdmin: true,
    roles: ['FACTORY_ADMIN'],
  },
  {
    name: 'Rajveer',
    phone: '9968400407',
    email: 'rajveer@khush.com',
    isSuperAdmin: false,
    roles: [
      'SUB_ADMIN_PRODUCTION',
      'SUB_ADMIN_PURCHASE',
      'SUB_ADMIN_WAREHOUSE',
      'PRODUCTION_MANAGER',
      'PURCHASE_MANAGER',
    ],
  },
  {
    name: 'Chitra',
    phone: '9956216407',
    email: 'chitra@khush.com',
    isSuperAdmin: false,
    roles: ['SUB_ADMIN_INVENTORY', 'INVENTORY_MANAGER'],
  },
  {
    name: 'Mrinalik',
    phone: '7060697944',
    email: 'mrinalik@khush.com',
    isSuperAdmin: false,
    roles: ['SUB_ADMIN_QUALITY', 'DESIGN_MANAGER'],
  },
  {
    name: 'Harsh',
    phone: '6206520259',
    email: 'harsh@khush.com',
    isSuperAdmin: false,
    roles: ['SUB_ADMIN_FINANCE'],
  },
  {
    name: 'Pushkar',
    phone: '9829699382',
    email: 'pushkar@khush.com',
    isSuperAdmin: true,
    roles: ALL_ROLE_CODES,
  },
];

function splitName(name) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  const firstName = parts[0]
    ? parts[0][0].toUpperCase() + parts[0].slice(1).toLowerCase()
    : 'User';
  const lastName = parts.slice(1).map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase()).join(' ') || 'Khush';
  return { firstName, lastName };
}

function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

async function findByPhone(phone) {
  const mobile = normalizePhone(phone);
  return User.findOne({
    $or: [{ phone: mobile }, { phone: String(phone).trim() }],
  });
}

async function uniqueEmail(desired, keepUserId) {
  const taken = await User.findOne({
    email: desired,
    ...(keepUserId ? { _id: { $ne: keepUserId } } : {}),
  });
  if (!taken) return desired;
  const [local, domain] = desired.split('@');
  return `${local}.${crypto.randomBytes(2).toString('hex')}@${domain}`;
}

async function deactivateOthers(keepIds) {
  const others = await User.find({ _id: { $nin: keepIds }, isDeleted: { $ne: true } });
  let n = 0;
  for (const user of others) {
    user.phone = undefined;
    user.status = 'INACTIVE';
    user.isDeleted = true;
    user.deletedAt = new Date();
    user.isSuperAdmin = false;
    await user.save();
    await UserRoleAssignment.deleteMany({ userId: user._id });
    await Session.deleteMany({ userId: user._id });
    n += 1;
  }
  return n;
}

async function upsertStaff({ spec, org, factory, roleMap, passwordHash, assignedBy }) {
  const mobile = normalizePhone(spec.phone);
  const { firstName, lastName } = splitName(spec.name);
  let user = await findByPhone(mobile);
  let action = 'updated';

  if (!user) {
    user = await User.create({
      organizationId: org._id,
      email: await uniqueEmail(spec.email),
      passwordHash,
      firstName,
      lastName,
      phone: mobile,
      countryCode: '+91',
      isNumberVerified: true,
      isSuperAdmin: Boolean(spec.isSuperAdmin),
      status: 'ACTIVE',
      isDeleted: false,
      createdBy: assignedBy,
    });
    action = 'created';
  } else {
    user.organizationId = org._id;
    user.firstName = firstName;
    user.lastName = lastName;
    user.phone = mobile;
    user.countryCode = '+91';
    user.isNumberVerified = true;
    user.isSuperAdmin = Boolean(spec.isSuperAdmin);
    user.status = 'ACTIVE';
    user.isDeleted = false;
    user.deletedAt = undefined;
    user.passwordHash = passwordHash;
    if (!user.email) user.email = await uniqueEmail(spec.email, user._id);
    await user.save();
  }

  await UserRoleAssignment.deleteMany({ userId: user._id, factoryId: factory._id });
  for (const code of spec.roles) {
    const role = roleMap.get(code);
    if (!role) throw new Error(`Role not found: ${code}`);
    await UserRoleAssignment.create({
      organizationId: org._id,
      userId: user._id,
      roleId: role._id,
      factoryId: factory._id,
      assignedBy,
    });
  }

  return { action, user, roles: spec.roles };
}

async function main() {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/erpFactory';
  await mongoose.connect(uri);

  const org = await Organization.findOne({ code: 'DEMO' });
  if (!org) throw new Error('Organization DEMO not found — run RBAC seed first');
  const factory = await Factory.findOne({ organizationId: org._id, code: 'F01' });
  if (!factory) throw new Error('Factory F01 not found — run RBAC seed first');

  const roles = await Role.find({
    code: { $in: ALL_ROLE_CODES },
    $or: [{ organizationId: org._id }, { organizationId: null, isSystem: true }],
  });
  const roleMap = new Map(roles.map((r) => [r.code, r]));
  for (const code of ALL_ROLE_CODES) {
    if (!roleMap.has(code)) throw new Error(`Role missing in DB: ${code}`);
  }

  const passwordHash = await User.hashPassword(crypto.randomBytes(32).toString('hex'));
  const existingAdmin = await User.findOne({ isSuperAdmin: true, isDeleted: { $ne: true } });

  const keepIds = [];
  const results = [];
  for (const spec of STAFF) {
    const row = await upsertStaff({
      spec,
      org,
      factory,
      roleMap,
      passwordHash,
      assignedBy: existingAdmin?._id,
    });
    keepIds.push(row.user._id);
    results.push(row);
  }

  const removed = await deactivateOthers(keepIds);

  console.log(`\nKhush staff ready (phone OTP). Deactivated ${removed} old accounts.\n`);
  for (const row of results) {
    const u = row.user;
    const roleLabel = row.roles.length === ALL_ROLE_CODES.length ? 'ALL ROLES' : row.roles.join(', ');
    console.log(
      `  [${row.action}] ${u.phone}  ${u.firstName} ${u.lastName}`
      + `${u.isSuperAdmin ? '  SUPER ADMIN' : ''}`
      + `\n           ${roleLabel}`,
    );
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
