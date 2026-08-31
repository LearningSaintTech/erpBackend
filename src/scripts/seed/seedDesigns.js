import { Design, DesignCollection } from '../../modules/design/design.model.js';
import { Season } from '../../modules/design/season.model.js';
import { SizeChart } from '../../modules/design/sizeChart.model.js';
import { DesignAsset } from '../../modules/design/designAsset.model.js';
import {
  loadSeedJson,
  isHeavy,
  isConditionsSeed,
  isFixtureSeed,
  seedLimit,
  TINY_PNG,
  MATRIX_SIZE_LABELS,
  MATRIX_ROWS,
  matrixSizeChartData,
  colorVariantsWithSizes,
  logAudit,
  safeSeed,
} from './seedHelpers.js';

const COLLECTIONS = [
  { name: 'Essentials', description: 'Core apparel collection' },
  { name: 'Resort Wear', description: 'Vacation and resort styles' },
  { name: 'Urban Basics', description: 'Everyday urban essentials' },
  { name: 'Festive Edit', description: 'Seasonal festive collection' },
];

const SEASONS = [
  { name: 'Summer', year: 2026, startDate: '2026-03-01', endDate: '2026-08-31' },
  { name: 'Autumn Winter', year: 2026, startDate: '2026-09-01', endDate: '2027-02-28' },
  { name: 'Resort', year: 2027, startDate: '2027-01-01', endDate: '2027-04-30' },
];

const SIZE_CHARTS = [
  { name: 'Unisex Shirt', unit: 'INCHES', rows: MATRIX_ROWS },
  {
    name: 'Men Kurta',
    unit: 'INCHES',
    rows: [
      { measurementName: 'Chest', values: new Map([['S', 38], ['M', 40], ['L', 42], ['XL', 44]]) },
      { measurementName: 'Length', values: new Map([['S', 40], ['M', 42], ['L', 44], ['XL', 46]]) },
    ],
    sizeLabels: ['S', 'M', 'L', 'XL'],
  },
  {
    name: 'Trouser Standard',
    unit: 'INCHES',
    rows: [
      { measurementName: 'Waist', values: new Map([['28', 28], ['30', 30], ['32', 32], ['34', 34]]) },
      { measurementName: 'Inseam', values: new Map([['28', 30], ['30', 31], ['32', 32], ['34', 33]]) },
    ],
    sizeLabels: ['28', '30', '32', '34'],
  },
];

async function seedCollections(ctx) {
  const { org, factory, admin } = ctx;
  ctx.collections = [];
  for (const spec of COLLECTIONS) {
    let col = await DesignCollection.findOne({ organizationId: org._id, name: spec.name });
    if (!col) {
      col = await DesignCollection.create({
        organizationId: org._id,
        factoryId: factory._id,
        name: spec.name,
        description: spec.description,
        status: 'ACTIVE',
        createdBy: admin._id,
        updatedBy: admin._id,
      });
    }
    ctx.collections.push(col);
  }
  console.log(`Seeded ${ctx.collections.length} design collections`);
}

async function seedSeasons(ctx) {
  const { org, factory, admin } = ctx;
  ctx.seasons = [];
  for (const spec of SEASONS) {
    let season = await Season.findOne({ organizationId: org._id, name: spec.name, year: spec.year });
    if (!season) {
      season = await Season.create({
        organizationId: org._id,
        factoryId: factory._id,
        name: spec.name,
        year: spec.year,
        startDate: new Date(spec.startDate),
        endDate: new Date(spec.endDate),
        status: 'ACTIVE',
        createdBy: admin._id,
        updatedBy: admin._id,
      });
    }
    ctx.seasons.push(season);
  }
  console.log(`Seeded ${ctx.seasons.length} seasons`);
}

async function seedSizeCharts(ctx) {
  const { org, factory, admin } = ctx;
  ctx.sizeCharts = [];
  for (const spec of SIZE_CHARTS) {
    const labels = spec.sizeLabels || MATRIX_SIZE_LABELS;
    let chart = await SizeChart.findOne({ factoryId: factory._id, name: spec.name });
    if (!chart) {
      chart = await SizeChart.create({
        organizationId: org._id,
        factoryId: factory._id,
        name: spec.name,
        unit: spec.unit,
        sizeLabels: labels,
        rows: spec.rows,
        status: 'ACTIVE',
        createdBy: admin._id,
        updatedBy: admin._id,
      });
    } else if (!chart.rows?.length) {
      chart.sizeLabels = labels;
      chart.rows = spec.rows;
      await chart.save();
    }
    ctx.sizeCharts.push(chart);
  }
  console.log(`Seeded ${ctx.sizeCharts.length} size charts`);
}

