import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const UPLOADS_ROOT = path.join(__dirname, '../../../uploads');

const IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']);
const RECEIPT_TYPES = new Set([...IMAGE_TYPES, 'application/pdf']);
const MAX_BYTES = 6 * 1024 * 1024;

function extFromType(type, fileName = '') {
  const fromName = path.extname(fileName).replace('.', '').toLowerCase();
  if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'pdf'].includes(fromName)) {
    return fromName === 'jpg' ? 'jpeg' : fromName;
  }
  if (type === 'image/png') return 'png';
  if (type === 'image/webp') return 'webp';
  if (type === 'image/gif') return 'gif';
  if (type === 'application/pdf') return 'pdf';
  return 'jpeg';
}

function slug(value) {
  return String(value || 'mat')
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'mat';
}

function parseDataUrl(input) {
  const raw = String(input || '').trim();
  const match = raw.match(/^data:([^;]+);base64,(.+)$/);
  if (match) {
    return { contentType: match[1], buffer: Buffer.from(match[2], 'base64') };
  }
  return { contentType: 'image/jpeg', buffer: Buffer.from(raw, 'base64') };
}

export async function saveStoredFile({
  buffer,
  contentType = 'image/jpeg',
  fileName = '',
  folder = 'files',
  code = 'doc',
  allowedTypes = IMAGE_TYPES,
}) {
  const type = String(contentType || 'image/jpeg').toLowerCase();
  const ext = extFromType(type, fileName);
  const inferredImage = `image/${ext}`;
  const inferredPdf = ext === 'pdf' ? 'application/pdf' : '';
  if (!allowedTypes.has(type) && !allowedTypes.has(inferredImage) && !(inferredPdf && allowedTypes.has(inferredPdf))) {
    throw new Error(allowedTypes.has('application/pdf')
      ? 'Only JPEG, PNG, WebP, GIF, or PDF files are allowed'
      : 'Only JPEG, PNG, WebP, or GIF images are allowed');
  }
  if (!buffer?.length) throw new Error('Empty file');
  if (buffer.length > MAX_BYTES) throw new Error('File is too large (max 6MB)');

  const dir = path.join(UPLOADS_ROOT, folder, slug(code));
  fs.mkdirSync(dir, { recursive: true });
  const stored = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(dir, stored), buffer);
  return {
    url: `/uploads/${folder}/${slug(code)}/${stored}`,
    fileName: fileName || stored,
  };
}

export async function saveMaterialImageBuffer({
  buffer, contentType = 'image/jpeg', fileName = '', materialCode = 'mat',
}) {
  return saveStoredFile({
    buffer,
    contentType,
    fileName,
    folder: 'materials',
    code: materialCode,
    allowedTypes: IMAGE_TYPES,
  });
}

export async function saveFileInput(input, { folder, code, allowedTypes }) {
  if (!input) return null;
  if (input.url && !input.data && !input.dataUrl) {
    return { url: input.url, fileName: input.fileName || '' };
  }
  const data = input.dataUrl || input.data;
  if (!data) return null;
  const { contentType, buffer } = parseDataUrl(data);
  return saveStoredFile({
    buffer,
    contentType: input.contentType || contentType,
    fileName: input.fileName,
    folder,
    code,
    allowedTypes,
  });
}

export async function persistStoredFiles(inputs, { folder, code, allowedTypes = IMAGE_TYPES, max = 12 } = {}) {
  if (!Array.isArray(inputs) || !inputs.length) return [];
  const out = [];
  for (const item of inputs.slice(0, max)) {
    const saved = await saveFileInput(item, { folder, code, allowedTypes });
    if (saved?.url) out.push(saved);
  }
  return out;
}

export async function persistMaterialImages(inputs, materialCode) {
  return persistStoredFiles(inputs, { folder: 'materials', code: materialCode, allowedTypes: IMAGE_TYPES });
}

export async function persistPurchaseReceipts(inputs, docCode) {
  return persistStoredFiles(inputs, { folder: 'purchase', code: docCode, allowedTypes: RECEIPT_TYPES });
}

export function resolveUploadPath(url) {
  const rel = String(url || '').replace(/^\/uploads\/?/i, '').replace(/\\/g, '/');
  if (!rel || rel.includes('..') || path.isAbsolute(rel)) {
    throw new Error('Invalid file path');
  }
  const abs = path.resolve(UPLOADS_ROOT, rel);
  const root = path.resolve(UPLOADS_ROOT);
  if (abs !== root && !abs.startsWith(`${root}${path.sep}`)) {
    throw new Error('Invalid file path');
  }
  return abs;
}

export function sendLocalUpload(res, url, downloadName) {
  const abs = resolveUploadPath(url);
  if (!fs.existsSync(abs)) {
    const err = new Error('Invoice file not found');
    err.statusCode = 404;
    throw err;
  }
  const name = downloadName || path.basename(abs);
  return new Promise((resolve, reject) => {
    res.download(abs, name, (e) => (e ? reject(e) : resolve()));
  });
}
