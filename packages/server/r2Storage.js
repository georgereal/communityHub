/**
 * Cloudflare R2 (S3-compatible) — private bucket only (same pattern as notebook).
 * Access via short-lived presigned GET URLs; never public object URLs.
 *
 * Env:
 *   R2_ACCOUNT_ID
 *   R2_ACCESS_KEY_ID
 *   R2_SECRET_ACCESS_KEY
 *   R2_BUCKET or R2_BUCKET_NAME   (e.g. communityhub)
 *   R2_PARENT_FOLDER             (optional, default communityHub)
 *
 * Object keys:
 *   {parentFolder}/{orgName}/income/{uuid}.{ext}
 *   {parentFolder}/{orgName}/expenses/{uuid}.{ext}
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';

const MIME_EXT = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['application/pdf', 'pdf'],
]);

let cachedClient = null;

export function isR2Configured() {
  const bucket = process.env.R2_BUCKET?.trim() || process.env.R2_BUCKET_NAME?.trim();
  return Boolean(
    process.env.R2_ACCOUNT_ID?.trim()
    && process.env.R2_ACCESS_KEY_ID?.trim()
    && process.env.R2_SECRET_ACCESS_KEY?.trim()
    && bucket,
  );
}

function requireEnv(name) {
  const v = process.env[name]?.trim();
  if (!v) throw Object.assign(new Error(`Missing ${name}`), { status: 503 });
  return v;
}

function getClient() {
  if (cachedClient) return cachedClient;
  const accountId = requireEnv('R2_ACCOUNT_ID');
  cachedClient = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: requireEnv('R2_ACCESS_KEY_ID'),
      secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY'),
    },
  });
  return cachedClient;
}

export function r2Bucket() {
  const b = process.env.R2_BUCKET?.trim() || process.env.R2_BUCKET_NAME?.trim();
  if (!b) throw Object.assign(new Error('Missing R2_BUCKET or R2_BUCKET_NAME'), { status: 503 });
  return b;
}

export function r2ParentFolder() {
  const raw = (process.env.R2_PARENT_FOLDER || 'communityHub').trim();
  return raw.replace(/[^a-zA-Z0-9_-]/g, '') || 'communityHub';
}

export function extForRecordMime(mime) {
  return MIME_EXT.get(String(mime || '').toLowerCase()) || null;
}

/** Safe folder segment from society / apartment display name. */
export function slugifyOrgName(name) {
  const s = String(name || '')
    .trim()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return s || 'org';
}

export function kindToFolder(kind) {
  return kind === 'IN' ? 'income' : 'expenses';
}

/**
 * Keys: communityHub/{orgName}/income|expenses/{uuid}.{ext}
 * Bucket stays R2_BUCKET_NAME (e.g. communityhub).
 */
export function buildFinanceDocObjectKey({ orgName, kind, mimeOrExt }) {
  const parent = r2ParentFolder();
  const org = slugifyOrgName(orgName);
  const folder = kindToFolder(kind);
  let ext = extForRecordMime(mimeOrExt);
  if (!ext) {
    ext = String(mimeOrExt || 'bin').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 8) || 'bin';
  }
  return `${parent}/${org}/${folder}/${randomUUID()}.${ext}`;
}

export function isAllowedFinanceDocObjectKey(key) {
  if (typeof key !== 'string' || key.length > 512 || key.length < 20) return false;
  if (key.includes('..') || key.startsWith('/') || key.includes('\\')) return false;
  const parts = key.split('/');
  // communityHub/{org}/income|expenses/{uuid}.{ext}
  if (parts.length === 4) {
    const [, org, folder, file] = parts;
    if (!parts[0] || !org || org.length > 80) return false;
    if (folder !== 'income' && folder !== 'expenses') return false;
    return /^[a-f0-9-]{36}\.[a-z0-9]{2,8}$/i.test(file || '');
  }
  return false;
}

/** Normalize legacy `r2:…` strings or attachment objects → object key. */
export function attachmentObjectKey(entry) {
  if (!entry) return null;
  if (typeof entry === 'string') {
    const s = entry.trim();
    if (s.startsWith('r2:')) return s.slice(3);
    return s;
  }
  if (typeof entry === 'object' && typeof entry.key === 'string') return entry.key.trim();
  return null;
}

export async function r2PutObject({ key, body, contentType, cacheControl }) {
  const client = getClient();
  await client.send(new PutObjectCommand({
    Bucket: r2Bucket(),
    Key: key,
    Body: body,
    ContentType: contentType || 'application/octet-stream',
    CacheControl: cacheControl ?? 'private, max-age=31536000',
  }));
}

export async function r2HeadObject(key) {
  try {
    const out = await getClient().send(new HeadObjectCommand({
      Bucket: r2Bucket(),
      Key: key,
    }));
    return {
      contentLength: typeof out.ContentLength === 'number' ? out.ContentLength : 0,
      contentType: typeof out.ContentType === 'string' ? out.ContentType : 'application/octet-stream',
    };
  } catch (e) {
    const name = e && typeof e === 'object' && 'name' in e ? String(e.name) : '';
    if (name === 'NotFound' || name === 'NoSuchKey') return null;
    throw e;
  }
}

export async function r2DeleteObject(key) {
  if (!key) return;
  await getClient().send(new DeleteObjectCommand({
    Bucket: r2Bucket(),
    Key: key,
  }));
}

export async function r2DeleteObjects(keys = []) {
  const clean = [...new Set(keys.filter(Boolean))];
  for (const key of clean) {
    try {
      await r2DeleteObject(key);
    } catch (err) {
      console.error('R2 delete failed:', key, err?.message || err);
    }
  }
}

/** Private bucket: short-lived presigned GET only (no public base URL). */
export async function r2PresignedGetUrl(key, expiresInSeconds = 120) {
  const client = getClient();
  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: r2Bucket(), Key: key }),
    { expiresIn: expiresInSeconds },
  );
}

/** @deprecated alias — prefer r2PresignedGetUrl */
export const r2SignedGetUrl = r2PresignedGetUrl;

/** @deprecated — use attachmentObjectKey + isAllowedFinanceDocObjectKey */
export const isR2Path = (path) => {
  const key = attachmentObjectKey(path);
  return Boolean(key && (isAllowedFinanceDocObjectKey(key) || String(path).startsWith('r2:')));
};

export const r2DeletePaths = async (paths = []) => {
  await r2DeleteObjects(paths.map(attachmentObjectKey).filter(Boolean));
};
