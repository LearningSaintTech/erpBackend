import mongoose from 'mongoose';
import { tenantFields, auditFields } from '../../shared/utils/schema.js';

const delegationSchema = new mongoose.Schema({
  ...tenantFields,
  delegatorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  delegateId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  permissions: [String],
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  status: { type: String, enum: ['ACTIVE', 'EXPIRED', 'REVOKED'], default: 'ACTIVE' },
  ...auditFields,
});

export const Delegation = mongoose.model('Delegation', delegationSchema);
