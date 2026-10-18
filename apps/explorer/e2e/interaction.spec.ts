/**
 * Interaction targets of docs/02 §14: ordinary clicks give visible feedback
 * within 100 ms, and adding a node keeps the viewport. Feedback is timed in
 * the page, from the click to the first animation frame after the DOM shows
 * the change, so test-runner round trips are not counted.
 */
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const FEEDBACK_MS = 100

// Tests here edit the draft; put it back so the other specs see the preset composition.
// Before the first page load the draft does not exist yet, and the page creates it.
let original: ({ version: number } & Record<string, unknown>) | null
test.beforeEach(async ({ request }) => {
  const response = await request.get('/api/drafts/main')
  original = response.ok() ? await response.json() : null
})
test.afterEach(async ({ request, baseURL }) => {
  if (!original) return
  const { version: _version, ...draft } = original
  const { version } = await request.get('/api/drafts/main').then(response => response.json()) as { version: number }
  if (version === original.version) return
  const response = await request.put('/api/drafts/main', { data: { expectedVersion: version, draft }, headers: { origin: baseURL! } })
  expect(response.ok(), await response.text()).toBe(true)
})

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

  await added.click()
  await page.getByRole('button', { name: '从组合中移除…' }).click()
  await page.getByRole('button', { name: '确认移除' }).click()
  await expect(added).toHaveCount(0)
})

test('adds a plugin together with the providers of its missing services', async ({ page }) => {
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

test('shows a waiting instance as waiting for a service and offers its provider', async ({ page }) => {
  await page.goto('/')
  const node = (name: string) => page.locator(`.react-flow__node[data-id="${name}"]`)
  await node('tools').click()
  await page.getByRole('button', { name: '从组合中移除…' }).click()
  await page.getByRole('button', { name: '确认移除' }).click()
  await expect(node('tools')).toHaveCount(0)

  const runsBefore = (await page.request.get('/api/runs').then(response => response.json()) as Array<{ runId: string }>).map(run => run.runId)
  await page.getByRole('button', { name: '运行教学代码' }).click()
  await expect(page.getByText(/运行结果：/)).toBeVisible({ timeout: 20_000 })
  await expect(node('agent-loop')).toContainText('等待服务')
  await node('agent-loop').click()
  const fix = page.getByLabel('修复建议')
  await expect(fix).toContainText('缺少服务 tools')
  await fix.getByRole('button', { name: '添加提供者：tools' }).click()
  // The provider goes into the draft; the run keeps the composition it ran.
  await page.getByLabel('查看运行').selectOption('')
  await expect(node('tools')).toBeVisible()

  // Lesson stage runs start from the selected (latest) run's composition; do not leave this one behind.
  for (const run of await page.request.get('/api/runs').then(response => response.json()) as Array<{ runId: string }>) {
    if (runsBefore.includes(run.runId)) continue
    const response = await page.request.delete(`/api/runs/${run.runId}`, { headers: { origin: new URL(page.url()).origin } })
    expect(response.ok()).toBe(true)
  }

})

test('a trace record leads to its instance and the code of the stage that ran', async ({ page }) => {
  const runsBefore = (await page.request.get('/api/runs').then(response => response.json()) as Array<{ runId: string }>).map(run => run.runId)
  await page.goto('/')
  await page.getByRole('button', { name: '运行教学代码' }).click()
  await expect(page.getByText('运行结果：已完成')).toBeVisible({ timeout: 20_000 })
  const runId = await page.getByLabel('查看运行').inputValue()
  const { records } = await page.request.get(`/api/runs/${runId}/trace`).then(response => response.json()) as { records: Array<{ seq: number; instanceId?: string }> }
  const target = records.find(record => record.instanceId === 'prompt-contributor')!

  await page.getByRole('slider', { name: '回放位置' }).fill(String(target.seq))
  const current = page.getByLabel('当前记录')
  await expect(current).toContainText(`当前记录 #${target.seq}`)
  await expect(current).toContainText('实例 prompt-contributor（本次运行的阶段 prompt-contributor@02-section）')
  await current.getByRole('button', { name: '在插件树中选中' }).click()
  await expect(page.locator('.inspector h2')).toHaveText('prompt-contributor')
  await current.getByRole('link', { name: '查看该阶段代码' }).click()
  await expect(page.getByText(/^阶段 \d\/\d · 注册提示词片段$/)).toBeVisible()

  for (const run of await page.request.get('/api/runs').then(response => response.json()) as Array<{ runId: string }>) {
    if (!runsBefore.includes(run.runId)) await page.request.delete(`/api/runs/${run.runId}`, { headers: { origin: new URL(page.url()).origin } })
  }
})
