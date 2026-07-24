import mongoose from 'mongoose';
import { tenantFields, auditFields } from '../../shared/utils/schema.js';

const chatRoomSchema = new mongoose.Schema({
  ...tenantFields,
  type: { type: String, enum: ['DIRECT', 'GROUP'], required: true },
  name: String,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  directKey: { type: String, index: true },
  lastMessageAt: Date,
  lastMessagePreview: String,
  isArchived: { type: Boolean, default: false },
  ...auditFields,
});

chatRoomSchema.index({ factoryId: 1, type: 1, updatedAt: -1 });
chatRoomSchema.index({ factoryId: 1, directKey: 1 }, { unique: true, partialFilterExpression: { type: 'DIRECT', isDeleted: false } });

export const ChatRoom = mongoose.model('ChatRoom', chatRoomSchema);
