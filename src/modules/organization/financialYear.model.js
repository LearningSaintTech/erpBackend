import mongoose from 'mongoose';
import { auditFields } from '../../shared/utils/schema.js';

const financialYearSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  name: { type: String, required: true },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  isActive: { type: Boolean, default: false },
  ...auditFields,
});

export const FinancialYear = mongoose.model('FinancialYear', financialYearSchema);
