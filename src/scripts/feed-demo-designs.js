/**
 * Create demo designs parked before RELEASED so admin can test review + release.
 * Usage: node src/scripts/feed-demo-designs.js
 */
import mongoose from 'mongoose';
import { connectDatabase } from '../config/database.js';
import { Organization } from '../modules/organization/organization.model.js';
import { Factory } from '../modules/organization/factory.model.js';
import { User } from '../modules/user/user.model.js';
import { Design } from '../modules/design/design.model.js';
import {
  createDesign,
  submitDesign,
  approveDesign,
  requestRevision,
  uploadDesignAsset,
} from '../modules/design/design.service.js';
import { TINY_PNG, MATRIX_SIZE_LABELS, matrixSizeChartData } from './seed/seedHelpers.js';

const TEMPLATES = [
  {
    title: 'Classic Oxford Shirt',
    targetStatus: 'APPROVED',
    category: 'SHIRT',
    gender: 'MEN',
    fit: 'REGULAR',
    styleNumber: 'DEMO-OXF-01',
    collectionCode: 'SS26',
    seasonCode: 'SUMMER',
    targetPrice: 1299,
  },
  {
    title: 'Women Wrap Dress',
    targetStatus: 'APPROVED',
    category: 'DRESS',
    gender: 'WOMEN',
    fit: 'REGULAR',
    styleNumber: 'DEMO-WRP-02',
    collectionCode: 'SS26',
    seasonCode: 'SUMMER',
    targetPrice: 1899,
  },
  {
    title: 'Slim Denim Jacket',
    targetStatus: 'APPROVED',
    category: 'JACKET',
    gender: 'UNISEX',
    fit: 'SLIM',
    styleNumber: 'DEMO-DNM-03',
    collectionCode: 'AW26',
    seasonCode: 'AUTUMN',
    targetPrice: 2499,
  },
  {
    title: 'Linen Drawstring Trousers',
    targetStatus: 'APPROVED',
    category: 'TROUSER',
    gender: 'MEN',
    fit: 'REGULAR',
    styleNumber: 'DEMO-LIN-04',
    collectionCode: 'SS26',
    seasonCode: 'SUMMER',
    targetPrice: 1599,
  },
  {
    title: 'Printed Resort Shirt',
    targetStatus: 'IN_REVIEW',
    category: 'SHIRT',
    gender: 'MEN',
    fit: 'REGULAR',
    styleNumber: 'DEMO-RST-05',
    collectionCode: 'HOL',
    seasonCode: 'RESORT',
    targetPrice: 999,
  },
  {
    title: 'Kids Graphic Hoodie',
    targetStatus: 'IN_REVIEW',
    category: 'TOP',
    gender: 'KIDS',
    fit: 'REGULAR',
    styleNumber: 'DEMO-HOOD-06',
    collectionCode: 'CORE',
    seasonCode: 'WINTER',
    targetPrice: 799,
  },
  {
    title: 'Utility Cargo Shorts',
    targetStatus: 'DRAFT',
    category: 'SHORTS',
    gender: 'MEN',
    fit: 'REGULAR',
    styleNumber: 'DEMO-CRG-07',
    collectionCode: 'ESS',
    seasonCode: 'SUMMER',
    targetPrice: 899,
  },
  {
    title: 'Ribbed Tank Top',
    targetStatus: 'DRAFT',
    category: 'TOP',
    gender: 'WOMEN',
    fit: 'SLIM',
    styleNumber: 'DEMO-TNK-08',
    collectionCode: 'SS26',
    seasonCode: 'SUMMER',
    targetPrice: 499,
  },
  {
    title: 'Formal Navy Blazer',
    targetStatus: 'REVISION_REQUESTED',
    category: 'JACKET',
    gender: 'MEN',
    fit: 'SLIM',
    styleNumber: 'DEMO-BLZ-09',
    collectionCode: 'AW26',
    seasonCode: 'WINTER',
    targetPrice: 3499,
  },
];

const RANK = {
  DRAFT: 0,
  REVISION_REQUESTED: 1,
  SUBMITTED: 2,
  IN_REVIEW: 2,
  APPROVED: 3,
  RELEASED: 4,
  REJECTED: 1,
};

