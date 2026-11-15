import { afterEach, describe, expect, it } from 'vitest'
import { exportLinksEnabled, exportLinkTtlSeconds, presignGet } from '../server/exportLinks.ts'
import { stubEnv, unstubAllEnvs } from './envStub.ts'

const base = {
  publicUrl: 'https://doop-mcp.example.com',
  bucket: 'doop-exports',
  key: 'exports/20261115/0123456789abcdef-My_Frame.png',
  accessKeyId: 'AKID',
  secretAccessKey: 'secret',
  region: 'us-east-1',
  ttlSeconds: 86400,
  now: new Date('2026-11-15T10:00:00.000Z'),
}

afterEach(() => unstubAllEnvs())

describe('presignGet', () => {
  it('builds a path-style SigV4 URL on the public host', () => {
    const { url, expiresAt } = presignGet(base)
    const u = new URL(url)
    expect(u.origin).toBe('https://doop-mcp.example.com')
    expect(u.pathname).toBe('/doop-exports/exports/20261115/0123456789abcdef-My_Frame.png')
    expect(u.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256')
    expect(u.searchParams.get('X-Amz-Credential')).toBe('AKID/20261115/us-east-1/s3/aws4_request')
    expect(u.searchParams.get('X-Amz-Date')).toBe('20261115T100000Z')
    expect(u.searchParams.get('X-Amz-Expires')).toBe('86400')
    expect(u.searchParams.get('X-Amz-SignedHeaders')).toBe('host')
    expect(u.searchParams.get('X-Amz-Signature')).toMatch(/^[a-f0-9]{64}$/)
    expect(expiresAt.toISOString()).toBe('2026-11-16T10:00:00.000Z')
  })

  it('is deterministic and the signature binds host, key and expiry', () => {
    const sig = (over: object) => new URL(presignGet({ ...base, ...over }).url).searchParams.get('X-Amz-Signature')
    expect(sig({})).toBe(sig({}))
    expect(sig({ publicUrl: 'https://other.example.com' })).not.toBe(sig({}))
    expect(sig({ key: 'exports/20261115/0123456789abcdef-Other.png' })).not.toBe(sig({}))
    expect(sig({ ttlSeconds: 3600 })).not.toBe(sig({}))
    expect(sig({ secretAccessKey: 'other' })).not.toBe(sig({}))
  })

  it('signs the port when the public URL has a non-default one', () => {
    const a = new URL(presignGet({ ...base, publicUrl: 'http://localhost:9000' }).url)
    expect(a.host).toBe('localhost:9000')
  })
})

describe('export link config', () => {
  it('is off unless bucket, public URL and credentials are all set', () => {
    expect(exportLinksEnabled()).toBe(false)
    stubEnv('EXPORT_BUCKET', 'doop-exports')
    stubEnv('EXPORT_PUBLIC_URL', 'https://doop-mcp.example.com')
    expect(exportLinksEnabled()).toBe(false)
    stubEnv('ENDPOINT', 'http://minio:9000')
    stubEnv('ACCESS_KEY_ID', 'a')
    stubEnv('SECRET_ACCESS_KEY', 'b')
    expect(exportLinksEnabled()).toBe(true)
  })

  it('defaults the link lifetime to 24h, honours the variable, caps at 7 days', () => {
    expect(exportLinkTtlSeconds()).toBe(24 * 3600)
    stubEnv('EXPORT_LINK_TTL_SECONDS', '3600')
    expect(exportLinkTtlSeconds()).toBe(3600)
    stubEnv('EXPORT_LINK_TTL_SECONDS', String(30 * 24 * 3600))
    expect(exportLinkTtlSeconds()).toBe(7 * 24 * 3600)
  })
})
