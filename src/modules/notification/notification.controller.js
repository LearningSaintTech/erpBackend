import Joi from 'joi';
import * as notificationService from './notification.service.js';
import { success, paginate, buildMeta } from '../../shared/utils/response.js';
import {
  NOTIFICATION_STATUS_LIST, NOTIFICATION_CHANNELS, EVENT_TYPES,
  EVENT_TYPE_LABELS, REFERENCE_ROUTE_MAP,
} from './notification.defaults.js';

export const listSchema = Joi.object({
  query: Joi.object({
    page: Joi.number().integer().min(1),
    limit: Joi.number().integer().min(1).max(100),
    status: Joi.string().valid(...NOTIFICATION_STATUS_LIST),
    eventType: Joi.string(),
    search: Joi.string().trim(),
  }),
});

export async function catalog(req, res, next) {
  try {
    success(res, {
      statuses: NOTIFICATION_STATUS_LIST,
      channels: NOTIFICATION_CHANNELS,
      eventTypes: EVENT_TYPES,
      eventTypeLabels: EVENT_TYPE_LABELS,
      referenceRoutes: REFERENCE_ROUTE_MAP,
    });
  } catch (e) { next(e); }
}

export async function stats(req, res, next) {
  try {
    success(res, await notificationService.getNotificationStats(req.user._id, req.factoryId));
  } catch (e) { next(e); }
}

export async function list(req, res, next) {
  try {
    const { page, limit, skip } = paginate(req.query);
    const { items, total } = await notificationService.listForUser(req.user._id, req.factoryId, {
      page, limit, skip,
      status: req.query.status,
      eventType: req.query.eventType,
      search: req.query.search,
    });
    success(res, items, buildMeta(page, limit, total));
  } catch (e) { next(e); }
}

export async function unreadCount(req, res, next) {
  try {
    const count = await notificationService.unreadCount(req.user._id, req.factoryId);
    success(res, { count });
  } catch (e) { next(e); }
}

export async function markRead(req, res, next) {
  try {
    success(res, await notificationService.markRead(req.params.id, req.user._id));
  } catch (e) { next(e); }
}

export async function markAllRead(req, res, next) {
  try {
    success(res, await notificationService.markAllRead(req.user._id, req.factoryId));
  } catch (e) { next(e); }
}

export async function recent(req, res, next) {
  try {
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit || '8', 10)));
    success(res, await notificationService.recentForUser(req.user._id, req.factoryId, limit));
  } catch (e) { next(e); }
}
