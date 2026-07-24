import { ChatRoom } from './chatRoom.model.js';
import { ChatRoomMember } from './chatRoomMember.model.js';
import { ChatMessage } from './chatMessage.model.js';
import { UserRoleAssignment } from '../user/userRoleAssignment.model.js';
import { User } from '../user/user.model.js';
import { notify } from '../notification/notification.service.js';
import { NotFoundError, ForbiddenError, ValidationError, ConflictError } from '../../shared/errors/AppError.js';
import { applySoftDeleteFilter } from '../../shared/utils/schema.js';
import { MAX_MESSAGE_LENGTH, MAX_GROUP_NAME_LENGTH, ROOM_TYPES, MEMBER_ROLES, MESSAGE_TYPES } from './chat.defaults.js';

function directKeyFor(userIdA, userIdB) {
  const ids = [userIdA.toString(), userIdB.toString()].sort();
  return `${ids[0]}:${ids[1]}`;
}

function previewBody(body) {
  const t = (body || '').trim();
  return t.length > 120 ? `${t.slice(0, 117)}...` : t;
}

export async function assertUserInFactory(userId, factoryId) {
  const assignment = await UserRoleAssignment.findOne({ userId, factoryId });
  if (!assignment) throw new ForbiddenError('User is not assigned to this factory');
  const user = await User.findById(userId).select('status firstName lastName email');
  if (!user || user.status !== 'ACTIVE') throw new ValidationError('Target user is not active');
  return user;
}

export async function getMember(roomId, userId) {
  return ChatRoomMember.findOne({ roomId, userId });
}

export async function assertMember(roomId, userId, factoryId) {
  const member = await ChatRoomMember.findOne({ roomId, userId, factoryId });
  if (!member) throw new ForbiddenError('Not a member of this chat room');
  return member;
}

export function hasModerate(permissions = []) {
  return permissions.includes('*') || permissions.includes('chat.moderate');
}

async function getRoomOrThrow(roomId, factoryId) {
  const room = await ChatRoom.findOne(applySoftDeleteFilter({ _id: roomId, factoryId }));
  if (!room) throw new NotFoundError('Chat room not found');
  return room;
}

export async function assertRoomAccess(roomId, userId, factoryId, permissions) {
  const room = await getRoomOrThrow(roomId, factoryId);
  if (hasModerate(permissions)) return { room, member: null };
  const member = await assertMember(roomId, userId, factoryId);
  return { room, member };
}

async function addMembersToRoom(room, memberIds, adminUserId, { adminUserIds = [] } = {}) {
  const uniqueIds = [...new Set(memberIds.map((id) => id.toString()))];
  for (const uid of uniqueIds) {
    await assertUserInFactory(uid, room.factoryId);
    const isAdmin = adminUserIds.map(String).includes(uid) || uid === adminUserId.toString();
    await ChatRoomMember.findOneAndUpdate(
      { roomId: room._id, userId: uid },
      {
        roomId: room._id,
        userId: uid,
        factoryId: room.factoryId,
        organizationId: room.organizationId,
        role: isAdmin ? 'ADMIN' : 'MEMBER',
        joinedAt: new Date(),
      },
      { upsert: true, new: true },
    );
  }
}

export async function getOrCreateDirectRoom(factoryId, organizationId, userId, otherUserId, actorId) {
  if (userId.toString() === otherUserId.toString()) {
    throw new ValidationError('Cannot start a direct chat with yourself');
  }
  await assertUserInFactory(userId, factoryId);
  await assertUserInFactory(otherUserId, factoryId);

  const directKey = directKeyFor(userId, otherUserId);
  let room = await ChatRoom.findOne(applySoftDeleteFilter({ factoryId, type: 'DIRECT', directKey }));
  if (!room) {
    room = await ChatRoom.create({
      factoryId,
      organizationId,
      type: 'DIRECT',
      directKey,
      name: null,
      createdBy: actorId,
      updatedBy: actorId,
    });
    await addMembersToRoom(room, [userId, otherUserId], actorId);
  } else {
    const member = await getMember(room._id, userId);
    if (!member) await addMembersToRoom(room, [userId, otherUserId], actorId);
  }
  return populateRoom(room._id, userId, factoryId);
}

