/**
 * The main screens run without uncaught exceptions or console errors. A
 * thrown error in an effect or handler can leave a screen that still renders,
 * so tests that only look at the page would miss it.
 */
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

/** A draft that does not exist yet answers 404; the page then creates it. That one is expected. */
const EXPECTED = [/\/api\/drafts\/main$/]

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
