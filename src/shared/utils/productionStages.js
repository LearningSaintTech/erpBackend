import { FactorySettings } from '../../modules/organization/factorySettings.model.js';

const DEFAULT_STAGES = ['CUTTING', 'PRINTING', 'EMBROIDERY', 'STITCHING', 'WASHING', 'IRONING', 'FINISHING'];

const QC_GATED_STAGES = new Set(['CUTTING', 'SEWING', 'STITCHING', 'FINISHING', 'PACKING']);

export async function getBatchStages(factoryId) {
  const settings = await FactorySettings.findOne({ factoryId });
  const base = settings?.productionStages?.length ? [...settings.productionStages] : [...DEFAULT_STAGES];
  const stages = [...base];
  if (!stages.includes('PACKING')) stages.push('PACKING');
  if (!stages.includes('QC')) stages.push('QC');
  if (!stages.includes('COMPLETED')) stages.push('COMPLETED');
  return stages;
}

export function isQcGatedStage(stage) {
  return QC_GATED_STAGES.has(stage) || stage === 'PACKING';
}

export function normalizeStageName(stage) {
  if (stage === 'SEWING') return 'STITCHING';
  return stage;
}
