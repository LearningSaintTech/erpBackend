import mongoose from 'mongoose';
import { tenantFields, auditFields } from '../../shared/utils/schema.js';
import {
  DESIGN_CATEGORIES, DESIGN_FITS, DESIGN_GENDERS, DESIGN_AGE_GROUPS,
  ACCESSORY_TYPES, COLOR_VARIANT_STATUSES, PRODUCTION_PRIORITIES,
} from '../../config/designLookups.js';

const designCollectionSchema = new mongoose.Schema({
  ...tenantFields,
  name: { type: String, required: true },
  description: String,
  seasonId: { type: mongoose.Schema.Types.ObjectId, ref: 'Season' },
  status: { type: String, enum: ['ACTIVE', 'ARCHIVED'], default: 'ACTIVE' },
  ...auditFields,
});

export const DesignCollection = mongoose.model('DesignCollection', designCollectionSchema);

const productSpecsSchema = {
  material: String,
  fabricGsm: Number,
  fabricWidth: String,
  fabricFinish: String,
  shrinkagePercent: Number,
  printingType: String,
  embroidery: { type: Boolean, default: false },
  washCare: String,
  ironing: String,
};

const colorVariantSchema = {
  name: String,
  pantoneCode: String,
  hexCode: String,
  code: String,
  fabricDyeCode: String,
  supplierShade: String,
  status: { type: String, enum: COLOR_VARIANT_STATUSES, default: 'PENDING' },
  frontImageAssetId: { type: mongoose.Schema.Types.ObjectId, ref: 'DesignAsset' },
  backImageAssetId: { type: mongoose.Schema.Types.ObjectId, ref: 'DesignAsset' },
  availableQty: Number,
  skuCodeInputs: { colour: String },
  sizes: [{ size: String, sku: String }],
};

const fabricConsumptionSchema = {
  materialId: { type: mongoose.Schema.Types.ObjectId, ref: 'Material' },
  color: String,
  gsm: Number,
  consumption: { type: Number, default: 0 },
  unit: String,
  wastagePercent: { type: Number, default: 0 },
  supplierName: String,
  fabricCost: { type: Number, default: 0 },
  leadTimeDays: Number,
  minOrderQty: Number,
  approvedVendor: { type: Boolean, default: false },
};

const accessorySchema = {
  accessoryType: { type: String, enum: ACCESSORY_TYPES },
  materialId: { type: mongoose.Schema.Types.ObjectId, ref: 'Material' },
  color: String,
  size: String,
  supplierName: String,
  consumption: { type: Number, default: 1 },
  unit: String,
  unitCost: { type: Number, default: 0 },
  approved: { type: Boolean, default: false },
  quantity: Number, // legacy
};

const sizeChartDataSchema = {
  unit: { type: String, default: 'INCHES' },
  sizeLabels: [{ type: String }],
  rows: [{
    measurementName: String,
    values: { type: Map, of: Number },
  }],
};

const bomLineSchema = {
  materialId: { type: mongoose.Schema.Types.ObjectId, ref: 'Material' },
  materialName: String,
  quantity: { type: Number, default: 0 },
  unit: String,
  category: String,
  notes: String,
};

const costingSchema = {
  fabricCost: { type: Number, default: 0 },
  accessoriesCost: { type: Number, default: 0 },
  printingCost: { type: Number, default: 0 },
  embroideryCost: { type: Number, default: 0 },
  laborCost: { type: Number, default: 0 },
  packingCost: { type: Number, default: 0 },
  overhead: { type: Number, default: 0 },
  profitPercent: { type: Number, default: 0 },
  expectedSellingPrice: { type: Number, default: 0 },
  actualCost: { type: Number, default: 0 },
  margin: { type: Number, default: 0 },
};

const productionInfoSchema = {
  sampleRequired: { type: Boolean, default: false },
  sampleDeadline: Date,
  productionLineId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductionLine' },
  expectedProductionQty: Number,
  productionPriority: { type: String, enum: PRODUCTION_PRIORITIES, default: 'NORMAL' },
  remarks: String,
};

