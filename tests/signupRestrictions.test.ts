import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

let server: Server
let client: Client

function signUp(email: string, name: string) {
  return client.req('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { Origin: server.base },
    body: JSON.stringify({ email, password: 'password12345', name }),
  })
}

beforeAll(async () => {
  server = await startServer({ SIGNUP_EMAIL_DOMAINS: 'jointhetroops.com, partner.test, vip@solo.test' })
  client = new Client(server)
}, 70_000)

afterAll(() => server?.stop())

describe('signup domain restrictions', () => {
  it('allows configured email domains', async () => {
    const res = await signUp('person@jointhetroops.com', 'Allowed Person')
    expect(res.status, await res.text()).toBe(200)
  })

  it('rejects other domains without creating an account', async () => {
    const email = 'outsider@example.com'
    const res = await signUp(email, 'Outsider')
    expect(res.status).toBe(400)
    expect((await res.json()).message).toContain('@jointhetroops.com')

    const exists = await client.post('/api/account-exists', { email })
    expect(await exists.json()).toEqual({ exists: false })
  })

  it('accepts a configured full address but not other addresses on its domain', async () => {
    const ok = await signUp('VIP@solo.test', 'The One')
    expect(ok.status, await ok.text()).toBe(200)
    const no = await signUp('someone@solo.test', 'Someone Else')
    expect(no.status).toBe(400)
    expect((await no.json()).message).toContain('vip@solo.test')
  })
})
