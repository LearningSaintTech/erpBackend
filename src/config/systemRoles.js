/** Permission catalog and system role definitions — aligned with docs/deliverables/matrices/role-permission-matrix.md */

export const PERMISSIONS = [
  ['organization', 'create'], ['organization', 'read'], ['organization', 'update'], ['organization', 'configure'],
  ['factory', 'create'], ['factory', 'read'], ['factory', 'update'], ['factory', 'configure'],
  ['user', 'create'], ['user', 'read'], ['user', 'update'], ['user', 'delete'],
  ['role', 'create'], ['role', 'read'], ['role', 'configure'],
  ['design', 'create'], ['design', 'read'], ['design', 'update'], ['design', 'delete'], ['design', 'approve'], ['design', 'export'],
  ['pattern', 'create'], ['pattern', 'read'], ['pattern', 'update'], ['pattern', 'approve'],
  ['sampling', 'create'], ['sampling', 'read'], ['sampling', 'update'], ['sampling', 'approve'], ['sampling', 'configure'],
  ['sku', 'create'], ['sku', 'read'], ['sku', 'update'], ['sku', 'delete'],
  ['bom', 'create'], ['bom', 'read'], ['bom', 'update'], ['bom', 'approve'], ['bom', 'configure'],
  ['inventory', 'create'], ['inventory', 'read'], ['inventory', 'update'], ['inventory', 'delete'], ['inventory', 'export'], ['inventory', 'configure'],
  ['warehouse', 'create'], ['warehouse', 'read'], ['warehouse', 'update'], ['warehouse', 'configure'],
  ['purchase', 'create'], ['purchase', 'read'], ['purchase', 'update'], ['purchase', 'delete'], ['purchase', 'approve'], ['purchase', 'export'],
  ['production', 'create'], ['production', 'read'], ['production', 'update'], ['production', 'approve'], ['production', 'configure'],
  ['batch', 'create'], ['batch', 'read'], ['batch', 'update'],
  ['quality', 'create'], ['quality', 'read'], ['quality', 'update'], ['quality', 'approve'], ['quality', 'configure'],
  ['waste', 'create'], ['waste', 'read'], ['waste', 'update'], ['waste', 'export'],
  ['approval', 'read'], ['approval', 'approve'], ['approval', 'configure'],
  ['notification', 'read'], ['notification', 'configure'],
  ['chat', 'read'], ['chat', 'send'], ['chat', 'group.create'], ['chat', 'group.manage'], ['chat', 'moderate'],
  ['report', 'read'], ['report', 'export'],
  ['audit', 'read'],
  ['settings', 'configure'],
];

export const ALL_PERMISSION_CODES = PERMISSIONS.map(([m, a]) => `${m}.${a}`);

const p = (...codes) => codes;
const notify = ['notification.read', 'chat.read', 'chat.send'];
const factoryRead = ['factory.read'];
const subAdminBase = ['factory.read', 'user.read', 'role.read', 'report.read'];

export function getFactoryAdminPermissions() {
  return ALL_PERMISSION_CODES.filter(
    (code) => !code.startsWith('organization.create')
      && code !== 'pattern.update'
      && code !== 'sampling.update',
  );
}

/** Read-only permissions for auditor role */
const AUDITOR_READ_EXCLUDE = new Set([
  'notification.read', 'chat.group.create', 'chat.group.manage', 'chat.moderate',
]);
const AUDITOR_PERMISSIONS = [
  ...ALL_PERMISSION_CODES.filter((code) => code.endsWith('.read') && !AUDITOR_READ_EXCLUDE.has(code)),
  'chat.send',
  'report.export',
  'audit.read',
  'inventory.export',
  'purchase.export',
  'waste.read',
];

