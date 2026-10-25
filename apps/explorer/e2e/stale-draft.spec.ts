/**
 * A draft saved by an older content version names stages the catalog no
 * longer has; loading the workbench resets it instead of failing every run.
 */
import { expect, test } from '@playwright/test'

test('resets a draft whose stages are no longer in the catalog', async ({ page, baseURL }) => {
  // The server refuses writes without a same-origin Origin header.
  const headers = { origin: baseURL! }
  const original = await page.request.get('/api/drafts/main').then(response => response.json())
  const stale = {
    ...original,
    composition: {
      ...original.composition,
      instances: original.composition.instances.map((instance: { stageId: string }) => ({ ...instance, stageId: instance.stageId.replace(/@.*$/, '@retired') })),
    },
  }
  delete stale.version
  const response = await page.request.put('/api/drafts/main', { headers, data: { expectedVersion: original.version, draft: stale } })
  expect(response.ok()).toBe(true)
  const saved = await response.json()

  try {
    await page.goto('/')
    await expect(page.getByText(/草稿来自旧版本内容（未知阶段 .*@retired/)).toBeVisible()
    const reset = await page.request.get('/api/drafts/main').then(response => response.json())
    expect(reset.version).toBe(saved.version + 1)
    expect(reset.composition.instances.some((instance: { stageId: string }) => instance.stageId.endsWith('@retired'))).toBe(false)
  } finally {
    const current = await page.request.get('/api/drafts/main').then(response => response.json())
    const { version: _, ...restored } = original
    await page.request.put('/api/drafts/main', { headers, data: { expectedVersion: current.version, draft: restored } })
  }
})
