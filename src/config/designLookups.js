export const DESIGN_CATEGORIES = ['SHIRT', 'KURTA', 'DRESS', 'JEANS', 'TROUSER', 'JACKET', 'SKIRT', 'TOP', 'OTHER'];
export const DESIGN_FITS = ['SLIM', 'REGULAR', 'OVERSIZED'];
export const DESIGN_GENDERS = ['MEN', 'WOMEN', 'UNISEX', 'BOYS', 'GIRLS', 'KIDS'];
export const DESIGN_AGE_GROUPS = ['INFANT', 'TODDLER', 'KIDS', 'TEEN', 'ADULT', 'SENIOR'];
export const ACCESSORY_TYPES = ['BUTTON', 'ZIPPER', 'ELASTIC', 'LABEL', 'HANGTAG', 'THREAD', 'RIVET', 'LACE', 'PATCH', 'PACKAGING', 'OTHER'];
export const COLOR_VARIANT_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'];
export const PRODUCTION_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
export const SAMPLE_TYPES = ['PROTOTYPE', 'FIT', 'PP', 'TOP'];
export const TAG_PRESETS = ['Summer', 'Premium', 'Cotton', 'Export', 'Kids', 'Formal', 'Casual', 'Winter', 'Eco', 'Limited'];

export const DESIGN_ASSET_TYPES = [
  'FRONT_IMAGE', 'BACK_IMAGE', 'SIDE_IMAGE', 'ZOOM_IMAGE', 'TECHNICAL_SKETCH',
  'CAD', 'AI', 'PSD', 'DXF', 'PDF_TECH_PACK', 'MEASUREMENT_SHEET',
  // legacy
  'IMAGE', 'SKETCH',
];

/** Slot types that allow only one active asset per design */
export const SINGLE_SLOT_ASSET_TYPES = [
  'FRONT_IMAGE', 'BACK_IMAGE', 'SIDE_IMAGE', 'ZOOM_IMAGE',
  'IMAGE', // legacy → FRONT_IMAGE
];

export function normalizeAssetType(assetType) {
  if (assetType === 'IMAGE') return 'FRONT_IMAGE';
  if (assetType === 'SKETCH') return 'TECHNICAL_SKETCH';
  return assetType;
}

export function getDesignLookups() {
  return {
    categories: DESIGN_CATEGORIES,
    fits: DESIGN_FITS,
    genders: DESIGN_GENDERS,
    ageGroups: DESIGN_AGE_GROUPS,
    accessoryTypes: ACCESSORY_TYPES,
    colorVariantStatuses: COLOR_VARIANT_STATUSES,
    productionPriorities: PRODUCTION_PRIORITIES,
    sampleTypes: SAMPLE_TYPES,
    tagPresets: TAG_PRESETS,
    assetTypes: DESIGN_ASSET_TYPES.filter((t) => !['IMAGE', 'SKETCH'].includes(t)),
  };
}