export const SYSTEM_ROLES = [
  {
    code: 'FACTORY_ADMIN',
    name: 'Factory Admin',
    permissions: getFactoryAdminPermissions(),
  },
  {
    code: 'SUB_ADMIN_PRODUCTION',
    name: 'Production Sub Admin',
    permissions: p(
      ...subAdminBase,
      'approval.read', 'approval.approve',
      'production.create', 'production.read', 'production.update', 'production.approve', 'production.configure',
      'batch.create', 'batch.read', 'batch.update',
      'waste.create', 'waste.read', 'waste.update', 'waste.export',
      'bom.read',
      ...notify,
    ),
  },
  {
    code: 'SUB_ADMIN_INVENTORY',
    name: 'Inventory Sub Admin',
    permissions: p(
      ...subAdminBase,
      'inventory.create', 'inventory.read', 'inventory.update', 'inventory.delete', 'inventory.export', 'inventory.configure',
      ...notify,
    ),
  },
  {
    code: 'SUB_ADMIN_PURCHASE',
    name: 'Purchase Sub Admin',
    permissions: p(
      ...subAdminBase,
      'approval.read',
      'purchase.create', 'purchase.read', 'purchase.update', 'purchase.delete', 'purchase.approve', 'purchase.export',
      ...notify,
    ),
  },
  {
    code: 'SUB_ADMIN_WAREHOUSE',
    name: 'Warehouse Sub Admin',
    permissions: p(
      ...subAdminBase,
      'factory.configure',
      'warehouse.create', 'warehouse.read', 'warehouse.update', 'warehouse.configure',
      ...notify,
    ),
  },
  {
    code: 'SUB_ADMIN_QUALITY',
    name: 'Quality Sub Admin',
    permissions: p(
      ...subAdminBase,
      'approval.read', 'approval.approve',
      'quality.create', 'quality.read', 'quality.update', 'quality.approve', 'quality.configure',
      'waste.read',
      ...notify,
    ),
  },
  {
    code: 'SUB_ADMIN_FINANCE',
    name: 'Finance Sub Admin',
    permissions: p(
      ...subAdminBase,
      'approval.read',
      'report.export',
      'waste.read',
      'purchase.read',
      'inventory.read',
      ...notify,
    ),
  },
  {
    code: 'PATTERN_MASTER',
    name: 'Pattern Master',
    permissions: p(
      ...factoryRead,
      'design.read',
      'pattern.read', 'pattern.update',
      'sampling.read', 'sampling.update',
      ...notify,
    ),
  },
  {
    code: 'DESIGNER',
    name: 'Designer',
    permissions: p(
      'factory.read',
      'design.create', 'design.read', 'design.update',
      'inventory.read',
      ...notify,
    ),
  },
  {
    code: 'DESIGN_MANAGER',
    name: 'Design Manager',
    permissions: p(
      ...factoryRead,
      'design.read', 'design.approve', 'design.export',
      'pattern.create', 'pattern.read', 'pattern.approve',
      'sampling.create', 'sampling.read', 'sampling.approve',
      'sku.create', 'sku.read', 'sku.update',
      'bom.read',
      'approval.read',
      ...notify,
    ),
  },
  {
    code: 'SAMPLING_TEAM',
    name: 'Sampling Team',
    permissions: p(
      ...factoryRead,
      'design.read',
      'inventory.read',
      'sampling.create', 'sampling.read', 'sampling.update',
      ...notify,
    ),
  },
  {
    code: 'PRODUCTION_PLANNER',
    name: 'Production Planner',
    permissions: p(
      ...factoryRead,
      'production.create', 'production.read', 'production.update',
      'batch.create', 'batch.read', 'batch.update',
      'bom.create', 'bom.read', 'bom.update',
      'sku.read',
      ...notify,
    ),
  },
  {
    code: 'PRODUCTION_MANAGER',
    name: 'Production Manager',
    permissions: p(
      ...factoryRead,
      'production.create', 'production.read', 'production.update', 'production.approve', 'production.configure',
      'batch.create', 'batch.read', 'batch.update',
      'bom.read',
      'waste.create', 'waste.read', 'waste.update',
      'approval.read', 'approval.approve',
      ...notify,
    ),
  },
  {
    code: 'STORE_KEEPER',
    name: 'Store Keeper',
    permissions: p(
      ...factoryRead,
      'sampling.read',
      'inventory.create', 'inventory.read', 'inventory.update',
      // Read stock locator + put away dock receipts into bins after QC
      'warehouse.read', 'warehouse.update',
      // Create & submit purchase requisitions; Purchase Manager + Admin approve, then PM executes PO/RFQ/GRN
      'purchase.create', 'purchase.read', 'purchase.update',
      'approval.read',
      ...notify,
    ),
  },
  {
    code: 'PURCHASE_MANAGER',
    name: 'Purchase Manager',
    permissions: p(
      ...factoryRead,
      'purchase.create', 'purchase.read', 'purchase.update', 'purchase.approve', 'purchase.export',
      'approval.read',
      ...notify,
    ),
  },
  {
    code: 'WAREHOUSE_MANAGER',
    name: 'Warehouse Manager',
    permissions: p(
      ...factoryRead,
      'warehouse.create', 'warehouse.read', 'warehouse.update', 'warehouse.configure',
      'inventory.read',
      ...notify,
    ),
  },
  {
    code: 'INVENTORY_MANAGER',
    name: 'Inventory Manager',
    permissions: p(
      ...factoryRead,
      'inventory.create', 'inventory.read', 'inventory.update', 'inventory.delete', 'inventory.export', 'inventory.configure',
      ...notify,
    ),
  },
  {
    code: 'QUALITY_INSPECTOR',
    name: 'Quality Inspector',
    permissions: p(
      ...factoryRead,
      'quality.create', 'quality.read', 'quality.update',
      'sampling.read',
      'waste.create', 'waste.read',
      'batch.read',
      ...notify,
    ),
  },
  {
    code: 'MACHINE_OPERATOR',
    name: 'Machine Operator',
    permissions: p(
      ...factoryRead,
      'batch.read', 'batch.update',
      'production.read', 'production.update',
      ...notify,
    ),
  },
  {
    code: 'AUDITOR',
    name: 'Auditor',
    permissions: AUDITOR_PERMISSIONS,
  },
];

