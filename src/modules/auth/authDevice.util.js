export function resolveDeviceId(raw, userId) {
  const value = raw == null ? '' : String(raw).trim();
  if (!value || value === 'undefined' || value === 'null') {
    return `default-${userId}`;
  }
  return value.slice(0, 80);
}

export function deviceIdFromRequest(req) {
  return req.headers['x-device-id'] || req.body?.deviceId || '';
}
