/**
 * The main screens run without uncaught exceptions or console errors. A
 * thrown error in an effect or handler can leave a screen that still renders,
 * so tests that only look at the page would miss it.
 */
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

/** A draft (the workbench's, or a lesson's) that does not exist yet answers 404; the page then creates it. */
const EXPECTED = [/\/api\/drafts\/[^/]+$/]

function watch(page: Page) {
  const problems: string[] = []
  let failedResponses = 0
  let failedLoads = 0
  page.on('pageerror', error => problems.push(`pageerror: ${error.message}`))
  page.on('response', (response) => {
    if (response.status() < 400) return
    failedResponses++
    if (!EXPECTED.some(pattern => pattern.test(new URL(response.url()).pathname))) problems.push(`HTTP ${response.status()} ${response.url()}`)
  })
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    // The browser also reports each failed load on the console, without its URL.
    if (message.text().startsWith('Failed to load resource')) failedLoads++
    else problems.push(`console: ${message.text()}`)
  })
  // A failed load with no matching response is one the page could not see, e.g. the favicon.
  return () => [...problems, ...failedLoads > failedResponses ? [`${failedLoads - failedResponses} failed load(s) with no matching response`] : []]
}

test('workbench, a run and its comparison tabs', async ({ page, request, baseURL }) => {
  const problems = watch(page)
  const runsBefore = (await request.get('/api/runs').then(response => response.json()) as Array<{ runId: string }>).map(run => run.runId)
  await page.goto('/')
  await page.getByRole('button', { name: '运行教学代码' }).click()
  await expect(page.getByText('运行结果：已完成')).toBeVisible({ timeout: 20_000 })
  for (const layer of ['依赖', '运行数据', '组合']) await page.getByRole('group', { name: '图层' }).getByRole('button', { name: layer }).click()
  await page.getByRole('tab', { name: '请求对比' }).click()
  await page.getByRole('tab', { name: '执行轨迹' }).click()
  await page.getByRole('button', { name: '上一条记录' }).click()
  await page.locator('.react-flow__node[data-id="agent-loop"]').click()
  await page.getByRole('button', { name: '添加插件' }).click()
  expect(problems()).toEqual([])
  for (const run of await request.get('/api/runs').then(response => response.json()) as Array<{ runId: string }>) {
    if (!runsBefore.includes(run.runId)) await request.delete(`/api/runs/${run.runId}`, { headers: { origin: baseURL! } })
  }
})

test('every lesson and its side panels', async ({ page, request }) => {
  const problems = watch(page)
  const { lessons } = await request.get('/api/lessons').then(response => response.json()) as { lessons: Array<{ id: string; stages: unknown[] }> }
  for (const lesson of lessons) {
    await page.goto(`/plugin/${lesson.id}`)
    for (const tab of ['内部架构', '状态与数据', '上游对照']) await page.getByRole('tab', { name: tab }).click()
    for (let index = 1; index < lesson.stages.length; index++) await page.keyboard.press('ArrowRight')
  }
  expect(problems()).toEqual([])
})

test('lesson stage runs, run comparison, presets, scopes and the narrow layout', async ({ page, request, baseURL }) => {
  const problems = watch(page)
  const original = await request.get('/api/drafts/main').then(response => (response.ok() ? response.json() : null)) as ({ version: number } & Record<string, unknown>) | null
  const runsBefore = (await request.get('/api/runs').then(response => response.json()) as Array<{ runId: string }>).map(run => run.runId)

  await page.goto('/plugin/tool-guard?stage=tool-guard@02-deny')
  await page.getByRole('button', { name: '运行此阶段' }).click()
  await page.getByRole('tab', { name: '状态与数据' }).click()
  await expect(page.getByLabel('检查点对照')).toBeVisible({ timeout: 20_000 })
  await page.getByRole('link', { name: '返回组合' }).click()

  await page.getByRole('button', { name: '运行教学代码' }).click()
  await expect(page.getByText(/运行结果：/)).toBeVisible({ timeout: 20_000 })
  await page.getByRole('tab', { name: '请求对比' }).click()
  await page.getByLabel('对照运行').selectOption({ index: 1 })
  await page.locator('.run-diff summary', { hasText: '执行过程' }).click()

  const presets = page.getByRole('group', { name: '从预设开始' })
  await presets.getByLabel('预设组合').selectOption('scoped-chat')
  await presets.getByRole('button', { name: '载入预设…' }).click()
  await presets.getByRole('button', { name: '确认载入' }).click()
  await page.locator('.scope-editor summary').click()
  await page.locator('.react-flow__node[data-id="scoped-contributor"]').click()

  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('tablist', { name: '主区域' }).getByRole('tab', { name: '插件树' }).click()
  expect(problems()).toEqual([])

  if (original) {
    const { version: _version, ...draft } = original
    const { version } = await request.get('/api/drafts/main').then(response => response.json()) as { version: number }
    await request.put('/api/drafts/main', { data: { expectedVersion: version, draft }, headers: { origin: baseURL! } })
  }
  await request.put('/api/lessons/tool-guard/progress', { data: { lastStageId: '00-observe' }, headers: { origin: baseURL! } })
  for (const run of await request.get('/api/runs').then(response => response.json()) as Array<{ runId: string }>) {
    if (!runsBefore.includes(run.runId)) await request.delete(`/api/runs/${run.runId}`, { headers: { origin: baseURL! } })
  }
})
