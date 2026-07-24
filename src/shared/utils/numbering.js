import { NumberingSequence } from '../../modules/organization/numberingSequence.model.js';

export async function nextDocumentNumber(factoryId, documentType, prefix) {
  const seq = await NumberingSequence.findOneAndUpdate(
    { factoryId, documentType },
    { $inc: { currentValue: 1 }, $setOnInsert: { prefix, padding: 5 } },
    { upsert: true, new: true }
  );
  const num = String(seq.currentValue).padStart(seq.padding || 5, '0');
  return `${seq.prefix || prefix}${num}`;
}
