import mongoose from 'mongoose';

export const tenantFields = {
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', index: true },
  factoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Factory' },
};

export const auditFields = {
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  isDeleted: { type: Boolean, default: false, index: true },
};

export function applySoftDeleteFilter(filter = {}) {
  return { ...filter, isDeleted: false };
}

/** Aggregation pipelines are not cast by Mongoose — convert hex ids explicitly. */
export function asObjectId(id) {
  if (!id) return id;
  if (id instanceof mongoose.Types.ObjectId) return id;
  if (mongoose.Types.ObjectId.isValid(id)) return new mongoose.Types.ObjectId(String(id));
  return id;
}

export function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Query params can arrive as arrays/objects (qs parser) — accept only plain strings. */
export function queryString(value) {
  return typeof value === 'string' ? value : undefined;
}

/** Copy only the listed keys that are defined on `data`. */
export function pickFields(data = {}, keys = []) {
  const out = {};
  for (const key of keys) {
    if (data[key] !== undefined) out[key] = data[key];
  }
  return out;
}