/** Demo org users — password Demo@123 unless overridden */
export const DEMO_USERS = [
  { email: 'admin@demo.local', password: 'FactoryAdmin@123', firstName: 'Factory', lastName: 'Admin', roleCode: 'FACTORY_ADMIN' },
  { email: 'production-admin@demo.local', firstName: 'Production', lastName: 'Sub Admin', roleCode: 'SUB_ADMIN_PRODUCTION' },
  { email: 'inventory-admin@demo.local', firstName: 'Inventory', lastName: 'Sub Admin', roleCode: 'SUB_ADMIN_INVENTORY' },
  { email: 'purchase-admin@demo.local', firstName: 'Purchase', lastName: 'Sub Admin', roleCode: 'SUB_ADMIN_PURCHASE' },
  { email: 'warehouse-admin@demo.local', firstName: 'Warehouse', lastName: 'Sub Admin', roleCode: 'SUB_ADMIN_WAREHOUSE' },
  { email: 'quality-admin@demo.local', firstName: 'Quality', lastName: 'Sub Admin', roleCode: 'SUB_ADMIN_QUALITY' },
  { email: 'finance-admin@demo.local', firstName: 'Finance', lastName: 'Sub Admin', roleCode: 'SUB_ADMIN_FINANCE' },
  { email: 'designer@demo.local', firstName: 'Demo', lastName: 'Designer', roleCode: 'DESIGNER' },
  { email: 'design-manager@demo.local', firstName: 'Design', lastName: 'Manager', roleCode: 'DESIGN_MANAGER' },
  { email: 'pattern@demo.local', firstName: 'Pattern', lastName: 'Master', roleCode: 'PATTERN_MASTER' },
  { email: 'sampling@demo.local', firstName: 'Sampling', lastName: 'Team', roleCode: 'SAMPLING_TEAM' },
  { email: 'planner@demo.local', firstName: 'Production', lastName: 'Planner', roleCode: 'PRODUCTION_PLANNER' },
  { email: 'production-manager@demo.local', firstName: 'Production', lastName: 'Manager', roleCode: 'PRODUCTION_MANAGER' },
  { email: 'storekeeper@demo.local', firstName: 'Store', lastName: 'Keeper', roleCode: 'STORE_KEEPER' },
  { email: 'purchase@demo.local', firstName: 'Purchase', lastName: 'Manager', roleCode: 'PURCHASE_MANAGER' },
  { email: 'warehouse@demo.local', firstName: 'Warehouse', lastName: 'Manager', roleCode: 'WAREHOUSE_MANAGER' },
  { email: 'inventory@demo.local', firstName: 'Inventory', lastName: 'Manager', roleCode: 'INVENTORY_MANAGER' },
  { email: 'qc@demo.local', firstName: 'Quality', lastName: 'Inspector', roleCode: 'QUALITY_INSPECTOR' },
  { email: 'operator@demo.local', firstName: 'Machine', lastName: 'Operator', roleCode: 'MACHINE_OPERATOR' },
  { email: 'auditor@demo.local', firstName: 'Demo', lastName: 'Auditor', roleCode: 'AUDITOR' },
];

export const DEMO_ROLE_PASSWORD = 'Demo@123';

export const DEMO_CREDENTIALS_SUMMARY = [
  { email: 'superadmin@erp.local', password: 'SuperAdmin@123', role: 'Super Admin' },
  ...DEMO_USERS.map((u) => ({
    email: u.email,
    password: u.password || DEMO_ROLE_PASSWORD,
    role: SYSTEM_ROLES.find((r) => r.code === u.roleCode)?.name || u.roleCode,
  })),
];