const qualityNotesSchema = {
  allowedDefects: String,
  colorTolerance: String,
  shrinkagePercent: Number,
  measurementTolerance: String,
  checklist: [{ item: String, required: { type: Boolean, default: true } }],
};

const manufacturingNotesSchema = {
  specialStitch: String,
  needleType: String,
  machineType: String,
  threadColor: String,
  packingInstructions: String,
  foldingInstructions: String,
  ironInstructions: String,
  barcodePosition: String,
  labelPosition: String,
};

const designSchema = new mongoose.Schema({
  ...tenantFields,
  designCode: { type: String, required: true },
  skuPrefix: String,
  styleNumber: String,
  skuCodeInputs: {
    styleNu: String,
    gender: String,
    styleGender: String,
    productType: String,
    productTypeCode: String,
    fitType: String,
    collectionId: { type: mongoose.Schema.Types.ObjectId, ref: 'DesignCollection' },
  },
  title: { type: String, required: true },
  description: String,
  category: { type: String, enum: DESIGN_CATEGORIES },
  subCategory: String,
  gender: { type: String, enum: DESIGN_GENDERS },
  ageGroup: { type: String, enum: DESIGN_AGE_GROUPS },
  fit: { type: String, enum: DESIGN_FITS },
  sleeveType: String,
  neckType: String,
  pattern: String,
  occasion: String,
  tags: [{ type: String }],
  collectionId: { type: mongoose.Schema.Types.ObjectId, ref: 'DesignCollection' },
  seasonId: { type: mongoose.Schema.Types.ObjectId, ref: 'Season' },
  sizeChartId: { type: mongoose.Schema.Types.ObjectId, ref: 'SizeChart' },
  sizeChartData: sizeChartDataSchema,
  targetPrice: { type: Number, min: 0 },
  currency: { type: String, default: 'INR' },
  productSpecs: productSpecsSchema,
  colorVariants: [colorVariantSchema],
  fabricConsumption: [fabricConsumptionSchema],
  fabricSuggestions: [{
    materialId: { type: mongoose.Schema.Types.ObjectId, ref: 'Material' },
    quantityPerPiece: { type: Number, default: 1 },
    unit: String,
    notes: String,
  }],
  accessories: [accessorySchema],
  bomLines: [bomLineSchema],
  costing: costingSchema,
  productionInfo: productionInfoSchema,
  qualityNotes: qualityNotesSchema,
  manufacturingNotes: manufacturingNotesSchema,
  currentVersion: { type: Number, default: 1 },
  status: {
    type: String,
    enum: ['DRAFT', 'SUBMITTED', 'IN_REVIEW', 'APPROVED', 'RELEASED', 'REJECTED', 'REVISION_REQUESTED'],
    default: 'DRAFT',
  },
  submittedAt: Date,
  approvedAt: Date,
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  releasedAt: Date,
  releasedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  releasedVersion: Number,
  rejectionComments: String,
  revisionComments: String,
  ...auditFields,
});

designSchema.index({ factoryId: 1, designCode: 1 }, { unique: true });
designSchema.index({ factoryId: 1, status: 1 });
designSchema.index({ factoryId: 1, category: 1 });
designSchema.index({ tags: 1 });
// Uniqueness only when style number is set — drafts may omit it until merchandising assigns one.
designSchema.index(
  { factoryId: 1, collectionId: 1, styleNumber: 1 },
  {
    unique: true,
    partialFilterExpression: {
      styleNumber: { $exists: true, $type: 'string', $gt: '' },
    },
  },
);

/** Drop legacy sparse index (null styleNumber collisions) and sync current definitions. */
export async function ensureDesignIndexes() {
  const coll = Design.collection;
  try {
    const indexes = await coll.indexes();
    const legacy = indexes.find(
      (idx) => idx.name === 'factoryId_1_collectionId_1_styleNumber_1'
        && !idx.partialFilterExpression,
    );
    if (legacy) {
      await coll.dropIndex('factoryId_1_collectionId_1_styleNumber_1');
      console.log('Dropped legacy design styleNumber index');
    }
  } catch {
    // index may not exist on fresh DB
  }
  await Design.syncIndexes();
}

export const Design = mongoose.model('Design', designSchema);
