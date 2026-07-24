import mongoose from 'mongoose';

const chatRoomMemberSchema = new mongoose.Schema({
  roomId: { type: mongoose.Schema.Types.ObjectId, ref: 'ChatRoom', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  factoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Factory', required: true, index: true },
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  role: { type: String, enum: ['MEMBER', 'ADMIN'], default: 'MEMBER' },
  lastReadAt: Date,
  joinedAt: { type: Date, default: Date.now },
});

chatRoomMemberSchema.index({ roomId: 1, userId: 1 }, { unique: true });
chatRoomMemberSchema.index({ userId: 1, factoryId: 1 });

export const ChatRoomMember = mongoose.model('ChatRoomMember', chatRoomMemberSchema);
