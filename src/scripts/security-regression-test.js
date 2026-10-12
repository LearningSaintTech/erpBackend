/**
 * In-memory regression checks for the tenant/auth hardening (never touches a real DB).
 * Run: npm run security-test
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.DISABLE_RATE_LIMIT = 'true';

const { default: app } = await import('../app.js');
const { Permission } = await import('../modules/user/permission.model.js');
const { Role } = await import('../modules/user/role.model.js');
const { User } = await import('../modules/user/user.model.js');
const { Organization } = await import('../modules/organization/organization.model.js');
const { UserRoleAssignment } = await import('../modules/user/userRoleAssignment.model.js');
const { Design } = await import('../modules/design/design.model.js');
const { createFactory } = await import('../modules/organization/organization.service.js');
const { getFactoryAdminPermissions } = await import('../config/systemRoles.js');
const { isBypassOtpPhone } = await import('../modules/auth/appleReviewOtp.util.js');

const ALL_PERMS = getFactoryAdminPermissions();

async function api(base, path, { method = 'GET', token, factoryId, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (factoryId) headers['X-Factory-Id'] = factoryId;
  const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

function expect(label, cond, detail) {
  if (!cond) throw new Error(`${label} FAILED ${detail ? JSON.stringify(detail) : ''}`);
  console.log(`  ok  ${label}`);
}

async function makeOrgWithAdmin(code, superAdminId, perms = ALL_PERMS) {
  const org = await Organization.create({ code, name: `${code} Org`, status: 'ACTIVE', createdBy: superAdminId });
  const role = await Role.create({ organizationId: org._id, code: `ADMIN_${code}`, name: 'Admin', permissions: perms });
  const factory = await createFactory(org._id, { code: `${code}F`, name: `${code} Factory` }, superAdminId);
  const user = await User.create({
    organizationId: org._id,
    email: `admin@${code.toLowerCase()}.test`,
    passwordHash: await User.hashPassword('Test@12345'),
    firstName: code,
    lastName: 'Admin',
    status: 'ACTIVE',
  });
  await UserRoleAssignment.create({
    organizationId: org._id, userId: user._id, roleId: role._id, factoryId: factory._id, assignedBy: superAdminId,
  });
  return { org, factory, user, role };
}

async function run() {
  const mongod = await MongoMemoryServer.create({ instance: { launchTimeout: 120000 } });
  await mongoose.connect(mongod.getUri());
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    for (const code of ALL_PERMS) {
      const [module, action] = code.split('.');
      await Permission.create({ code, module, action, description: code });
    }
    const superAdmin = await User.create({
      email: 'sa@erp.local', passwordHash: await User.hashPassword('Super@123'),
      firstName: 'Super', lastName: 'Admin', isSuperAdmin: true, status: 'ACTIVE',
    });
    const a = await makeOrgWithAdmin('AAA', superAdmin._id);
    const b = await makeOrgWithAdmin('BBB', superAdmin._id);

    const login = async (email) => (await api(base, '/api/v1/auth/login', {
      method: 'POST', body: { email, password: 'Test@12345' },
    })).data.data;
    const sessA = await login('admin@aaa.test');
    const optsA = { token: sessA.accessToken, factoryId: String(a.factory._id) };

    console.log('Tenant isolation');
    const inj = await api(base, '/api/v1/designs?factoryId[$ne]=000000000000000000000000', { token: sessA.accessToken });
    expect('operator in ?factoryId is rejected', inj.status === 400, inj);
    const bad = await api(base, '/api/v1/designs', { ...optsA, factoryId: 'not-an-id' });
    expect('malformed X-Factory-Id is rejected', bad.status === 400, bad);
    const foreign = await api(base, '/api/v1/designs', { ...optsA, factoryId: String(b.factory._id) });
    expect('other org factory header is denied', foreign.status === 403, foreign);

    console.log('Organization scoping');
    const orgs = await api(base, '/api/v1/organizations', optsA);
    expect('org list only shows own org', orgs.data.data.length === 1 && orgs.data.data[0]._id === String(a.org._id), orgs.data);
    const otherOrg = await api(base, `/api/v1/organizations/${b.org._id}/factories`, optsA);
    expect('cannot list another org factories', otherOrg.status === 403, otherOrg);
    const otherSettings = await api(base, `/api/v1/factories/${b.factory._id}/settings`, {
      ...optsA, method: 'PUT', body: { workingDays: [1] },
    });
    expect('cannot rewrite another factory settings', otherSettings.status === 403, otherSettings);

    console.log('Router gating');
    const settingsNoFactory = await api(base, '/api/v1/settings/general', { token: sessA.accessToken });
    expect('settings works without X-Factory-Id (no requireFactory leak)', settingsNoFactory.status === 200, settingsNoFactory);

    console.log('Error mapping');
    const cast = await api(base, '/api/v1/designs/not-an-id', optsA);
    expect('invalid :id returns 400/404, not 500', [400, 404].includes(cast.status), cast);
    const regex = await api(base, '/api/v1/production-orders?search=(', optsA);
    expect('regex metacharacters in search do not 500', regex.status === 200, regex);

    console.log('Reports aggregation');
    await Design.create({
      organizationId: a.org._id, factoryId: a.factory._id, designCode: 'D-1', title: 'Agg test',
      styleNumber: 'AGG-1', status: 'APPROVED', createdBy: a.user._id,
    });
    const dash = await api(base, '/api/v1/reports/factory', optsA);
    const dashText = JSON.stringify(dash.data?.data || {});
    expect('factory dashboard counts designs (factoryId cast in $match)', /"APPROVED":1/.test(dashText), dash.data);

    console.log('Privilege escalation');
    const limitedRole = await Role.create({
      organizationId: a.org._id, code: 'USER_MGR', name: 'User manager', permissions: ['user.read', 'user.update'],
    });
    const mgr = await User.create({
      organizationId: a.org._id, email: 'mgr@aaa.test', passwordHash: await User.hashPassword('Test@12345'),
      firstName: 'M', lastName: 'G', status: 'ACTIVE',
    });
    await UserRoleAssignment.create({
      organizationId: a.org._id, userId: mgr._id, roleId: limitedRole._id, factoryId: a.factory._id, assignedBy: superAdmin._id,
    });
    const sessM = await login('mgr@aaa.test');
    const esc = await api(base, `/api/v1/users/${mgr._id}/roles`, {
      token: sessM.accessToken, factoryId: String(a.factory._id), method: 'POST',
      body: { roleId: String(a.role._id), factoryId: String(a.factory._id), organizationId: String(a.org._id) },
    });
    expect('cannot grant self a role with permissions not held', esc.status === 403, esc);

    console.log('Account status');
    await api(base, `/api/v1/users/${mgr._id}`, { ...optsA, method: 'PATCH', body: { status: 'LOCKED' } });
    const lockedCall = await api(base, '/api/v1/users/me', { token: sessM.accessToken, factoryId: String(a.factory._id) });
    expect('admin lock takes effect immediately', lockedCall.status === 401, lockedCall);
    const lockedLogin = await api(base, '/api/v1/auth/login', { method: 'POST', body: { email: 'mgr@aaa.test', password: 'Test@12345' } });
    expect('admin-locked user cannot log back in', lockedLogin.status === 401, lockedLogin);

    console.log('OTP');
    expect('no hardcoded bypass OTP phone', !isBypassOtpPhone('9829699382'));

    console.log('Security regression test passed');
  } finally {
    server.close();
    await mongoose.disconnect();
    await mongod.stop();
  }
}

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
