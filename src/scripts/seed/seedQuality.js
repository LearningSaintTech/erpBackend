import { DefectCategory } from '../../modules/quality/defectCategory.model.js';
import { InspectionTemplate } from '../../modules/quality/inspectionTemplate.model.js';
import { CapaRecord } from '../../modules/quality/capaRecord.model.js';
import { QualityInspection } from '../../modules/quality/qualityInspection.model.js';
import { loadSeedJson, isHeavy, isConditionsSeed, isFixtureSeed, seedLimit, safeSeed } from './seedHelpers.js';

async function seedDefectCategories(ctx) {
  const { org, factory, admin } = ctx;
  const qualityExt = await import('../../modules/quality/qualityExtended.service.js');
  const rows = loadSeedJson('defectCategories.seed.json');
  const limit = seedLimit({ heavy: rows.length, conditions: 5, light: 1 });

  ctx.defectCategories = [];
  for (const row of rows.slice(0, limit)) {
    let cat = await DefectCategory.findOne({ factoryId: factory._id, code: row.code });
    if (!cat) {
      cat = await qualityExt.createDefectCategory({
        organizationId: org._id,
        factoryId: factory._id,
        ...row,
      }, admin._id);
    }
    ctx.defectCategories.push(cat);
  }
  console.log(`Seeded ${ctx.defectCategories.length} defect categories`);
}

async function seedInspectionTemplates(ctx) {
  const { org, factory, admin } = ctx;
  const qualityExt = await import('../../modules/quality/qualityExtended.service.js');
  const templates = [
    { name: 'Final Garment Inspection', inspectionType: 'FINAL', checklist: [
      { item: 'Seam strength', required: true },
      { item: 'Color consistency', required: true },
      { item: 'Button attachment', required: false },
    ]},
    { name: 'In-Process Stitch Check', inspectionType: 'IN_PROCESS', checklist: [
      { item: 'Stitch density', required: true },
      { item: 'Needle marks', required: false },
    ]},
    { name: 'Incoming Material QC', inspectionType: 'INCOMING', checklist: [
      { item: 'GSM check', required: true },
      { item: 'Width verification', required: true },
    ]},
  ];
  const limit = seedLimit({ heavy: templates.length, conditions: templates.length, light: 1 });

  for (const spec of templates.slice(0, limit)) {
    const exists = await InspectionTemplate.findOne({ factoryId: factory._id, name: spec.name });
    if (!exists) {
      await qualityExt.createInspectionTemplate({
        organizationId: org._id,
        factoryId: factory._id,
        ...spec,
      }, admin._id);
    }
  }
  console.log(`Seeded ${limit} inspection templates`);
}

async function seedCapaRecords(ctx) {
  const { factory, org, admin } = ctx;
  const qualityExt = await import('../../modules/quality/qualityExtended.service.js');
  const specs = [
    { type: 'CORRECTIVE', description: 'Demo CAPA — address recurring stitch defects on Line 01', rootCause: 'Needle tension not calibrated', actionPlan: 'Weekly machine calibration checklist' },
    { type: 'PREVENTIVE', description: 'Prevent color shade variation on navy styles', rootCause: 'Dye lot mixing', actionPlan: 'Single dye lot per PO' },
    { type: 'CORRECTIVE', description: 'Reduce button detachment complaints', rootCause: 'Incorrect thread tension', actionPlan: 'Button attach SOP refresh' },
    { type: 'PREVENTIVE', description: 'Measurement drift on size L', rootCause: 'Pattern grading error', actionPlan: 'Re-verify grade rules' },
  ];
  const limit = seedLimit({ heavy: specs.length, conditions: 2, light: 1 });

  for (const spec of specs.slice(0, limit)) {
    const exists = await CapaRecord.findOne({ factoryId: factory._id, description: spec.description });
    if (!exists) {
      await qualityExt.createCapa({
        factoryId: factory._id,
        organizationId: org._id,
        ...spec,
      }, admin._id);
    }
  }
  console.log(`Seeded ${limit} CAPA records`);
}

async function seedDefectsOnInspections(ctx) {
  if (!isFixtureSeed() || !ctx.defectCategories.length) return;
  const qualityExt = await import('../../modules/quality/qualityExtended.service.js');
  const qualityService = await import('../../modules/quality/quality.service.js');
  const { factory, admin } = ctx;

  const inProgressBatch = await import('../../modules/production/productionBatch.model.js')
    .then((m) => m.ProductionBatch.findOne({ factoryId: factory._id, status: 'IN_PROGRESS', isDeleted: false }));

  let created = 0;
  if (inProgressBatch) {
    const inQc = await safeSeed('defect-inprocess-qc', () => qualityExt.createInProcessInspection(inProgressBatch._id, admin._id));
    if (inQc) {
      for (let i = 0; i < 6 && created < 12; i += 1) {
        const cat = ctx.defectCategories[i % ctx.defectCategories.length];
        await safeSeed(`defect-inprocess-${i}`, () => qualityExt.recordDefect({
          inspectionId: inQc._id,
          categoryId: cat._id,
          description: `Seeded in-process defect — ${cat.name}`,
          quantity: i + 1,
          severity: cat.severity,
        }, admin._id, factory._id));
        created += 1;
      }
      await qualityService.completeInspection(inQc._id, {
        passedQuantity: inProgressBatch.plannedQuantity - 2,
        failedQuantity: 2,
        result: 'PARTIAL',
      }, admin._id, factory._id);
    }
  }

  const partialInspection = await QualityInspection.findOne({
    factoryId: factory._id,
    status: 'IN_PROGRESS',
    isDeleted: false,
  });
  if (partialInspection && created < 12) {
    for (let i = 0; i < 6 && created < 12; i += 1) {
      const cat = ctx.defectCategories[(i + 3) % ctx.defectCategories.length];
      await safeSeed(`defect-partial-${i}`, () => qualityExt.recordDefect({
        inspectionId: partialInspection._id,
        categoryId: cat._id,
        description: `Seeded defect — ${cat.name}`,
        quantity: 1,
        severity: cat.severity,
      }, admin._id, factory._id));
      created += 1;
    }
  }

  console.log(`Seeded ${created} defects on inspections`);
}

export async function seedQuality(ctx) {
  await seedDefectCategories(ctx);
  await seedInspectionTemplates(ctx);
  await seedCapaRecords(ctx);
  await seedDefectsOnInspections(ctx);
  return ctx;
}