export async function createGroupRoom(factoryId, organizationId, { name, memberIds }, actorId) {
  const trimmed = name?.trim();
  if (!trimmed || trimmed.length < 2) throw new ValidationError('Group name is required');
  if (trimmed.length > MAX_GROUP_NAME_LENGTH) throw new ValidationError('Group name is too long');
  if (!memberIds?.length) throw new ValidationError('At least one member is required');

  const allMembers = [...new Set([actorId.toString(), ...memberIds.map(String)])];
  const room = await ChatRoom.create({
    factoryId,
    organizationId,
    type: 'GROUP',
    name: trimmed,
    createdBy: actorId,
    updatedBy: actorId,
  });

  await addMembersToRoom(room, allMembers, actorId, { adminUserIds: [actorId] });

  await ChatMessage.create({
    roomId: room._id,
    factoryId,
    organizationId,
    senderId: actorId,
    body: `Group "${trimmed}" created`,
    messageType: 'SYSTEM',
    createdBy: actorId,
    updatedBy: actorId,
  });

  return populateRoom(room._id, actorId, factoryId);
}

async function populateRoom(roomId, userId, factoryId) {
  const room = await ChatRoom.findById(roomId)
    .populate('createdBy', 'firstName lastName email');
  const members = await ChatRoomMember.find({ roomId })
    .populate('userId', 'firstName lastName email status');
  const myMember = members.find((m) => m.userId?._id?.toString() === userId.toString());
  const unread = myMember?.lastReadAt
    ? await ChatMessage.countDocuments({
      roomId,
      isDeleted: false,
      createdAt: { $gt: myMember.lastReadAt },
      senderId: { $ne: userId },
    })
    : await ChatMessage.countDocuments({ roomId, isDeleted: false, senderId: { $ne: userId } });

  return {
    ...room.toObject(),
    members: members.map((m) => ({
      _id: m._id,
      userId: m.userId,
      role: m.role,
      joinedAt: m.joinedAt,
      lastReadAt: m.lastReadAt,
    })),
    unreadCount: unread,
  };
}

export async function listMyRooms(userId, factoryId, { page, limit, skip }) {
  const memberships = await ChatRoomMember.find({ userId, factoryId }).select('roomId');
  const roomIds = memberships.map((m) => m.roomId);
  const filter = applySoftDeleteFilter({
    factoryId,
    _id: { $in: roomIds },
    isArchived: false,
  });
  const [rooms, total] = await Promise.all([
    ChatRoom.find(filter).sort({ lastMessageAt: -1, updatedAt: -1 }).skip(skip).limit(limit),
    ChatRoom.countDocuments(filter),
  ]);
  const items = await Promise.all(rooms.map((r) => populateRoom(r._id, userId, factoryId)));
  return { items, total };
}

export async function listAdminRooms(factoryId, { page, limit, skip }) {
  const filter = applySoftDeleteFilter({ factoryId });
  const [rooms, total] = await Promise.all([
    ChatRoom.find(filter).sort({ lastMessageAt: -1, updatedAt: -1 }).skip(skip).limit(limit)
      .populate('createdBy', 'firstName lastName email'),
    ChatRoom.countDocuments(filter),
  ]);
  const items = await Promise.all(rooms.map(async (room) => {
    const memberCount = await ChatRoomMember.countDocuments({ roomId: room._id });
    return { ...room.toObject(), memberCount };
  }));
  return { items, total };
}

export async function getRoom(roomId, userId, factoryId, permissions) {
  await assertRoomAccess(roomId, userId, factoryId, permissions);
  return populateRoom(roomId, userId, factoryId);
}

export async function updateGroupRoom(roomId, factoryId, userId, { name, isArchived }) {
  const room = await getRoomOrThrow(roomId, factoryId);
  if (room.type !== 'GROUP') throw new ValidationError('Only group rooms can be updated');
  await assertMember(roomId, userId, factoryId);
  const member = await getMember(roomId, userId);
  if (member.role !== 'ADMIN') throw new ForbiddenError('Only group admins can update the room');

  if (name !== undefined) {
    const trimmed = name.trim();
    if (!trimmed) throw new ValidationError('Group name cannot be empty');
    if (trimmed.length > MAX_GROUP_NAME_LENGTH) throw new ValidationError('Group name is too long');
    room.name = trimmed;
  }
  if (isArchived !== undefined) room.isArchived = !!isArchived;
  room.updatedBy = userId;
  await room.save();
  return populateRoom(roomId, userId, factoryId);
}

export async function addRoomMembers(roomId, factoryId, userId, memberIds) {
  const room = await getRoomOrThrow(roomId, factoryId);
  if (room.type !== 'GROUP') throw new ValidationError('Members can only be added to group rooms');
  const actor = await assertMember(roomId, userId, factoryId);
  if (actor.role !== 'ADMIN') throw new ForbiddenError('Only group admins can add members');

  await addMembersToRoom(room, memberIds, userId);
  await ChatMessage.create({
    roomId: room._id,
    factoryId,
    organizationId: room.organizationId,
    senderId: userId,
    body: `${memberIds.length} member(s) added`,
    messageType: 'SYSTEM',
    createdBy: userId,
    updatedBy: userId,
  });
  return populateRoom(roomId, userId, factoryId);
}

