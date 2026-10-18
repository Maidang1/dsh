/**
 * Learning loop in a real browser (docs/05-validation-and-release.md §4.4).
 * Requires `pnpm build` first so the UI and lessons are built.
 */
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { LAUNCH_TOKEN } from '../../../playwright.config'

test.describe.configure({ mode: 'serial' })

// The launch token is single-use, so one signed-in page is shared by the serial tests.
let page: Page
test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext()).newPage()
  await page.goto(`/?token=${LAUNCH_TOKEN}`)
})
test.afterAll(() => page.context().close())

test('runs the scenario and replays without re-executing', async () => {
  await page.getByRole('button', { name: '运行教学代码' }).click()
  await expect(page.getByText('运行结果：已完成')).toBeVisible({ timeout: 20_000 })

  // Default view is the scenario's final state, before settlement unloads everything.
  await expect(page.locator('.react-flow__node').filter({ hasText: 'agent-loop' })).toContainText('已激活')

  const runCount = async () => (await page.getByLabel('查看运行').locator('option').count())
  const before = await runCount()
  await page.getByRole('button', { name: '上一条记录' }).click()
  await page.getByRole('button', { name: '上一条记录' }).click()
  await page.getByRole('slider', { name: '回放位置' }).fill('0')
  await expect(page.locator('.react-flow__node').filter({ hasText: 'agent-loop' })).toContainText('本次运行未加载')
  expect(await runCount()).toBe(before)
})

test('compares the request before and after the contributor is mounted', async () => {
  await page.getByRole('tab', { name: '请求对比' }).click()
  await page.getByLabel('请求 A').selectOption({ index: 0 })
  await page.getByLabel('请求 B').selectOption({ index: 1 })
  await expect(page.locator('.diff__added', { hasText: '回答时使用短句' }).first()).toBeVisible()
})

test('keeps the run after a reload and offers a text list of the tree', async () => {
  await page.reload()
  await expect(page.getByText('运行结果：已完成')).toBeVisible()
  await page.getByLabel('列表视图').check()
  const list = page.getByRole('list', { name: '插件列表' })
  await expect(list).toContainText('prompt-contributor')
  await list.getByRole('button', { name: /^system-prompt/ }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('complementary', { name: '实例摘要' })).toContainText('提供systemPrompt')
})

test('rejects visitors without the launch token', async ({ browser }) => {
  const context = await browser.newContext()
  const response = await (await context.newPage()).goto('/api/state')
  expect(response?.status()).toBe(401)
  await context.close()
})
