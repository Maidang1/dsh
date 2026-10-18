/**
 * Interaction targets of docs/02 §14: ordinary clicks give visible feedback
 * within 100 ms, and adding a node keeps the viewport. Feedback is timed in
 * the page, from the click to the first animation frame after the DOM shows
 * the change, so test-runner round trips are not counted.
 */
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const FEEDBACK_MS = 100

/** Click `selector` in the page and time until `done` holds, then one more frame. */
async function feedback(page: Page, selector: string, done: string): Promise<number> {
  return page.evaluate(async ({ selector, done }) => {
    const holds = () => document.querySelector(done) !== null
    const start = performance.now()
    const changed = new Promise<void>(resolve => {
      const observer = new MutationObserver(() => {
        if (holds()) { observer.disconnect(); resolve() }
      })
      observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
    })
    ;(document.querySelector(selector) as HTMLElement).click()
    if (!holds()) await changed
    await new Promise(resolve => requestAnimationFrame(resolve))
    return performance.now() - start
  }, { selector, done })
}

test('ordinary clicks give feedback within 100 ms', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.react-flow__node').filter({ hasText: 'agent-loop' })).toBeVisible()
  const timings: Record<string, number[]> = { layer: [], select: [] }
  for (let round = 0; round < 3; round++) {
    timings.layer!.push(await feedback(page, '[aria-label="图层"] button:nth-child(2)', '[aria-label="图层"] button:nth-child(2)[aria-pressed="true"]'))
    timings.layer!.push(await feedback(page, '[aria-label="图层"] button:nth-child(1)', '[aria-label="图层"] button:nth-child(1)[aria-pressed="true"]'))
    timings.select!.push(await feedback(page, '.react-flow__node[data-id="agent-loop"]', '.inspector h2'))
    await page.locator('.react-flow__pane').click({ position: { x: 5, y: 5 } })
    await expect(page.locator('.inspector h2')).toHaveCount(0)
  }
  console.log('click feedback (ms)', JSON.stringify(timings, (_key, value: unknown) => typeof value === 'number' ? Math.round(value) : value))
  for (const values of Object.values(timings)) expect(Math.max(...values)).toBeLessThan(FEEDBACK_MS)
})

test('adding a plugin keeps the viewport', async ({ page }) => {
  await page.goto('/')
  const viewport = page.locator('.react-flow__viewport')
  await expect(page.locator('.react-flow__node').filter({ hasText: 'agent-loop' })).toBeVisible()
  await page.getByRole('button', { name: 'zoom out' }).click()
  await page.getByRole('button', { name: 'zoom out' }).click()
  const before = await viewport.evaluate(element => getComputedStyle(element).transform)

  await page.getByRole('button', { name: '添加插件' }).click()
  await page.locator('.library__list li').filter({ hasText: 'calculator' }).getByRole('button', { name: '添加到根作用域' }).click()
  const added = page.locator('.react-flow__node').filter({ hasText: 'calculator' })
  await expect(added).toBeVisible()
  expect(await viewport.evaluate(element => getComputedStyle(element).transform)).toBe(before)

  // Leave the draft as the other specs expect it.
  await added.click()
  await page.getByRole('button', { name: '从组合中移除…' }).click()
  await page.getByRole('button', { name: '确认移除' }).click()
  await expect(added).toHaveCount(0)
})

test('adds a plugin together with the providers of its missing services', async ({ page }) => {
  const original = await page.request.get('/api/drafts/main').then(response => response.json()) as { version: number }
  await page.goto('/')
  const node = (name: string) => page.locator(`.react-flow__node[data-id="${name}"]`)
  await node('tools').click()
  await page.getByRole('button', { name: '从组合中移除…' }).click()
  const confirm = page.getByRole('group', { name: '确认从组合中移除' })
  await expect(confirm).toContainText('受影响的消费者：agent-loop（需要 tools）')
  await page.getByRole('button', { name: '确认移除' }).click()
  await expect(node('tools')).toHaveCount(0)

  await page.getByRole('button', { name: '添加插件' }).click()
  const entry = page.locator('.library__list li').filter({ hasText: 'calculator' })
  await expect(entry).toContainText('根作用域缺少：tools')
  await expect(entry).toContainText('可同时添加：tools（提供 tools）')
  await entry.getByRole('button', { name: '同时添加依赖（共 2 个实例）' }).click()
  await expect(node('tools')).toBeVisible()
  await expect(node('calculator')).toBeVisible()

  // Restore the draft the other specs expect.
  const { version: _version, ...draft } = original
  const { version } = await page.request.get('/api/drafts/main').then(response => response.json()) as typeof original
  const response = await page.request.put('/api/drafts/main', { data: { expectedVersion: version, draft }, headers: { origin: new URL(page.url()).origin } })
  expect(response.ok()).toBe(true)
})

test('filters the plugin library by responsibility', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '添加插件' }).click()
  const filter = page.getByRole('group', { name: '按职责筛选' })
  const names = page.locator('.library__list li strong')
  await filter.getByRole('button', { name: '工具' }).click()
  await expect(names).toHaveText(['tools', 'calculator'])
  await filter.getByRole('button', { name: '事件策略' }).click()
  await expect(names).toHaveText(['tool-guard'])
  await filter.getByRole('button', { name: '全部' }).click()
  await expect(names).toHaveCount(10)
})
