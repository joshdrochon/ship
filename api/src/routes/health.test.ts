import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { createApp } from '../app.js'

describe('Health endpoint', () => {
  const app = createApp()

  it('returns ok status', async () => {
    const response = await request(app).get('/health')

    expect(response.status).toBe(200)
    expect(response.body.status).toBe('ok')
    expect(response.headers['content-type']).toMatch(/json/)
  })

  // Regression test for audit finding F26 (Implementation Rule 5).
  //
  // Before this, /health returned {"status":"ok"} and nothing else, so there was
  // no way to ask a running deployment which commit it was serving — the exact
  // gap that let three unrelated builds of the same source coexist without
  // anyone noticing. This fails if the field is ever dropped again.
  it('reports the build revision', async () => {
    const response = await request(app).get('/health')

    expect(response.body).toHaveProperty('revision')
    expect(typeof response.body.revision).toBe('string')
    expect(response.body.revision.length).toBeGreaterThan(0)
  })

  // The value comes from GIT_SHA, which the Dockerfile bakes in from a
  // --build-arg. Outside a CI-built image that variable is unset, and the field
  // must degrade to 'unknown' rather than disappear, be empty, or stringify as
  // "undefined" — local dev and `pnpm test` both take this branch.
  it('degrades to "unknown" when GIT_SHA is not baked into the build', async () => {
    const response = await request(app).get('/health')

    expect(response.body.revision).toBe(process.env.GIT_SHA || 'unknown')
  })
})
