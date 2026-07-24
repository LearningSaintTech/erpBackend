import mongoose from 'mongoose';
import { auditFields } from '../../shared/utils/schema.js';

const numberingSequenceSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  factoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Factory', required: true },
  documentType: { type: String, required: true },
  prefix: { type: String, required: true },
  currentValue: { type: Number, default: 0 },
  padding: { type: Number, default: 5 },
});

numberingSequenceSchema.index({ factoryId: 1, documentType: 1 }, { unique: true });

export const NumberingSequence = mongoose.model('NumberingSequence', numberingSequenceSchema);