function payloadFor(template, org, factory) {
  return {
    factoryId: factory._id,
    organizationId: org._id,
    title: template.title,
    description: `${template.title} — demo design for review / release`,
    skuPrefix: template.styleNumber.replace(/[^A-Z0-9]/gi, '').slice(0, 6).toUpperCase(),
    styleNumber: template.styleNumber,
    category: template.category,
    gender: template.gender,
    ageGroup: template.gender === 'KIDS' ? 'KIDS' : 'ADULT',
    fit: template.fit,
    collectionCode: template.collectionCode,
    seasonCode: template.seasonCode,
    sizeChartData: matrixSizeChartData(),
    targetPrice: template.targetPrice,
    currency: 'INR',
    tags: [template.collectionCode, template.seasonCode],
    colorVariants: [
      { name: 'Navy', pantoneCode: '19-4052', hexCode: '#1a237e', code: 'NVY', status: 'PENDING' },
      { name: 'White', pantoneCode: '11-0601', hexCode: '#ffffff', code: 'WHT', status: 'PENDING' },
    ].map((c) => ({
      ...c,
      sizes: MATRIX_SIZE_LABELS.map((size) => ({ size, quantity: 0 })),
    })),
    productSpecs: { material: 'Cotton' },
  };
}

async function ensureAsset(designId, title, userId) {
  const { DesignAsset } = await import('../modules/design/designAsset.model.js');
  const hasImage = await DesignAsset.countDocuments({
    designId,
    assetType: { $in: ['FRONT_IMAGE', 'IMAGE', 'SKETCH', 'TECHNICAL_SKETCH'] },
    isDeleted: false,
  });
  if (hasImage) return;
  await uploadDesignAsset(designId, {
    fileName: `${title.replace(/\s+/g, '-').toLowerCase()}.png`,
    mimeType: 'image/png',
    contentBase64: TINY_PNG,
    assetType: 'FRONT_IMAGE',
  }, userId);
}

async function advanceTo(design, targetStatus, designer, manager) {
  if (design.status === 'RELEASED') return design;
  if ((RANK[design.status] ?? 0) >= (RANK[targetStatus] ?? 0)) return design;

  if (['IN_REVIEW', 'APPROVED', 'REVISION_REQUESTED'].includes(targetStatus)
    && ['DRAFT', 'REVISION_REQUESTED'].includes(design.status)) {
    await submitDesign(design._id, designer._id);
    design = await Design.findById(design._id);
  }
  if (targetStatus === 'REVISION_REQUESTED' && ['SUBMITTED', 'IN_REVIEW'].includes(design.status)) {
    await requestRevision(design._id, manager._id, 'Demo: adjust collar and hem before approval.');
    design = await Design.findById(design._id);
  }
  if (targetStatus === 'APPROVED' && ['SUBMITTED', 'IN_REVIEW'].includes(design.status)) {
    await approveDesign(design._id, manager._id);
    design = await Design.findById(design._id);
  }
  return design;
}

async function feed() {
  await connectDatabase();

  const org = await Organization.findOne({ code: 'DEMO' });
  if (!org) throw new Error('Organization DEMO not found — run npm run seed:rbac first');
  const factory = await Factory.findOne({ organizationId: org._id, code: 'F01' });
  if (!factory) throw new Error('Factory F01 not found — run npm run seed:rbac first');

  const designer = await User.findOne({ email: 'designer@demo.local', isDeleted: { $ne: true } })
    || await User.findOne({ email: 'admin@demo.local', isDeleted: { $ne: true } });
  const manager = await User.findOne({ email: 'design-manager@demo.local', isDeleted: { $ne: true } })
    || await User.findOne({ email: 'admin@demo.local', isDeleted: { $ne: true } });
  if (!designer || !manager) throw new Error('Demo designer / admin users missing — run npm run seed:rbac first');

  const rows = [];
  for (const template of TEMPLATES) {
    let design = await Design.findOne({
      factoryId: factory._id,
      title: template.title,
      isDeleted: { $ne: true },
    });
    let action = 'updated';
    if (!design) {
      design = await createDesign(payloadFor(template, org, factory), designer._id);
      action = 'created';
    }
    if (design.status !== 'RELEASED') {
      await ensureAsset(design._id, template.title, designer._id);
      design = await advanceTo(design, template.targetStatus, designer, manager);
    }
    rows.push({
      action,
      code: design.designCode,
      title: design.title,
      status: design.status,
    });
  }

  console.log(`Fed ${rows.length} demo designs (none released):\n`);
  for (const r of rows) {
    console.log(`  ${r.code.padEnd(16)} ${r.status.padEnd(20)} ${r.title}  [${r.action}]`);
  }

  const counts = await Design.aggregate([
    { $match: { factoryId: factory._id, isDeleted: { $ne: true } } },
    { $group: { _id: '$status', n: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);
  console.log('\nFactory totals:');
  for (const c of counts) console.log(`  ${c._id.padEnd(20)} ${c.n}`);

  await mongoose.disconnect();
}

feed().catch((err) => {
  console.error(err);
  process.exit(1);
});
