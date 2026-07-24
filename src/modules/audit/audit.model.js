import mongoose from 'mongoose';

const auditLogSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', index: true },
  factoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Factory', index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  userEmail: String,
  module: String,
  action: String,
  documentType: String,
  documentId: mongoose.Schema.Types.ObjectId,
  previousData: mongoose.Schema.Types.Mixed,
  updatedData: mongoose.Schema.Types.Mixed,
  metadata: mongoose.Schema.Types.Mixed,
  timestamp: { type: Date, default: Date.now, index: true },
});

export const AuditLog = mongoose.model('AuditLog', auditLogSchema);
