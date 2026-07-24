import mongoose from 'mongoose';
import { tenantFields } from '../../shared/utils/schema.js';

const approvalInstanceSchema = new mongoose.Schema({
  ...tenantFields,
  workflowId: { type: mongoose.Schema.Types.ObjectId, ref: 'ApprovalWorkflow' },
  documentType: { type: String, required: true },
  documentId: { type: mongoose.Schema.Types.ObjectId, required: true },
  status: {
    type: String,
    enum: ['PENDING', 'APPROVED', 'REJECTED', 'CHANGES_REQUESTED', 'OVERRIDDEN', 'CANCELLED'],
    default: 'PENDING',
  },
  currentLevel: { type: Number, default: 1 },
  submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  submittedAt: { type: Date, default: Date.now },
  steps: [{
    level: Number,
    approverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    action: String,
    comments: String,
    actionAt: Date,
  }],
  completedAt: Date,
});

approvalInstanceSchema.index({ documentType: 1, documentId: 1 });

export const ApprovalInstance = mongoose.model('ApprovalInstance', approvalInstanceSchema);
