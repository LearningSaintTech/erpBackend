export const APPROVAL_DOCUMENT_TYPES = [
  'DESIGN',
  'SAMPLE',
  'SAMPLE_MATERIAL',
  'PRODUCTION_ORDER',
  'PURCHASE_REQUISITION',
  'PURCHASE_ORDER',
  'BOM',
];

export const APPROVAL_STATUS_LIST = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CHANGES_REQUESTED',
  'OVERRIDDEN',
  'CANCELLED',
];

export const APPROVER_PERMISSION_OPTIONS = [
  { documentType: 'DESIGN', permission: 'design.approve', label: 'Design approver' },
  { documentType: 'SAMPLE', permission: 'sampling.approve', label: 'Sample approver' },
  { documentType: 'SAMPLE_MATERIAL', permission: 'sampling.approve', label: 'Sample material approver' },
  { documentType: 'PRODUCTION_ORDER', permission: 'production.approve', label: 'Production approver' },
  { documentType: 'PURCHASE_REQUISITION', permission: 'purchase.authorize', label: 'Factory Admin / Super Admin' },
  { documentType: 'PURCHASE_ORDER', permission: 'purchase.approve', label: 'Payment (purchase staff)' },
  { documentType: 'BOM', permission: 'bom.approve', label: 'BOM approver' },
  { documentType: '*', permission: 'approval.approve', label: 'General approval authority' },
];

export const DOCUMENT_TYPE_LABELS = Object.fromEntries(
  APPROVAL_DOCUMENT_TYPES.map((t) => [t, t.replace(/_/g, ' ')]),
);

export function defaultApproverPermission(documentType) {
  return APPROVER_PERMISSION_OPTIONS.find((o) => o.documentType === documentType)?.permission
    || 'approval.approve';
}

/** Permissions that may act on approval instances (route + level checks). */
export const ALL_DOCUMENT_APPROVE_PERMISSIONS = [
  ...new Set(APPROVER_PERMISSION_OPTIONS.map((o) => o.permission)),
];

export function approverPermissionLabel(permission) {
  return APPROVER_PERMISSION_OPTIONS.find((o) => o.permission === permission)?.label
    || permission.replace(/\./g, ' ');
}