function buildDesignPayload(ctx, template, idx) {
  const { org, factory } = ctx;
  const collection = ctx.collections[idx % ctx.collections.length];
  const season = ctx.seasons[idx % ctx.seasons.length];
  const sizeChart = ctx.sizeCharts[idx % ctx.sizeCharts.length];
  const colors = [
    { name: 'Navy', pantoneCode: '19-4052', hexCode: '#1a237e', code: 'NVY', status: 'APPROVED' },
    { name: 'White', pantoneCode: '11-0601', hexCode: '#ffffff', code: 'WHT', status: 'APPROVED' },
  ];

  const payload = {
    factoryId: factory._id,
    organizationId: org._id,
    title: template.title,
    description: `${template.title} — seeded design`,
    skuPrefix: template.title.split(' ').map((w) => w[0]).join('').slice(0, 4).toUpperCase(),
    styleNumber: template.styleNumber || `STY-${String(idx + 1).padStart(4, '0')}`,
    category: template.category,
    subCategory: template.category,
    gender: template.gender,
    ageGroup: template.gender === 'KIDS' ? 'KIDS' : 'ADULT',
    fit: template.fit,
    collectionId: collection._id,
    seasonId: season._id,
    sizeChartId: sizeChart._id,
    sizeChartData: matrixSizeChartData(),
    targetPrice: template.targetPrice,
    currency: 'INR',
    tags: [season.name, template.category],
    colorVariants: template.flagship
      ? colorVariantsWithSizes(colors)
      : [{ name: 'Natural', hexCode: '#f5f5dc', code: 'NAT' }],
    productSpecs: {
      material: 'Cotton',
    },
  };

  // Consumption, trims, BOM, costing, quality, sewing notes and planning are seeded onto
  // the pattern development record instead — see seedProduction.seedPatternAndSample.

  if (template.flagship) {
    Object.assign(payload, {
      sleeveType: 'Full Sleeve',
      neckType: 'Spread Collar',
      pattern: 'Solid',
      occasion: 'Casual',
    });
  }

  return payload;
}

async function ensureDesignAsset(designId, title, userId) {
  const hasImage = await DesignAsset.countDocuments({
    designId,
    assetType: { $in: ['FRONT_IMAGE', 'IMAGE', 'SKETCH', 'TECHNICAL_SKETCH'] },
    isDeleted: false,
  });
  if (hasImage) return;
  const { uploadDesignAsset } = await import('../../modules/design/design.service.js');
  await uploadDesignAsset(designId, {
    fileName: `${title.replace(/\s+/g, '-').toLowerCase()}.png`,
    mimeType: 'image/png',
    contentBase64: TINY_PNG,
    assetType: 'FRONT_IMAGE',
  }, userId);
}

async function advanceDesignStatus(design, targetStatus, ctx) {
  const {
    submitDesign, approveDesign, releaseDesign,
  } = await import('../../modules/design/design.service.js');
  const designer = ctx.roleUsers.designer || ctx.admin;
  const manager = ctx.roleUsers.designManager || ctx.admin;
  const actor = designer;

  if (['SUBMITTED', 'APPROVED', 'RELEASED'].includes(targetStatus) && ['DRAFT', 'REVISION_REQUESTED'].includes(design.status)) {
    await submitDesign(design._id, actor._id);
    design = await Design.findById(design._id);
  }
  if (['APPROVED', 'RELEASED'].includes(targetStatus) && !['APPROVED', 'RELEASED'].includes(design.status)) {
    await approveDesign(design._id, manager._id);
    design = await Design.findById(design._id);
  }
  if (targetStatus === 'RELEASED' && design.status !== 'RELEASED') {
    await releaseDesign(design._id, manager._id);
    design = await Design.findById(design._id);
  }
  return design;
}

export async function seedDesigns(ctx) {
  const { factory, admin } = ctx;
  await seedCollections(ctx);
  await seedSeasons(ctx);
  await seedSizeCharts(ctx);

  const templates = loadSeedJson('designTemplates.seed.json');
  const limit = seedLimit({ heavy: templates.length, conditions: 6, light: 3 });
  const {
    createDesign, recomputeCosting,
  } = await import('../../modules/design/design.service.js');

  ctx.designs = [];
  ctx.demoDesign = null;

  for (let i = 0; i < limit; i += 1) {
    const template = templates[i];
    const creator = ctx.roleUsers.designer || admin;
    let design = await Design.findOne({ factoryId: factory._id, title: template.title });

    if (!design) {
      const payload = buildDesignPayload(ctx, template, i);
      design = await createDesign(payload, creator._id);
      console.log(`Seeded design: ${design.designCode} (${template.targetStatus})`);
      await logAudit(ctx, {
        module: 'design',
        action: 'design.create',
        documentType: 'Design',
        documentId: design._id,
        updatedData: { title: template.title, designCode: design.designCode },
      });
    } else if (template.flagship && !design.category) {
      Object.assign(design, buildDesignPayload(ctx, template, i));
      recomputeCosting(design);
      design.updatedBy = admin._id;
      await design.save();
    }

    await ensureDesignAsset(design._id, template.title, creator._id);
    design = await advanceDesignStatus(design, template.targetStatus, ctx);

    if (template.flagship) {
      ctx.demoDesign = design;
      const colors = [
        { name: 'Navy', pantoneCode: '19-4052', hexCode: '#1a237e', code: 'NVY', status: 'APPROVED' },
        { name: 'White', pantoneCode: '11-0601', hexCode: '#ffffff', code: 'WHT', status: 'APPROVED' },
      ];
      design.colorVariants = colorVariantsWithSizes(colors);
      design.updatedBy = admin._id;
      await design.save();
    }
    ctx.designs.push(design);
  }

  if (!ctx.demoDesign && ctx.designs.length) {
    ctx.demoDesign = ctx.designs.find((d) => d.status === 'RELEASED') || ctx.designs[0];
  }

  console.log(`Seeded ${ctx.designs.length} designs`);
  return ctx;
}