export async function removeRoomMember(roomId, factoryId, actorId, targetUserId) {
  const room = await getRoomOrThrow(roomId, factoryId);
  if (room.type !== 'GROUP') throw new ValidationError('Members can only be removed from group rooms');
  const actor = await assertMember(roomId, actorId, factoryId);
  if (actor.role !== 'ADMIN' && actorId.toString() !== targetUserId.toString()) {
    throw new ForbiddenError('Only group admins can remove other members');
  }
  const result = await ChatRoomMember.deleteOne({ roomId, userId: targetUserId, factoryId });
  if (!result.deletedCount) throw new NotFoundError('Member not found in room');
  return populateRoom(roomId, actorId, factoryId);
}

export async function listMessages(roomId, userId, factoryId, permissions, { page, limit, skip }) {
  await assertRoomAccess(roomId, userId, factoryId, permissions);
  const filter = applySoftDeleteFilter({ roomId, factoryId });
  const [items, total] = await Promise.all([
    ChatMessage.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('senderId', 'firstName lastName email'),
    ChatMessage.countDocuments(filter),
  ]);
  return { items: items.reverse(), total };
}

export async function sendMessage(roomId, userId, factoryId, permissions, { body, replyToId, organizationId }) {
  const text = (body || '').trim();
  if (!text) throw new ValidationError('Message body is required');
  if (text.length > MAX_MESSAGE_LENGTH) throw new ValidationError(`Message exceeds ${MAX_MESSAGE_LENGTH} characters`);

  const { room } = await assertRoomAccess(roomId, userId, factoryId, permissions);
  if (room.isArchived) throw new ConflictError('Cannot send messages to an archived room');

  const message = await ChatMessage.create({
    roomId,
    factoryId,
    organizationId: organizationId || room.organizationId,
    senderId: userId,
    body: text,
    messageType: 'TEXT',
    replyToId: replyToId || undefined,
    createdBy: userId,
    updatedBy: userId,
  });

  room.lastMessageAt = new Date();
  room.lastMessagePreview = previewBody(text);
  room.updatedBy = userId;
  await room.save();

  await ChatRoomMember.updateOne(
    { roomId, userId },
    { lastReadAt: new Date() },
  );

  const populated = await ChatMessage.findById(message._id)
    .populate('senderId', 'firstName lastName email');

  const members = await ChatRoomMember.find({ roomId, userId: { $ne: userId } });
  const sender = await User.findById(userId).select('firstName lastName');
  const senderName = sender ? `${sender.firstName || ''} ${sender.lastName || ''}`.trim() : 'Someone';
  const roomLabel = room.type === 'GROUP' ? room.name : senderName;

  for (const m of members) {
    notify({
      organizationId: room.organizationId,
      factoryId,
      userId: m.userId,
      eventType: 'chat.message',
      title: `New message in ${roomLabel}`,
      message: previewBody(text),
      referenceType: 'CHAT_ROOM',
      referenceId: room._id,
    }).catch(() => {});
  }

  return populated;
}

export async function markRoomRead(roomId, userId, factoryId, permissions) {
  await assertRoomAccess(roomId, userId, factoryId, permissions);
  await ChatRoomMember.updateOne(
    { roomId, userId, factoryId },
    { lastReadAt: new Date() },
  );
  return { success: true };
}

export async function getChatStats(userId, factoryId) {
  const memberships = await ChatRoomMember.find({ userId, factoryId });
  let unreadTotal = 0;
  for (const m of memberships) {
    const count = m.lastReadAt
      ? await ChatMessage.countDocuments({
        roomId: m.roomId,
        isDeleted: false,
        createdAt: { $gt: m.lastReadAt },
        senderId: { $ne: userId },
      })
      : await ChatMessage.countDocuments({
        roomId: m.roomId,
        isDeleted: false,
        senderId: { $ne: userId },
      });
    unreadTotal += count;
  }
  const roomCount = await ChatRoomMember.countDocuments({ userId, factoryId });
  const groupCount = await ChatRoom.countDocuments({
    factoryId,
    type: 'GROUP',
    isDeleted: false,
    _id: { $in: memberships.map((m) => m.roomId) },
  });
  return { unreadTotal, roomCount, groupCount };
}

export function getCatalog() {
  return {
    roomTypes: ROOM_TYPES,
    memberRoles: MEMBER_ROLES,
    messageTypes: MESSAGE_TYPES,
    maxMessageLength: MAX_MESSAGE_LENGTH,
    maxGroupNameLength: MAX_GROUP_NAME_LENGTH,
  };
}
