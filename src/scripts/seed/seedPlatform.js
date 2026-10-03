import { FinancialYear } from '../../modules/organization/financialYear.model.js';
import { ApprovalWorkflow } from '../../modules/approval/approvalWorkflow.model.js';
import { Session } from '../../modules/auth/session.model.js';
import { Shift } from '../../modules/production/shift.model.js';
import { AuditLog } from '../../modules/audit/audit.model.js';
import { User } from '../../modules/user/user.model.js';
import { DEMO_USERS } from '../../config/systemRoles.js';
import { APPROVAL_DOCUMENT_TYPES, defaultApproverPermission } from '../../modules/approval/approval.defaults.js';
import { isHeavy, isConditionsSeed, isFixtureSeed, seedLimit, logAudit, safeSeed } from './seedHelpers.js';

async function seedFinancialYear(ctx) {
  const { org } = ctx;
  let fy = await FinancialYear.findOne({ organizationId: org._id, isActive: true });
  if (!fy) {
    const { createFinancialYear } = await import('../../modules/organization/organization.service.js');
    fy = await createFinancialYear(org._id, {
      name: 'FY 2025-26',
      startDate: new Date('2025-04-01'),
      endDate: new Date('2026-03-31'),
      isActive: true,
    });
    org.activeFinancialYearId = fy._id;
    await org.save();
    console.log('Seeded financial year FY 2025-26');
  }
  return fy;
}

async function seedAppSettings(ctx) {
  const { org, factory, admin } = ctx;
  const settingsService = await import('../../modules/settings/settings.service.js');
  const categories = ['GENERAL', 'FEATURE_FLAGS', 'INTEGRATIONS'];

  for (const category of categories) {
    await safeSeed(`settings-${category}`, () => settingsService.updateSettings({
      organizationId: org._id,
      factoryId: category === 'INTEGRATIONS' ? null : factory._id,
      category,
      settings: category === 'FEATURE_FLAGS'
        ? { rfqModule: true, wasteTracking: true, advancedQuality: true }
        : category === 'GENERAL'
          ? { timezone: 'Asia/Kolkata', currency: 'INR' }
          : {},
    }, admin._id));
  }
  console.log('Seeded app settings');
}

async function seedPurchaseRequisitionWorkflow(ctx) {
  const { org, factory } = ctx;
  const { createWorkflow } = await import('../../modules/approval/approval.service.js');
  // Single level: Super Admin or Factory Admin (purchase.authorize)
  const levels = [
    { level: 1, approverRoles: ['purchase.authorize'], approvalType: 'ANY', slaHours: 24 },
  ];

  const exists = await ApprovalWorkflow.findOne({
    organizationId: org._id,
    factoryId: factory._id,
    documentType: 'PURCHASE_REQUISITION',
    isActive: true,
  });

  if (exists) {
    exists.name = 'Purchase Requisition Approval';
    exists.levels = levels;
    await exists.save();
    console.log('Updated PURCHASE_REQUISITION workflow → Factory Admin / Super Admin');
    return;
  }

  await safeSeed('workflow-PURCHASE_REQUISITION', () => createWorkflow({
    organizationId: org._id,
    factoryId: factory._id,
    name: 'Purchase Requisition Approval',
    documentType: 'PURCHASE_REQUISITION',
    levels,
    isActive: true,
  }));
  console.log('Seeded PURCHASE_REQUISITION Factory Admin workflow');
}

async function seedApprovalWorkflows(ctx) {
  const { org, factory } = ctx;
  const { createWorkflow } = await import('../../modules/approval/approval.service.js');
  const types = isHeavy() || isConditionsSeed()
    ? APPROVAL_DOCUMENT_TYPES.filter((t) => t !== 'PURCHASE_REQUISITION')
    : APPROVAL_DOCUMENT_TYPES.slice(0, 3).filter((t) => t !== 'PURCHASE_REQUISITION');

  for (const documentType of types) {
    const approverPerm = defaultApproverPermission(documentType);
    const exists = await ApprovalWorkflow.findOne({
      organizationId: org._id,
      factoryId: factory._id,
      documentType,
      isActive: true,
    });
    if (exists) {
      const level1 = exists.levels?.find((l) => l.level === 1);
      if (level1 && !level1.approverRoles?.includes(approverPerm)) {
        level1.approverRoles = [approverPerm];
        await exists.save();
        console.log(`Updated ${documentType} workflow approver → ${approverPerm}`);
      }
      continue;
    }

    await safeSeed(`workflow-${documentType}`, () => createWorkflow({
      organizationId: org._id,
      factoryId: factory._id,
      name: `${documentType.replace(/_/g, ' ')} Approval`,
      documentType,
      levels: [{
        level: 1,
        approverRoles: [approverPerm],
        approvalType: 'ANY',
        slaHours: 24,
      }],
      isActive: true,
    }));
  }

  await seedPurchaseRequisitionWorkflow(ctx);
  console.log(`Seeded approval workflows (${types.length} + PURCHASE_REQUISITION)`);
}

