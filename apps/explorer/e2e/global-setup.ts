/** Exchange the single-use launch token once and share the session cookie with every spec. */
import { request } from '@playwright/test'
import type { FullConfig } from '@playwright/test'
import { LAUNCH_TOKEN, STORAGE_STATE } from '../../../playwright.config'

export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]!.use.baseURL!
  const context = await request.newContext({ baseURL })
  const response = await context.get(`/?token=${LAUNCH_TOKEN}`, { maxRedirects: 0 })
  if (response.status() !== 302) throw new Error(`launch token exchange failed with ${response.status()}`)
  await context.storageState({ path: STORAGE_STATE })
  await context.dispose()
}
