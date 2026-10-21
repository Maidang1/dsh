/** docs/design/explorer-redesign.md §4 (screen ③): on a narrow screen the main
    panes switch between 插件树 | 详情 | 轨迹 tabs, the tree pane defaults to the
    layer-grouped list, and a mini transport bar sits under the main area. */
import { expect, test } from '@playwright/test'

test.use({ viewport: { width: 390, height: 844 } })

test('the workbench shows tree/detail/trace tabs; selecting an instance opens its detail', async ({ page }) => {
  await page.goto('/')
  const tabs = page.getByRole('tablist', { name: '主区域' })
  const tree = page.locator('.workbench__tree')
  const summary = page.locator('.workbench__inspector')
  const trace = page.locator('.workbench__trace')
  await expect(tabs).toBeVisible()
  await expect(tabs.getByRole('tab', { name: '插件树' })).toHaveAttribute('aria-selected', 'true')
  await expect(tree).toBeVisible()
  await expect(summary).toBeHidden()
  await expect(trace).toBeHidden()

  // The tree pane defaults to the layer-grouped list view (L1–L4).
  const list = page.getByRole('list', { name: '插件列表' })
  await expect(list).toBeVisible()
  await expect(list).toContainText('L1')
  await expect(list).toContainText('基础服务')
  await expect(list).toContainText('L4')
  await expect(list).toContainText('编排')

  // A finished run populates the mini transport bar, the meta line and the trace tab.
  const runsBefore = (await page.request.get('/api/runs').then(response => response.json())).length
  await page.getByRole('button', { name: '运行教学代码' }).click()
  await expect.poll(async () => (await page.request.get('/api/runs').then(response => response.json())).length, { timeout: 20_000 }).toBe(runsBefore + 1)
  await expect.poll(async () => ((await page.request.get('/api/runs').then(response => response.json())) as Array<{ outcome: string }>)[0]?.outcome, { timeout: 20_000 }).toBe('completed')

  await expect(page.locator('.run-bar__meta')).toContainText(/run-[\w-]+ · 回放 #\d+/)
  await expect(page.getByRole('button', { name: '播放回放' })).toBeVisible()
  await expect(page.getByRole('button', { name: '上一条记录' })).toBeVisible()
  await expect(page.getByRole('button', { name: '下一条记录' })).toBeVisible()
  await expect(page.getByRole('slider', { name: '回放位置' })).toBeAttached()
  await expect(page.locator('.replay-bar__position')).toContainText(/步骤 \d+ \/ \d+/)
  await expect(page.locator('.replay-bar__position')).toContainText(/请求 #\d+/)

  // Nodes the request flowed through carry window step badges (④⑤ style).
  await expect(list.getByRole('button', { name: /^llm → llm/ })).toContainText(/[①-⑳]/)

  // Selecting a row opens the 详情 tab with its summary.
  await list.getByRole('button', { name: /^agent-loop/ }).click()
  await expect(summary).toBeVisible()
  await expect(tree).toBeHidden()
  await expect(tabs.getByRole('tab', { name: '详情' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('complementary', { name: '实例摘要' })).toContainText('agent-loop')

  // The 轨迹 tab shows the same records as the wide drawer.
  await tabs.getByRole('tab', { name: '轨迹' }).click()
  await expect(trace).toBeVisible()
  await expect(summary).toBeHidden()
  await expect(trace).toContainText('执行轨迹 ·')
  await expect(trace.getByRole('list', { name: /轨迹记录/ })).toBeVisible()

  // Back to the tree; the mini transport bar stays visible on every tab.
  await tabs.getByRole('tab', { name: '插件树' }).click()
  await expect(tree).toBeVisible()
  await expect(page.getByRole('button', { name: '播放回放' })).toBeVisible()

  await page.screenshot({ path: 'test-results/narrow-workbench.png' })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
})

test('a lesson shows the code or the side panel, never both squeezed', async ({ page }) => {
  await page.goto('/plugin/prompt-contributor')
  const tabs = page.getByRole('tablist', { name: '主区域' })
  await expect(page.locator('.lesson__code')).toBeVisible()
  await expect(page.locator('.lesson__side')).toBeHidden()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.screenshot({ path: 'test-results/narrow-lesson.png' })
  await tabs.getByRole('tab', { name: '架构、状态与上游' }).click()
  await expect(page.locator('.lesson__side')).toBeVisible()
  await expect(page.locator('.lesson__code')).toBeHidden()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
})

test('wide screens show both panes and no pane tabs', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await expect(page.getByRole('tablist', { name: '主区域' })).toBeHidden()
  await expect(page.locator('.workbench__tree')).toBeVisible()
  await expect(page.locator('.workbench__inspector')).toBeVisible()
  await expect(page.locator('.workbench__trace')).toBeHidden()
})
