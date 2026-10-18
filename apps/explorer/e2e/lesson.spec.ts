/**
 * 单插件学习闭环: enter a plugin, step through Code Hike stages, run a stage
 * and read the result bound to that stage (docs/05 §4.4 cases 3, 4, 10).
 */
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { STORAGE_STATE } from '../../../playwright.config'

test.describe.configure({ mode: 'serial' })

let page: Page
test.beforeAll(async ({ browser }) => {
  // Reduced motion: stage changes must stay recognisable without animation.
  page = await (await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1440, height: 1000 }, storageState: STORAGE_STATE })).newPage()
  await page.goto('/')
})
test.afterAll(() => page.context().close())

test('enters the plugin implementation from the workbench', async () => {
  await page.getByLabel('列表视图').check()
  await page.getByRole('list', { name: '插件列表' }).getByRole('button', { name: /^prompt-contributor/ }).click()
  await page.getByRole('link', { name: '进入插件实现' }).click()
  await expect(page.getByRole('heading', { name: '提示词贡献插件' })).toBeVisible()
  await expect(page.getByText('阶段 1/5 · 最小插件入口')).toBeVisible()
})

test('switches stages with the keyboard without running anything', async () => {
  const runs = await page.request.get('/api/runs').then(response => response.json())
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect(page.getByText('阶段 3/5 · 注册提示词片段')).toBeVisible()
  await expect(page.locator('.lesson__file')).toContainText('新增')
  await expect(page.locator('.code-mark:not(.code-mark--none)').first()).toBeVisible()
  await expect(page.locator('.lesson-code')).toContainText('ctx.systemPrompt.section({')
  expect(await page.request.get('/api/runs').then(response => response.json())).toHaveLength(runs.length)
})

test('runs stage 02 and shows the contributed section in its requests', async () => {
  await page.getByRole('button', { name: '运行此阶段' }).click()
  await page.getByRole('tab', { name: '状态与数据' }).click()
  await expect(page.locator('.stage-state')).toContainText('已完成', { timeout: 20_000 })
  await expect(page.locator('.stage-state__requests')).toContainText('回答时使用短句')
  await page.screenshot({ path: 'test-results/lesson-stage-02.png', fullPage: true })
})

test('flags a run that executed a different stage than the one being read', async () => {
  await page.getByRole('button', { name: '00-entry' }).click()
  await expect(page.locator('.stage-state')).toContainText('与当前阅读阶段 prompt-contributor@00-entry 不同')
})

test('shows upstream excerpts pinned to the baseline commit', async () => {
  await page.getByRole('button', { name: '02-section' }).click()
  await page.getByRole('tab', { name: '上游对照' }).click()
  const link = page.getByRole('link', { name: 'SystemPrompt.section' })
  await expect(link).toHaveAttribute('href', /687f282e8625c6b8d11ff58211a90524be2e4317\/packages\/core\/system-prompt\/src\/index\.ts#L478-L487/)
})
