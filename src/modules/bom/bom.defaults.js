export const BOM_STATUS_LIST = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'ACTIVE', 'OBSOLETE'];

export const BOM_EDITABLE_STATUSES = ['DRAFT'];

export const BOM_APPROVABLE_STATUSES = ['DRAFT', 'PENDING_APPROVAL'];

/** While one of these exists for a SKU, a new BOM version would fork the open work. */
export const BOM_OPEN_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'];
