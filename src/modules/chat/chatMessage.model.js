import mongoose from 'mongoose';
import { auditFields } from '../../shared/utils/schema.js';

const chatMessageSchema = new mongoose.Schema({
  roomId: { type: mongoose.Schema.Types.ObjectId, ref: 'ChatRoom', required: true, index: true },
  factoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Factory', required: true, index: true },
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  body: { type: String, required: true },
  messageType: { type: String, enum: ['TEXT', 'SYSTEM'], default: 'TEXT' },
  replyToId: { type: mongoose.Schema.Types.ObjectId, ref: 'ChatMessage' },
  ...auditFields,
});

chatMessageSchema.index({ roomId: 1, createdAt: -1 });

export const ChatMessage = mongoose.model('ChatMessage', chatMessageSchema);
