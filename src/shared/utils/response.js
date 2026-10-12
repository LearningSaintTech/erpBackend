export function success(res, data, meta = null, status = 200) {
  const body = { success: true, data };
  if (meta) body.meta = meta;
  return res.status(status).json(body);
}

export const MAX_PAGE_SIZE = 500;

export function paginate(query) {
  const page = Math.max(1, parseInt(query.page || '1', 10));
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(query.limit || '20', 10)) || 20);
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

export function buildMeta(page, limit, total) {
  return {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit) || 0,
  };
}
