export const SKU_SEGMENT_CATALOG = [
  {
    key: 'styleGender',
    label: 'Style + gender',
    description: 'Combined style number and gender token (e.g. STY01M).',
    defaultOptional: false,
  },
  {
    key: 'productType',
    label: 'Product type',
    description: 'Category code from inventory codes or design SKU prefix.',
    defaultOptional: false,
  },
  {
    key: 'fitType',
    label: 'Fit type',
    description: 'Fit code resolved from design fit or FIT inventory codes.',
    defaultOptional: false,
  },
  {
    key: 'colour',
    label: 'Colour',
    description: 'Colour variant code from COLOR inventory codes.',
    defaultOptional: false,
  },
  {
    key: 'size',
    label: 'Size',
    description: 'Size label from the design size chart.',
    defaultOptional: false,
  },
  {
    key: 'skuUid',
    label: 'SKU UID',
    description: 'Optional unique suffix; excluded from sellable SKU display.',
    defaultOptional: true,
  },
];

export const SKU_SEGMENT_KEYS = SKU_SEGMENT_CATALOG.map((s) => s.key);
