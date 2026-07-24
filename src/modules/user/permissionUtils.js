import { ALL_PERMISSION_CODES } from '../../config/systemRoles.js';
import { ValidationError } from '../../shared/errors/AppError.js';

const CATALOG = new Set(ALL_PERMISSION_CODES);

export function validatePermissionCodes(codes) {
  if (!Array.isArray(codes) || codes.length === 0) {
    throw new ValidationError('At least one permission is required');
  }
  const invalid = codes.filter((c) => !CATALOG.has(c));
  if (invalid.length) {
    throw new ValidationError('Invalid permission codes', { invalid });
  }
  return codes;
}

export function filterKnownPermissionCodes(codes) {
  return (codes || []).filter((c) => CATALOG.has(c));
}
