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

  // Opening the lesson saved this stage as the reading position; the lesson spec starts from the beginning.
  const origin = { origin: new URL(page.url()).origin }
  await page.request.put('/api/lessons/prompt-contributor/progress', { data: { lastStageId: '00-entry' }, headers: origin })

  for (const run of await page.request.get('/api/runs').then(response => response.json()) as Array<{ runId: string }>) {
    if (!runsBefore.includes(run.runId)) await page.request.delete(`/api/runs/${run.runId}`, { headers: origin })
  }
})

test('a second tab learns about a run started in another tab without reloading', async ({ page, context }) => {
  const runsBefore = (await page.request.get('/api/runs').then(response => response.json()) as Array<{ runId: string }>).map(run => run.runId)
  const other = await context.newPage()
  await other.goto('/')
  await expect(other.getByRole('button', { name: '运行教学代码' })).toBeEnabled()
  const optionsBefore = await other.getByLabel('查看运行').locator('option').count()

  await page.goto('/')
  await page.getByRole('button', { name: '运行教学代码' }).click()
  await expect(page.getByText('运行结果：已完成')).toBeVisible({ timeout: 20_000 })
  const runId = await page.getByLabel('查看运行').inputValue()

  // The other tab only watches the runtime state stream; its run list follows.
  await expect(other.getByLabel('查看运行').locator(`option[value="${runId}"]`)).toHaveCount(1)
  expect(await other.getByLabel('查看运行').locator('option').count()).toBe(optionsBefore + 1)

  const origin = { origin: new URL(page.url()).origin }
  for (const run of await page.request.get('/api/runs').then(response => response.json()) as Array<{ runId: string }>) {
    if (!runsBefore.includes(run.runId)) await page.request.delete(`/api/runs/${run.runId}`, { headers: origin })
  }
})

test('an added tool is declared, called, and its result reaches the next request', async ({ page }) => {
  const runsBefore = (await page.request.get('/api/runs').then(response => response.json()) as Array<{ runId: string }>).map(run => run.runId)
  await page.goto('/')
  await page.getByRole('button', { name: '添加插件' }).click()
  await page.locator('.library__list li').filter({ hasText: 'calculator' }).getByRole('button', { name: '添加到根作用域' }).click()
  await page.getByLabel('场景').selectOption('tool-guard')
  await page.getByRole('button', { name: '运行教学代码' }).click()
  await expect(page.getByText('运行结果：已完成')).toBeVisible({ timeout: 20_000 })

  await page.getByRole('tab', { name: '请求对比' }).click()
  await page.getByLabel('请求 A').selectOption({ index: 0 })
  await page.getByLabel('请求 B').selectOption({ index: 1 })
  const diff = page.getByRole('region', { name: '请求对比' })
  // Both requests declare the tool; only B carries the call and its result.
  await expect(diff.getByRole('heading', { name: 'tools' }).locator('xpath=following-sibling::*[1]')).toHaveText('无差异')
  await expect(diff.locator('.diff__added', { hasText: '"role": "tool"' })).toHaveCount(1)
  await expect(diff.locator('.diff__added', { hasText: '"content": "3"' })).toHaveCount(1)

  const origin = { origin: new URL(page.url()).origin }
  for (const run of await page.request.get('/api/runs').then(response => response.json()) as Array<{ runId: string }>) {
    if (!runsBefore.includes(run.runId)) await page.request.delete(`/api/runs/${run.runId}`, { headers: origin })
  }
})

test('a lesson does not attribute a run of other code to the code it shows', async ({ page }) => {
  const runsBefore = (await page.request.get('/api/runs').then(response => response.json()) as Array<{ runId: string }>).map(run => run.runId)
  await page.goto('/')
  await page.getByRole('button', { name: '运行教学代码' }).click()
  await expect(page.getByText('运行结果：已完成')).toBeVisible({ timeout: 20_000 })
  const runId = await page.getByLabel('查看运行').inputValue()
  const origin = { origin: new URL(page.url()).origin }

  // The same stage id, recorded with another sourceHash: what an older build or another repository would export.
  const bundle = await page.request.get(`/api/runs/${runId}/export`).then(response => response.json())
  const copyId = `${runId}-old`
  bundle.manifest.runId = copyId
  bundle.manifest.startedAt = new Date(Date.now() + 1000).toISOString()
  bundle.manifest.loadedSourceHashes['prompt-contributor@02-section'] = `sha256:${'0'.repeat(64)}`
  for (const record of bundle.records) record.runId = copyId
  expect((await page.request.post('/api/imports', { data: bundle, headers: origin })).ok()).toBe(true)

  // Select the imported run in the workbench and enter the lesson in-app: the selection carries over.
  await page.reload()
  await page.getByLabel('查看运行').selectOption(copyId)
  await page.locator('.react-flow__node[data-id="prompt-contributor"]').click()
  await page.getByRole('link', { name: '进入插件实现' }).click()
  await page.getByRole('button', { name: '02-section' }).click()
  await expect(page.getByLabel('对应运行')).toHaveText(`所选运行 ${copyId} 执行的是此阶段的另一版代码`)
  await page.getByRole('tab', { name: '状态与数据' }).click()
  await expect(page.locator('.stage-state')).toContainText('sourceHash 000000000000')
  await expect(page.locator('.stage-state__requests')).toHaveCount(0)

  await page.request.put('/api/lessons/prompt-contributor/progress', { data: { lastStageId: '00-entry' }, headers: origin })
  for (const run of await page.request.get('/api/runs').then(response => response.json()) as Array<{ runId: string }>) {
    if (!runsBefore.includes(run.runId)) await page.request.delete(`/api/runs/${run.runId}`, { headers: origin })
  }
})
