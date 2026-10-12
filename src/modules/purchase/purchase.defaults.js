export const PR_STATUS_LIST = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CONVERTED', 'CANCELLED'];
export const PO_STATUS_LIST = ['DRAFT', 'APPROVED', 'SENT', 'PARTIAL', 'RECEIVED', 'CLOSED', 'CANCELLED'];
export const GRN_STATUS_LIST = ['DRAFT', 'PENDING_QC', 'COMPLETED', 'CANCELLED'];
export const SUPPLIER_STATUS_LIST = ['ACTIVE', 'INACTIVE'];
export const PAYMENT_STATUS_LIST = ['UNPAID', 'PAID'];

export const PO_OPEN_STATUSES = ['APPROVED', 'SENT', 'PARTIAL'];

/** PRs whose quantity is still expected to become stock (not yet a PO). */
export const PR_OPEN_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED'];
