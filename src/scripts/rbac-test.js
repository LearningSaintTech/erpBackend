/**
 * RBAC API smoke tests — users, roles, assignments, delegations, permissions catalog.
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
import { ALL_PERMISSION_CODES } from '../config/systemRoles.js';

const ADMIN_PERMS = ALL_PERMISSION_CODES.filter((c) => !c.startsWith('organization.create'));

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

function assertApi(label, { data }) {
  if (!data?.success) {
    const msg = data?.error?.message || data?.message || JSON.stringify(data);
    throw new Error(`${label}: ${msg}`);
  }
  return data.data;
}

async function rbacTest() {
  const mongod = await MongoMemoryServer.create({ instance: { launchTimeout: 120000 } });
  await mongoose.connect(mongod.getUri());

  for (const code of ALL_PERMISSION_CODES) {
    const [module, action] = code.split('.');
    await Permission.create({ code, module, action, description: code });
  }

  const superAdmin = await User.create({
    email: 'superadmin@erp.local',
    passwordHash: await User.hashPassword('SuperAdmin@123'),
    firstName: 'Super',
    lastName: 'Admin',
    isSuperAdmin: true,
    status: 'ACTIVE',
  });

  const org = await Organization.create({
    code: 'RBAC',
    name: 'RBAC Test Org',
    status: 'ACTIVE',
    createdBy: superAdmin._id,
  });

  const factoryRole = await Role.create({
    organizationId: org._id,
    code: 'FACTORY_ADMIN',
    name: 'Factory Admin',
    permissions: ADMIN_PERMS,
    isSystem: true,
  });

  const designerRole = await Role.create({
    organizationId: org._id,
    code: 'DESIGNER',
    name: 'Designer',
    permissions: ['design.read', 'design.create', 'factory.read', 'notification.read', 'chat.read', 'chat.send'],
    isSystem: true,
  });

  const factory = await createFactory(org._id, { code: 'F01', name: 'RBAC Factory' }, superAdmin._id);

  const admin = await User.create({
    organizationId: org._id,
    email: 'admin@rbac.test',
    passwordHash: await User.hashPassword('Test@12345'),
    firstName: 'RBAC',
    lastName: 'Admin',
    status: 'ACTIVE',
  });

  const designer = await User.create({
    organizationId: org._id,
    email: 'designer@rbac.test',
    passwordHash: await User.hashPassword('Test@12345'),
    firstName: 'Test',
    lastName: 'Designer',
    status: 'ACTIVE',
  });

  await UserRoleAssignment.create({
    organizationId: org._id,
    userId: admin._id,
    roleId: factoryRole._id,
    factoryId: factory._id,
    assignedBy: superAdmin._id,
  });

  await UserRoleAssignment.create({
    organizationId: org._id,
    userId: designer._id,
    roleId: designerRole._id,
    factoryId: factory._id,
    assignedBy: superAdmin._id,
  });

  const server = app.listen(0);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    const loginPayload = await api(base, '/api/v1/auth/login', {
      method: 'POST',
      body: { email: 'admin@rbac.test', password: 'Test@12345' },
    });
    const login = assertApi('Login', loginPayload);
    const token = login.accessToken;
    const factoryId = login.factories[0]._id;
    const opts = { token, factoryId };

    // Permissions catalog
    const catalog = assertApi('GET /permissions', await api(base, '/api/v1/permissions', opts));
    if (!Array.isArray(catalog) || catalog.length === 0) {
      throw new Error('Permissions catalog empty');
    }
    if (!catalog.includes('user.read')) {
      throw new Error('Permissions catalog missing user.read');
    }

    // List users and roles
    const users = assertApi('List users', await api(base, '/api/v1/users', opts));
    if (!users.length) throw new Error('Expected users in list');

    const roles = assertApi('List roles', await api(base, '/api/v1/roles', opts));
    if (!roles.length) throw new Error('Expected roles in list');

    // Create custom role
    const customRole = assertApi('Create custom role', await api(base, '/api/v1/roles', {
      method: 'POST',
      ...opts,
      body: {
        code: 'RBAC_TEST_ROLE',
        name: 'RBAC Test Role',
        permissions: ['inventory.read', 'factory.read', 'notification.read'],
      },
    }));

    // Assign custom role to designer
    assertApi('Assign role', await api(base, `/api/v1/users/${designer._id}/roles`, {
      method: 'POST',
      ...opts,
      body: {
        roleId: customRole._id,
        factoryId,
        organizationId: org._id.toString(),
      },
    }));

    // Designer login and check permissions
    const designerLogin = assertApi('Designer login', await api(base, '/api/v1/auth/login', {
      method: 'POST',
      body: { email: 'designer@rbac.test', password: 'Test@12345' },
    }));
    const designerToken = designerLogin.accessToken;

    const designerPerms = assertApi('Designer permissions', await api(base, '/api/v1/users/me/permissions', {
      token: designerToken,
      factoryId,
    }));
    if (!designerPerms.permissions.includes('inventory.read')) {
      throw new Error('Designer missing inventory.read after assignment');
    }

    // Revoke assignment
    const assignments = assertApi('List assignments', await api(base, `/api/v1/users/${designer._id}/assignments`, opts));
    const assignment = assignments.find((a) => a.roleId?._id === customRole._id || a.roleId === customRole._id);
    if (!assignment) throw new Error('Assignment not found');

    assertApi('Revoke assignment', await api(base, `/api/v1/users/${designer._id}/assignments/${assignment._id}`, {
      method: 'DELETE',
      ...opts,
    }));

    const afterRevoke = assertApi('Permissions after revoke', await api(base, '/api/v1/users/me/permissions', {
      token: designerToken,
      factoryId,
    }));
    if (afterRevoke.permissions.includes('inventory.read')) {
      throw new Error('Designer still has inventory.read after revoke');
    }
    if (!afterRevoke.permissions.includes('design.read')) {
      throw new Error('Designer lost design.read from base role after custom revoke');
    }

    // Delegation test — admin delegates purchase.read to designer
    const start = new Date();
    const end = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    assertApi('Create delegation', await api(base, '/api/v1/delegations', {
      method: 'POST',
      ...opts,
      body: {
        delegateId: designer._id.toString(),
        permissions: ['purchase.read'],
        startDate: start.toISOString(),
        endDate: end.toISOString(),
      },
    }));

    const delegatedPerms = assertApi('Delegated permissions', await api(base, '/api/v1/users/me/permissions', {
      token: designerToken,
      factoryId,
    }));
    if (!delegatedPerms.permissions.includes('purchase.read')) {
      throw new Error('Delegate missing purchase.read from delegation');
    }

    // Cross-org assign rejected
    const otherOrg = await Organization.create({
      code: 'OTHER',
      name: 'Other Org',
      status: 'ACTIVE',
      createdBy: superAdmin._id,
    });
    const otherFactory = await createFactory(otherOrg._id, { code: 'F99', name: 'Other Factory' }, superAdmin._id);
    const otherRole = await Role.create({
      organizationId: otherOrg._id,
      code: 'OTHER_ADMIN',
      name: 'Other Admin',
      permissions: ['user.read'],
      isSystem: true,
    });

    const crossAssign = await api(base, `/api/v1/users/${designer._id}/roles`, {
      method: 'POST',
      ...opts,
      body: {
        roleId: otherRole._id,
        factoryId: otherFactory._id,
        organizationId: org._id.toString(),
      },
    });
    if (crossAssign.data?.success) {
      throw new Error('Cross-org role assign should have failed');
    }

    // Delete custom role (after revoking would be needed if assigned — custom role not assigned now)
    assertApi('Delete custom role', await api(base, `/api/v1/roles/${customRole._id}`, {
      method: 'DELETE',
      ...opts,
    }));

    // Chat RBAC — designer has chat.read via notify bundle
    assertApi('Designer chat rooms', await api(base, '/api/v1/chat/rooms', {
      token: designerToken,
      factoryId,
    }));

    assertApi('Admin chat catalog', await api(base, '/api/v1/chat/catalog', opts));

    const group = assertApi('Admin create chat group', await api(base, '/api/v1/chat/rooms/group', {
      method: 'POST', ...opts,
      body: { name: 'RBAC Group', memberIds: [designer._id.toString()] },
    }));

    assertApi('Admin send chat message', await api(base, `/api/v1/chat/rooms/${group._id}/messages`, {
      method: 'POST', ...opts,
      body: { body: 'RBAC test message' },
    }));

    const modRooms = assertApi('Moderate list rooms', await api(base, '/api/v1/chat/admin/rooms', opts));
    if (!modRooms.length) throw new Error('Moderate rooms list empty');

    // Cross-factory DM rejected
    const otherWorker = await User.create({
      organizationId: otherOrg._id,
      email: 'other@rbac.test',
      passwordHash: await User.hashPassword('Test@12345'),
      firstName: 'Other',
      lastName: 'Worker',
      status: 'ACTIVE',
    });
    await UserRoleAssignment.create({
      organizationId: otherOrg._id,
      userId: otherWorker._id,
      roleId: otherRole._id,
      factoryId: otherFactory._id,
      assignedBy: superAdmin._id,
    });

    const crossDm = await api(base, '/api/v1/chat/rooms/direct', {
      method: 'POST',
      ...opts,
      body: { userId: otherWorker._id.toString() },
    });
    if (crossDm.data?.success) {
      throw new Error('Cross-factory direct chat should be rejected');
    }

    console.log('RBAC test passed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    await mongod.stop();
  }
}

rbacTest().catch((err) => {
  console.error('RBAC test failed:', err.message);
  process.exit(1);
});
