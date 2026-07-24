import { env } from '../../config/env.js';

export async function uploadFile({ key, body, contentType }) {
  if (!env.s3Bucket) {
    console.log(`[S3] upload stub key=${key} size=${body?.length || 0}`);
    return { key, url: `/uploads/${key}`, mode: 'stub' };
  }
  try {
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
    const client = new S3Client({ region: env.s3Region });
    await client.send(new PutObjectCommand({
      Bucket: env.s3Bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }));
    return { key, url: `https://${env.s3Bucket}.s3.amazonaws.com/${key}`, mode: 's3' };
  } catch (err) {
    console.error('[S3] upload failed:', err.message);
    throw err;
  }
}

export async function getUploadUrl(key) {
  if (!env.s3Bucket) return { url: `/uploads/${key}`, mode: 'stub' };
  return { url: `https://${env.s3Bucket}.s3.amazonaws.com/${key}`, mode: 's3' };
}
