import { Permission } from '../user/permission.model.js';
import { Role } from '../user/role.model.js';
import { ApprovalWorkflow } from '../approval/approvalWorkflow.model.js';
import { PurchaseOrder } from './purchaseOrder.model.js';
import { getFactoryAdminPermissions } from '../../config/systemRoles.js';

const PR_LEVELS = [
  { level: 1, approverRoles: ['purchase.authorize'], approvalType: 'ANY', slaHours: 24 },
];

/**
 * Align live factories to phone-supplier purchase: admin-only PR, payments, finance mark-paid.
 */
export async function ensurePurchaseProcess() {
  await Permission.updateOne(
    { code: 'purchase.authorize' },
    { module: 'purchase', action: 'authorize', description: 'Approve purchase requisitions (Factory Admin / Super Admin)' },
    { upsert: true },
  );
  await Permission.updateOne(
    { code: 'purchase.pay' },
    { module: 'purchase', action: 'pay', description: 'Mark payments paid after the supplier invoice is uploaded' },
    { upsert: true },
  );

  const factoryAdminPerms = getFactoryAdminPermissions();
  await Role.updateMany(
    { code: 'FACTORY_ADMIN', isSystem: true },
    { $set: { permissions: factoryAdminPerms } },
  );
  await Role.updateMany(
    { code: 'SUB_ADMIN_FINANCE' },
    { $addToSet: { permissions: 'purchase.pay' } },
  );
  await Role.updateMany(
    { code: 'FACTORY_ADMIN' },
    { $addToSet: { permissions: { $each: ['purchase.authorize', 'purchase.pay'] } } },
  );

  // Runs on every boot, so it must be idempotent: only upgrade legacy PR workflows that have
  // no approver roles configured. Admin-configured workflows (and in-flight approvals at
  // level 2+) are left alone.
  const wfResult = await ApprovalWorkflow.updateMany(
    {
      documentType: 'PURCHASE_REQUISITION',
      isActive: true,
      levels: { $not: { $elemMatch: { 'approverRoles.0': { $exists: true } } } },
    },
    {
      $set: {
        name: 'Purchase Requisition Approval',
        levels: PR_LEVELS,
      },
    },
  );

  const unpaidResult = await PurchaseOrder.updateMany(
    { $or: [{ paymentStatus: { $exists: false } }, { paymentStatus: null }] },
    { $set: { paymentStatus: 'UNPAID' } },
  );

  const changed = (wfResult.modifiedCount || 0) + (unpaidResult.modifiedCount || 0);
  return changed;
}
