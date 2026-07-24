/**
 * Panel route visibility smoke test — verifies key roles see expected API access.
 * Run: node src/scripts/panel-audit-test.js
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import app from '../app.js';
import { Permission } from '../modules/user/permission.model.js';
import { Role } from '../modules/user/role.model.js';
import { User } from '../modules/user/user.model.js';
import { Organization } from '../modules/organization/organization.model.js';
import { UserRoleAssignment } from '../modules/user/userRoleAssignment.model.js';
import { createFactory } from '../modules/organization/organization.service.js';
import { ALL_PERMISSION_CODES, SYSTEM_ROLES } from '../config/systemRoles.js';

async function api(base, path, { method = 'GET', token, factoryId, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (factoryId) headers['X-Factory-Id'] = factoryId;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  return { res, data };
}

function assertOk(label, { data }) {
  if (!data?.success) {
    throw new Error(`${label}: ${data?.error?.message || JSON.stringify(data)}`);
  }
  return data.data;
}

function assertDenied(label, { data }) {
  if (data?.success) throw new Error(`${label}: expected denial`);
}

const PANEL_CHECKS = [
  { role: 'DESIGNER', allow: ['/api/v1/designs/stats', '/api/v1/notifications/stats', '/api/v1/chat/rooms'], deny: ['/api/v1/inventory/stats'] },
  { role: 'SUB_ADMIN_QUALITY', allow: ['/api/v1/quality/stats', '/api/v1/chat/rooms'], deny: ['/api/v1/production/stats'] },
  { role: 'SUB_ADMIN_FINANCE', allow: ['/api/v1/purchase/stats', '/api/v1/reports/factory'], deny: ['/api/v1/production/stats'] },
  { role: 'AUDITOR', allow: ['/api/v1/audit-logs', '/api/v1/designs/stats', '/api/v1/chat/rooms'], deny: ['/api/v1/notifications/stats'] },
];

async function panelAuditTest() {
  const mongod = await MongoMemoryServer.create({ instance: { launchTimeout: 120000 } });
  await mongoose.connect(mongod.getUri());

  for (const code of ALL_PERMISSION_CODES) {
    const [module, action] = code.split('.');
    await Permission.create({ code, module, action, description: code });
  }

  const superAdmin = await User.create({
    email: 'panel-super@erp.local',
    passwordHash: await User.hashPassword('SuperAdmin@123'),
    firstName: 'Super',
    lastName: 'Admin',
    isSuperAdmin: true,
    status: 'ACTIVE',
  });

  const org = await Organization.create({
    code: 'PANEL',
    name: 'Panel Audit Org',
    status: 'ACTIVE',
    createdBy: superAdmin._id,
  });

  const factory = await createFactory(org._id, { code: 'P1', name: 'Panel Factory' }, superAdmin._id);

  const roleMap = {};
  for (const def of SYSTEM_ROLES) {
    roleMap[def.code] = await Role.create({
      organizationId: org._id,
      code: def.code,
      name: def.name,
      permissions: def.permissions,
      isSystem: true,
    });
  }

  const users = {};
  for (const check of PANEL_CHECKS) {
    const email = `${check.role.toLowerCase()}@panel.test`;
    users[check.role] = await User.create({
      organizationId: org._id,
      email,
      passwordHash: await User.hashPassword('Test@12345'),
      firstName: check.role,
      lastName: 'User',
      status: 'ACTIVE',
    });
    await UserRoleAssignment.create({
      organizationId: org._id,
      userId: users[check.role]._id,
      roleId: roleMap[check.role]._id,
      factoryId: factory._id,
      assignedBy: superAdmin._id,
    });
  }

  const server = app.listen(0);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    for (const check of PANEL_CHECKS) {
      const login = assertOk(`${check.role} login`, await api(base, '/api/v1/auth/login', {
        method: 'POST',
        body: { email: `${check.role.toLowerCase()}@panel.test`, password: 'Test@12345' },
      }));
      const opts = { token: login.accessToken, factoryId: login.factories[0]._id };
      for (const path of check.allow) {
        assertOk(`${check.role} ${path}`, await api(base, path, opts));
      }
      for (const path of check.deny) {
        assertDenied(`${check.role} deny ${path}`, await api(base, path, opts));
      }
    }
    console.log('Panel audit test passed');
  } finally {
    server.close();
    await mongoose.disconnect();
    await mongod.stop();
  }
}

panelAuditTest().catch((e) => {
  console.error(e);
  process.exit(1);
});
