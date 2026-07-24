import mongoose from 'mongoose';
import { tenantFields, auditFields } from '../../shared/utils/schema.js';

const notificationSchema = new mongoose.Schema({
  ...tenantFields,
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  eventType: { type: String, required: true },
  title: { type: String, required: true },
  message: String,
  channel: { type: String, enum: ['IN_APP', 'EMAIL', 'SMS'], default: 'IN_APP' },
  status: { type: String, enum: ['UNREAD', 'READ'], default: 'UNREAD' },
  referenceType: String,
  referenceId: mongoose.Schema.Types.ObjectId,
  readAt: Date,
  ...auditFields,
});

notificationSchema.index({ userId: 1, status: 1, createdAt: -1 });

export const Notification = mongoose.model('Notification', notificationSchema);
