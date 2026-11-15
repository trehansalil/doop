import { createHash, createHmac, randomBytes } from 'node:crypto'
import { env } from './env.ts'
import { putExport } from './storage.ts'

/**
 * Time-limited download links for export_frame.
 *
 * The stock tool returns a permanent, unauthenticated /i/<frameId>.png URL (and
 * a PDF as an inline base64 blob). When EXPORT_BUCKET, EXPORT_PUBLIC_URL and
 * the bucket credentials are all set, the render is uploaded to the export
 * bucket instead and the tool returns a presigned GET link that stops working
 * after EXPORT_LINK_TTL_SECONDS (default 24h). A lifecycle rule on the bucket
 * removes the bytes; the signature is what enforces the expiry.
 *
 * The link is presigned for EXPORT_PUBLIC_URL's host, not the internal store
 * endpoint: SigV4 signs the Host header, so it has to be the host the client
 * actually requests (a reverse-proxy route to the store, path-style).
 */

/** S3 refuses a presigned URL valid for more than 7 days. */
const MAX_TTL_SECONDS = 7 * 24 * 3600

export function exportLinksEnabled(): boolean {
  return !!(
    env.EXPORT_BUCKET &&
    env.EXPORT_PUBLIC_URL &&
    env.ENDPOINT &&
    env.ACCESS_KEY_ID &&
    env.SECRET_ACCESS_KEY
  )
}

export function exportLinkTtlSeconds(): number {
  return Math.min(env.EXPORT_LINK_TTL_SECONDS, MAX_TTL_SECONDS)
}

const hmac = (key: Buffer | string, msg: string) => createHmac('sha256', key).update(msg).digest()
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
/* RFC 3986 unreserved set, the encoding SigV4 canonical requests use */
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

export interface PresignInput {
  /** origin the client will request, e.g. https://doop-mcp.saliltrehan.com */
  publicUrl: string
  bucket: string
  key: string
  accessKeyId: string
  secretAccessKey: string
  region: string
  ttlSeconds: number
  now?: Date
}

/** Path-style SigV4 presigned GET: `<publicUrl>/<bucket>/<key>?X-Amz-…`. */
export function presignGet(i: PresignInput): { url: string; expiresAt: Date } {
  const now = i.now ?? new Date()
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const day = amzDate.slice(0, 8)
  const scope = `${day}/${i.region}/s3/aws4_request`
  const { host } = new URL(i.publicUrl)
  const path = `/${enc(i.bucket)}/${i.key.split('/').map(enc).join('/')}`
  /* a sub-path in publicUrl (proxy mounted below the root) is not part of what
     the store sees, so it is deliberately not supported: the route must be
     host-level, like the bucket path itself */
  const query: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${i.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(i.ttlSeconds),
    'X-Amz-SignedHeaders': 'host',
  }
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${enc(k)}=${enc(query[k]!)}`)
    .join('&')
  const canonical = `GET\n${path}\n${canonicalQuery}\nhost:${host}\n\nhost\nUNSIGNED-PAYLOAD`
  const toSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonical)}`
  let k = hmac(`AWS4${i.secretAccessKey}`, day)
  for (const part of [i.region, 's3', 'aws4_request']) k = hmac(k, part)
  const signature = createHmac('sha256', k).update(toSign).digest('hex')
  return {
    url: `${new URL(i.publicUrl).origin}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`,
    expiresAt: new Date(now.getTime() + i.ttlSeconds * 1000),
  }
}

export interface PublishedExport {
  url: string
  expiresAt: string
  ttlSeconds: number
}

/** Uploads one export and returns its presigned link. Rejects on any store
 *  failure — callers fall back to the stock behaviour rather than failing the
 *  export. */
export async function publishExport(
  buf: Buffer,
  opts: { name: string; ext: 'png' | 'jpg' | 'pdf' },
): Promise<PublishedExport> {
  if (!exportLinksEnabled()) throw new Error('export links are not configured')
  const mime = { png: 'image/png', jpg: 'image/jpeg', pdf: 'application/pdf' }[opts.ext]
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const name = opts.name.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'export'
  const key = `exports/${day}/${randomBytes(8).toString('hex')}-${name}.${opts.ext}`
  await putExport(key, buf, mime)
  const ttlSeconds = exportLinkTtlSeconds()
  const { url, expiresAt } = presignGet({
    publicUrl: env.EXPORT_PUBLIC_URL!,
    bucket: env.EXPORT_BUCKET!,
    key,
    accessKeyId: env.ACCESS_KEY_ID!,
    secretAccessKey: env.SECRET_ACCESS_KEY!,
    region: env.REGION,
    ttlSeconds,
  })
  return { url, expiresAt: expiresAt.toISOString(), ttlSeconds }
}
