import { verifyAccessToken } from '../../middleware/auth.js';
import { User } from '../user/user.model.js';
import { UserRoleAssignment } from '../user/userRoleAssignment.model.js';
import { getUserPermissions } from '../user/user.service.js';
import * as chatService from './chat.service.js';
import { ChatRoomMember } from './chatRoomMember.model.js';
import { UnauthorizedError, ForbiddenError, ValidationError } from '../../shared/errors/AppError.js';

function socketError(socket, code, message) {
  socket.emit('chat:error', { code, message });
}

let chatIo = null;

/**
 * Deliver a new message to everyone who should see it live: sockets that have the room open
 * (`room:<id>`, incl. moderators) AND every member's personal channel (`user:<id>`), so a member
 * who has not opened the room — or did not even know it existed (a brand-new DM) — gets the
 * unread badge / toast without a reload. One emit over all targets, so socket.io sends each socket
 * the message once even when it is in several of these rooms.
 */
export async function emitChatMessage(roomId, message) {
  if (!chatIo || !roomId || !message) return;
  const members = await ChatRoomMember.find({ roomId }).select('userId').lean();
  const targets = [`room:${roomId}`, ...members.map((m) => `user:${m.userId}`)];
  chatIo.to(targets).emit('chat:message', message);
}

export function initChatSocket(io) {
  chatIo = io;
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      const factoryId = socket.handshake.auth?.factoryId || socket.handshake.query?.factoryId;
      if (!token) throw new UnauthorizedError('Missing auth token');
      if (!factoryId) throw new ValidationError('factoryId is required');
      if (typeof factoryId !== 'string' || !/^[a-f\d]{24}$/i.test(factoryId)) {
        throw new ValidationError('Invalid factoryId');
      }

      const decoded = verifyAccessToken(token);
      const user = await User.findById(decoded.sub).select('-passwordHash');
      if (!user || user.status !== 'ACTIVE') throw new UnauthorizedError('User not active');

      const assignment = await UserRoleAssignment.findOne({ userId: user._id, factoryId });
      if (!assignment && !user.isSuperAdmin) {
        throw new ForbiddenError('No factory assignment for this user');
      }

      const permissions = user.isSuperAdmin
        ? ['*']
        : await getUserPermissions(user._id, factoryId);

      socket.data.user = user;
      socket.data.factoryId = factoryId.toString();
      socket.data.organizationId = assignment?.organizationId?.toString() || user.organizationId?.toString();
      socket.data.permissions = permissions;
      next();
    } catch (err) {
      next(err);
    }
  });

  io.on('connection', (socket) => {
    const { user, factoryId } = socket.data;
    socket.join(`factory:${factoryId}`);
    socket.join(`user:${user._id}`);

    socket.on('chat:join', async ({ roomId } = {}) => {
      try {
        if (!roomId) throw new ValidationError('roomId is required');
        await chatService.assertRoomAccess(roomId, user._id, factoryId, socket.data.permissions);
        socket.join(`room:${roomId}`);
        socket.emit('chat:joined', { roomId });
      } catch (err) {
        socketError(socket, err.code || 'JOIN_FAILED', err.message);
      }
    });

    socket.on('chat:leave', ({ roomId } = {}) => {
      if (roomId) socket.leave(`room:${roomId}`);
    });

    socket.on('chat:send', async ({ roomId, body, replyToId } = {}) => {
      try {
        if (!roomId) throw new ValidationError('roomId is required');
        const message = await chatService.sendMessage(
          roomId,
          user._id,
          factoryId,
          socket.data.permissions,
          { body, replyToId, organizationId: socket.data.organizationId },
        );
        await emitChatMessage(roomId, message);
      } catch (err) {
        socketError(socket, err.code || 'SEND_FAILED', err.message);
      }
    });

    socket.on('chat:typing', ({ roomId, isTyping } = {}) => {
      if (!roomId || !socket.rooms.has(`room:${roomId}`)) return;
      socket.to(`room:${roomId}`).emit('chat:typing', {
        roomId,
        userId: user._id,
        isTyping: !!isTyping,
      });
    });

    socket.on('chat:read', async ({ roomId } = {}) => {
      try {
        if (!roomId) throw new ValidationError('roomId is required');
        await chatService.markRoomRead(roomId, user._id, factoryId, socket.data.permissions);
        socket.to(`room:${roomId}`).emit('chat:read', {
          roomId,
          userId: user._id,
          readAt: new Date(),
        });
      } catch (err) {
        socketError(socket, err.code || 'READ_FAILED', err.message);
      }
    });
  });
}
