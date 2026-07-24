import mongoose from 'mongoose';
import { tenantFields } from '../../shared/utils/schema.js';

const approvalWorkflowSchema = new mongoose.Schema({
  ...tenantFields,
  documentType: { type: String, required: true },
  name: { type: String, required: true },
  levels: [{
    level: Number,
    approverRoles: [String],
    approvalType: { type: String, enum: ['ANY', 'ALL'], default: 'ANY' },
    slaHours: { type: Number, default: 24 },
    escalationRole: String,
  }],
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
});

export const ApprovalWorkflow = mongoose.model('ApprovalWorkflow', approvalWorkflowSchema);
