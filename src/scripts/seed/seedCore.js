import { Permission } from '../../modules/user/permission.model.js';
import { Role } from '../../modules/user/role.model.js';
import { User } from '../../modules/user/user.model.js';
import { Organization } from '../../modules/organization/organization.model.js';
import { Factory } from '../../modules/organization/factory.model.js';
import { UserRoleAssignment } from '../../modules/user/userRoleAssignment.model.js';
import {
  PERMISSIONS,
  SYSTEM_ROLES,
  DEMO_USERS,
  DEMO_ROLE_PASSWORD,
  DEMO_CREDENTIALS_SUMMARY,
} from '../../config/systemRoles.js';
import { buildRoleUsers } from './seedHelpers.js';
import { seedInventoryCodesFromFile, seedSkuFormulaConfig } from '../../modules/inventoryCode/inventoryCode.service.js';

async function seedPermissions() {
  for (const [module, action] of PERMISSIONS) {
    const code = `${module}.${action}`;
    await Permission.updateOne({ code }, { module, action, description: code }, { upsert: true });
  }
  console.log(`Seeded ${PERMISSIONS.length} permissions`);
}

async function seedInventoryCatalog() {
  const codeCount = await seedInventoryCodesFromFile();
  console.log(`Seeded ${codeCount} inventory codes`);
  await seedSkuFormulaConfig();
  console.log('Seeded SKU formula config');
  return codeCount;
}

async function seedSuperAdmin() {
  let superAdmin = await User.findOne({ email: 'superadmin@erp.local', isSuperAdmin: true });
  if (!superAdmin) {
    superAdmin = await User.create({
      email: 'superadmin@erp.local',
      passwordHash: await User.hashPassword('SuperAdmin@123'),
      firstName: 'Super',
      lastName: 'Admin',
      isSuperAdmin: true,
      status: 'ACTIVE',
    });
    console.log('Created super admin: superadmin@erp.local / SuperAdmin@123');
  }
  return superAdmin;
}

async function seedOrganization(superAdmin) {
  let org = await Organization.findOne({ code: 'DEMO' });
  if (!org) {
    org = await Organization.create({
      code: 'DEMO',
      name: 'Demo Textiles Ltd',
      defaultCurrency: 'INR',
      timezone: 'Asia/Kolkata',
      status: 'ACTIVE',
      createdBy: superAdmin._id,
    });
    console.log('Created organization DEMO');
  }
  return org;
}

async function seedFactory(org, superAdmin) {
  let factory = await Factory.findOne({ organizationId: org._id, code: 'F01' });
  if (!factory) {
    const { createFactory } = await import('../../modules/organization/organization.service.js');
    factory = await createFactory(org._id, { code: 'F01', name: 'Main Production Unit' }, superAdmin._id);
    console.log('Created factory F01');
  }
  return factory;
}

async function seedSystemRoles(orgId) {
  const roleMap = new Map();
  for (const def of SYSTEM_ROLES) {
    let role = await Role.findOne({ organizationId: orgId, code: def.code });
    if (!role) {
      role = await Role.create({
        organizationId: orgId,
        code: def.code,
        name: def.name,
        permissions: def.permissions,
        isSystem: true,
      });
    } else {
      role.name = def.name;
      role.permissions = def.permissions;
      await role.save();
    }
    roleMap.set(def.code, role);
  }
  console.log(`Seeded ${SYSTEM_ROLES.length} system roles`);
  return roleMap;
}

async function ensureRoleAssignment({ org, factory, user, role, assignedBy }) {
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
      assignedBy: assignedBy._id,
    });
  }
}

async function seedDemoUsers(org, factory, superAdmin, roleMap) {
  let created = 0;
  for (const spec of DEMO_USERS) {
    const password = spec.password || DEMO_ROLE_PASSWORD;
    let user = await User.findOne({ email: spec.email });
    if (!user) {
      user = await User.create({
        organizationId: org._id,
        email: spec.email,
        passwordHash: await User.hashPassword(password),
        firstName: spec.firstName,
        lastName: spec.lastName,
        status: 'ACTIVE',
        createdBy: superAdmin._id,
      });
      created += 1;
    }
    const role = roleMap.get(spec.roleCode);
    if (!role) throw new Error(`Role not found: ${spec.roleCode}`);
    await ensureRoleAssignment({ org, factory, user, role, assignedBy: superAdmin });
  }
  console.log(`Seeded ${DEMO_USERS.length} demo users (${created} newly created)`);
  return User.findOne({ email: 'admin@demo.local' });
}

export function printRbacSeedSummary({ org, factory, inventoryCodeCount = 0 }) {
  const UI_BASE = process.env.FRONTEND_URL || 'http://localhost:5173';
  console.log('\n=== RBAC seed summary ===');
  console.log(`Organization: ${org.code} — ${org.name}`);
  console.log(`Factory:      ${factory.code} — ${factory.name}`);
  console.log(`Permissions:  ${PERMISSIONS.length} module actions`);
  console.log(`Roles:        ${SYSTEM_ROLES.length} system roles`);
  console.log(`Users:        ${DEMO_USERS.length} demo accounts + 1 super admin`);
  console.log(`Inv. codes:   ${inventoryCodeCount} catalog entries (+ SKU formula config)`);
  console.log(`Frontend:     ${UI_BASE}/login`);
  console.log(`Settings:     ${UI_BASE}/settings/inventory-codes`);
  console.log('\n--- Credentials (email / password / role) ---');
  for (const cred of DEMO_CREDENTIALS_SUMMARY) {
    console.log(`  ${cred.email.padEnd(32)} ${cred.password.padEnd(18)} ${cred.role}`);
  }
  console.log('\n--- Roles & module access ---');
  for (const def of SYSTEM_ROLES) {
    console.log(`  ${def.code.padEnd(24)} ${def.name} (${def.permissions.length} permissions)`);
  }
  console.log('\nNo transactional data seeded (materials, purchase, warehouse, designs, etc.).');
  console.log('Default: npm run seed (conditions profile). Use npm run seed:demo for full fixtures.\n');
}

export async function seedCore() {
  await seedPermissions();
  const inventoryCodeCount = await seedInventoryCatalog();
  const superAdmin = await seedSuperAdmin();
  const org = await seedOrganization(superAdmin);
  const factory = await seedFactory(org, superAdmin);
  const roleMap = await seedSystemRoles(org._id);
  const admin = await seedDemoUsers(org, factory, superAdmin, roleMap);
  const roleUsers = await buildRoleUsers();

  return {
    superAdmin,
    org,
    factory,
    admin,
    roleMap,
    roleUsers,
    inventoryCodeCount,
    auditCount: 0,
    materials: new Map(),
    designs: [],
    suppliers: [],
    warehouses: [],
    skus: [],
    boms: [],
    productionOrders: [],
    batches: [],
  };
}
