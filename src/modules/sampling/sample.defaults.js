/** Industry sample types — proto through shipment reference. */
export const SAMPLE_TYPE_LIST = [
  'PROTOTYPE',
  'FIT',
  'SIZE_SET',
  'SALESMAN',
  'PHOTO',
  'PP',
  'TOP',
  'SHIPMENT',
];

export const SAMPLE_TYPE_LABELS = {
  PROTOTYPE: 'Proto sample',
  FIT: 'Fit sample',
  SIZE_SET: 'Size set sample',
  SALESMAN: 'Salesman sample',
  PHOTO: 'Photo sample',
  PP: 'Pre-production (PP)',
  TOP: 'TOP sample',
  SHIPMENT: 'Shipment sample',
};

/** Sample types that require a fit trial after QC before buyer approval. */
export const SAMPLE_TYPES_NEEDING_FIT_TRIAL = [
  'PROTOTYPE', 'FIT', 'SIZE_SET', 'SALESMAN', 'PHOTO',
];

export function sampleNeedsFitTrial(sampleType) {
  return SAMPLE_TYPES_NEEDING_FIT_TRIAL.includes(sampleType);
}

export const SAMPLE_STATUS_LIST = [
  'CREATED',
  'REVISION_REQUESTED',
  'MATERIAL_REQUEST_PENDING',
  'MATERIAL_REQUEST_APPROVED',
  'MATERIAL_RESERVED',
  'CUTTING',
  'IN_PROGRESS',
  'QC_PENDING',
  'QC_FAILED',
  'FIT_TRIAL',
  'PENDING_APPROVAL',
  'QC_PASSED',
  'APPROVED',
  'REJECTED',
];

export const SAMPLE_TERMINAL_STATUSES = ['APPROVED', 'REJECTED'];

/** Industry workflow phases (post pattern-development). */
export const SAMPLE_WORKFLOW_PHASES = [
  { id: 'brief', label: 'Tech pack & brief', statuses: ['CREATED', 'REVISION_REQUESTED'] },
  { id: 'materials', label: 'Fabric & trims', statuses: ['MATERIAL_REQUEST_PENDING', 'MATERIAL_REQUEST_APPROVED', 'MATERIAL_RESERVED'] },
  { id: 'cutting', label: 'Cutting', statuses: ['CUTTING'] },
  { id: 'stitching', label: 'Sample stitching', statuses: ['IN_PROGRESS'] },
  { id: 'qc', label: 'Quality inspection', statuses: ['QC_PENDING', 'QC_FAILED'] },
  { id: 'fit', label: 'Fit trial', statuses: ['FIT_TRIAL'] },
  { id: 'approval', label: 'Buyer approval', statuses: ['PENDING_APPROVAL', 'QC_PASSED'] },
  { id: 'done', label: 'Complete', statuses: ['APPROVED', 'REJECTED'] },
];

export const SAMPLE_STATUS_LABELS = {
  CREATED: 'Tech pack received',
  REVISION_REQUESTED: 'Revision requested',
  MATERIAL_REQUEST_PENDING: 'Trims approval pending',
  MATERIAL_REQUEST_APPROVED: 'Trims approved',
  MATERIAL_RESERVED: 'Fabric reserved',
  CUTTING: 'Cutting in progress',
  IN_PROGRESS: 'Sample stitching',
  QC_PENDING: 'Quality inspection',
  QC_FAILED: 'QC failed',
  FIT_TRIAL: 'Fit trial',
  PENDING_APPROVAL: 'Buyer review',
  QC_PASSED: 'QC passed',
  APPROVED: 'Buyer approved',
  REJECTED: 'Rejected',
};
