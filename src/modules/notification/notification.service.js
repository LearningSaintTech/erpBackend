import { Notification } from './notification.model.js';
import { User } from '../user/user.model.js';
import { NotFoundError } from '../../shared/errors/AppError.js';
import { applySoftDeleteFilter } from '../../shared/utils/schema.js';
import { sendEmail } from '../../shared/services/email.service.js';
import { enqueueJob } from '../../shared/services/queue.service.js';
import { env } from '../../config/env.js';
import { emitToUser, serializeId } from '../../shared/services/realtime.js';

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildListFilter(userId, factoryId, { status, eventType, search } = {}) {
  const filter = applySoftDeleteFilter({ userId, factoryId });
  if (status) filter.status = status;
  if (eventType) filter.eventType = eventType;
  if (search?.trim()) {
    const re = new RegExp(escapeRegex(search.trim()), 'i');
    filter.$or = [{ title: re }, { message: re }, { eventType: re }];
  }
  return filter;
}

export async function notify({
  organizationId,
  factoryId,
  userId,
  eventType,
  title,
  message,
  referenceType,
  referenceId,
}) {
  if (!userId) return null;
  const notification = await Notification.create({
    organizationId,
    factoryId,
    userId,
    eventType,
    title,
    message,
    channel: 'IN_APP',
    status: 'UNREAD',
    referenceType,
    referenceId,
    createdBy: userId,
    updatedBy: userId,
  });

  if (env.emailNotifications) {
    const user = await User.findById(userId).select('email');
    if (user?.email) {
      await enqueueJob('notification', {
        email: { to: user.email, subject: title, text: message },
      });
    }
  }

  const payload = notification.toObject();
  payload._id = serializeId(payload._id);
  payload.userId = serializeId(payload.userId);
  payload.organizationId = serializeId(payload.organizationId);
  payload.factoryId = serializeId(payload.factoryId);
  payload.referenceId = serializeId(payload.referenceId);
  emitToUser(userId, 'notification:new', payload);

  return notification;
}

export async function notifyUserByEmail(userId, { subject, text, html }) {
  const user = await User.findById(userId);
  if (!user?.email) return { sent: false, reason: 'no_user_email' };
  return sendEmail({ to: user.email, subject, text, html });
}

export async function listForUser(userId, factoryId, { page, limit, skip, status, eventType, search }) {
  const filter = buildListFilter(userId, factoryId, { status, eventType, search });
  const [items, total] = await Promise.all([
    Notification.find(filter).skip(skip).limit(limit).sort({ createdAt: -1 }),
    Notification.countDocuments(filter),
  ]);
  return { items, total };
}

export async function recentForUser(userId, factoryId, limit = 8) {
  return Notification.find(applySoftDeleteFilter({ userId, factoryId }))
    .sort({ createdAt: -1 })
    .limit(limit);
}

export async function getNotificationStats(userId, factoryId) {
  const base = { userId, factoryId, isDeleted: false };
  const [unread, read, todayCount, byTypeRows] = await Promise.all([
    Notification.countDocuments({ ...base, status: 'UNREAD' }),
    Notification.countDocuments({ ...base, status: 'READ' }),
    Notification.countDocuments({
      ...base,
      createdAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) },
    }),
    Notification.aggregate([
      { $match: { ...base, status: 'UNREAD' } },
      { $group: { _id: '$eventType', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 },
    ]),
  ]);
  return {
    unread,
    read,
    total: unread + read,
    todayCount,
    unreadByType: Object.fromEntries(byTypeRows.map((r) => [r._id, r.count])),
  };
}

export async function unreadCount(userId, factoryId) {
  return Notification.countDocuments({
    userId,
    factoryId,
    status: 'UNREAD',
    isDeleted: false,
  });
}

export async function markRead(id, userId) {
  const n = await Notification.findOne({ _id: id, userId, isDeleted: false });
  if (!n) throw new NotFoundError('Notification not found');
  n.status = 'READ';
  n.readAt = new Date();
  await n.save();
  return n;
}

export async function markAllRead(userId, factoryId) {
  await Notification.updateMany(
    { userId, factoryId, status: 'UNREAD', isDeleted: false },
    { status: 'READ', readAt: new Date() }
  );
  return { success: true };
}
