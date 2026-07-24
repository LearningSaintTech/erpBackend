import Joi from 'joi';
import * as chatService from './chat.service.js';
import { success, paginate, buildMeta } from '../../shared/utils/response.js';
import { AuditLog } from '../audit/audit.model.js';

function logModerationAccess(req, action, roomId = null) {
  setImmediate(() => {
    AuditLog.create({
      organizationId: req.organizationId || req.user?.organizationId,
      factoryId: req.factoryId,
      userId: req.user._id,
      userEmail: req.user.email,
      module: 'chat',
      action,
      metadata: { roomId, moderation: true, path: req.originalUrl },
      timestamp: new Date(),
    }).catch(() => {});
  });
}

const objectId = Joi.string().hex().length(24);

export const listRoomsSchema = Joi.object({
  query: Joi.object({
    page: Joi.number().integer().min(1),
    limit: Joi.number().integer().min(1).max(100),
  }),
});

export const directRoomSchema = Joi.object({
  body: Joi.object({
    userId: objectId.required(),
  }),
});

export const groupRoomSchema = Joi.object({
  body: Joi.object({
    name: Joi.string().trim().min(2).max(120).required(),
    memberIds: Joi.array().items(objectId).min(1).required(),
  }),
});

export const updateRoomSchema = Joi.object({
  body: Joi.object({
    name: Joi.string().trim().min(2).max(120),
    isArchived: Joi.boolean(),
  }).min(1),
});

export const membersSchema = Joi.object({
  body: Joi.object({
    memberIds: Joi.array().items(objectId).min(1).required(),
  }),
});

export const sendMessageSchema = Joi.object({
  body: Joi.object({
    body: Joi.string().trim().min(1).max(4000).required(),
    replyToId: objectId,
  }),
});

export const listMessagesSchema = Joi.object({
  query: Joi.object({
    page: Joi.number().integer().min(1),
    limit: Joi.number().integer().min(1).max(100),
  }),
});

export async function catalog(req, res, next) {
  try {
    success(res, chatService.getCatalog());
  } catch (e) { next(e); }
}

export async function stats(req, res, next) {
  try {
    success(res, await chatService.getChatStats(req.user._id, req.factoryId));
  } catch (e) { next(e); }
}

export async function listRooms(req, res, next) {
  try {
    const { page, limit, skip } = paginate(req.query);
    const { items, total } = await chatService.listMyRooms(req.user._id, req.factoryId, { page, limit, skip });
    success(res, items, buildMeta(page, limit, total));
  } catch (e) { next(e); }
}

export async function createDirectRoom(req, res, next) {
  try {
    const room = await chatService.getOrCreateDirectRoom(
      req.factoryId,
      req.organizationId,
      req.user._id,
      req.body.userId,
      req.user._id,
    );
    success(res, room, undefined, 201);
  } catch (e) { next(e); }
}

export async function createGroupRoom(req, res, next) {
  try {
    const room = await chatService.createGroupRoom(
      req.factoryId,
      req.organizationId,
      req.body,
      req.user._id,
    );
    success(res, room, undefined, 201);
  } catch (e) { next(e); }
}

export async function getRoom(req, res, next) {
  try {
    const room = await chatService.getRoom(
      req.params.id,
      req.user._id,
      req.factoryId,
      req.permissions || [],
    );
    success(res, room);
  } catch (e) { next(e); }
}

export async function updateRoom(req, res, next) {
  try {
    const room = await chatService.updateGroupRoom(
      req.params.id,
      req.factoryId,
      req.user._id,
      req.body,
    );
    success(res, room);
  } catch (e) { next(e); }
}

export async function addMembers(req, res, next) {
  try {
    const room = await chatService.addRoomMembers(
      req.params.id,
      req.factoryId,
      req.user._id,
      req.body.memberIds,
    );
    success(res, room);
  } catch (e) { next(e); }
}

export async function removeMember(req, res, next) {
  try {
    const room = await chatService.removeRoomMember(
      req.params.id,
      req.factoryId,
      req.user._id,
      req.params.userId,
    );
    success(res, room);
  } catch (e) { next(e); }
}

export async function listMessages(req, res, next) {
  try {
    const { page, limit, skip } = paginate(req.query);
    const { items, total } = await chatService.listMessages(
      req.params.id,
      req.user._id,
      req.factoryId,
      req.permissions || [],
      { page, limit, skip },
    );
    success(res, items, buildMeta(page, limit, total));
  } catch (e) { next(e); }
}

export async function sendMessage(req, res, next) {
  try {
    const message = await chatService.sendMessage(
      req.params.id,
      req.user._id,
      req.factoryId,
      req.permissions || [],
      { ...req.body, organizationId: req.organizationId },
    );
    success(res, message, undefined, 201);
  } catch (e) { next(e); }
}

export async function markRead(req, res, next) {
  try {
    success(res, await chatService.markRoomRead(
      req.params.id,
      req.user._id,
      req.factoryId,
      req.permissions || [],
    ));
  } catch (e) { next(e); }
}

export async function listAdminRooms(req, res, next) {
  try {
    logModerationAccess(req, 'MODERATE_LIST_ROOMS');
    const { page, limit, skip } = paginate(req.query);
    const { items, total } = await chatService.listAdminRooms(req.factoryId, { page, limit, skip });
    success(res, items, buildMeta(page, limit, total));
  } catch (e) { next(e); }
}

export async function listAdminMessages(req, res, next) {
  try {
    logModerationAccess(req, 'MODERATE_READ_MESSAGES', req.params.id);
    const { page, limit, skip } = paginate(req.query);
    const { items, total } = await chatService.listMessages(
      req.params.id,
      req.user._id,
      req.factoryId,
      req.permissions || [],
      { page, limit, skip },
    );
    success(res, items, buildMeta(page, limit, total));
  } catch (e) { next(e); }
}