async function seedShifts(ctx) {
  if (!isFixtureSeed()) return;
  const { org, factory, admin } = ctx;
  const machineService = await import('../../modules/production/machine.service.js');
  const specs = [
    { name: 'Morning Shift', startTime: '06:00', endTime: '14:00' },
    { name: 'Afternoon Shift', startTime: '14:00', endTime: '22:00' },
    { name: 'Night Shift', startTime: '22:00', endTime: '06:00' },
  ];

  for (const spec of specs) {
    const exists = await Shift.findOne({ factoryId: factory._id, name: spec.name });
    if (!exists) {
      await machineService.createShift({
        organizationId: org._id,
        factoryId: factory._id,
        ...spec,
      }, admin._id);
    }
  }
  console.log('Seeded 3 shifts');
}

async function seedSessions(ctx) {
  const users = await User.find({
    $or: [
      { isSuperAdmin: true },
      { organizationId: ctx.org._id, email: { $in: DEMO_USERS.map((u) => u.email) } },
    ],
    status: 'ACTIVE',
  });

  let created = 0;
  for (const user of users) {
    const exists = await Session.findOne({ userId: user._id, isRevoked: false });
    if (exists) continue;

    const isRevoked = created < 2 && user.email === 'admin@demo.local';
    await Session.create({
      userId: user._id,
      refreshTokenHash: await User.hashPassword(`seed-session-${user.email}`),
      deviceInfo: { userAgent: 'Seed/1.0', platform: 'desktop' },
      ipAddress: '127.0.0.1',
      expiresAt: new Date(Date.now() + 30 * 86400000),
      isRevoked,
      lastActiveAt: new Date(),
    });
    created += 1;
  }
  console.log(`Seeded ${created} sessions`);
}

async function backfillAuditLogs(ctx) {
  const target = seedLimit({ heavy: 50, conditions: 15, light: 10 });
  const existing = await AuditLog.countDocuments({ factoryId: ctx.factory._id });
  const needed = Math.max(0, target - existing - (ctx.auditCount || 0));

  const actions = [
    { module: 'design', action: 'design.submit', documentType: 'Design' },
    { module: 'design', action: 'design.approve', documentType: 'Design' },
    { module: 'production', action: 'batch.start', documentType: 'ProductionBatch' },
    { module: 'production', action: 'batch.complete', documentType: 'ProductionBatch' },
    { module: 'purchase', action: 'po.create', documentType: 'PurchaseOrder' },
    { module: 'purchase', action: 'pr.approve', documentType: 'PurchaseRequisition' },
    { module: 'inventory', action: 'material.receipt', documentType: 'Material' },
    { module: 'quality', action: 'inspection.complete', documentType: 'QualityInspection' },
    { module: 'warehouse', action: 'putaway.complete', documentType: 'StorageBin' },
    { module: 'rbac', action: 'role.assign', documentType: 'UserRoleAssignment' },
  ];

  for (let i = 0; i < needed; i += 1) {
    const spec = actions[i % actions.length];
    await logAudit(ctx, {
      ...spec,
      documentId: ctx.admin._id,
      previousData: { status: 'DRAFT' },
      updatedData: { status: 'APPROVED' },
      metadata: { seed: true, index: i },
    });
  }

  const total = await AuditLog.countDocuments({ factoryId: ctx.factory._id });
  console.log(`Audit logs: ${total} total`);
}

export async function seedPlatform(ctx) {
  await seedFinancialYear(ctx);
  await seedAppSettings(ctx);
  await seedApprovalWorkflows(ctx);
  await seedShifts(ctx);
  await seedSessions(ctx);
  await backfillAuditLogs(ctx);
  return ctx;
}
