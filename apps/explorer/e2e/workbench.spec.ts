/**
 * Learning loop in a real browser (docs/05-validation-and-release.md §4.4).
 * Requires `pnpm build` first so the UI and lessons are built.
 */
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { STORAGE_STATE } from '../../../playwright.config'

test.describe.configure({ mode: 'serial' })

// One page is shared by the serial tests; the session comes from global setup.
let page: Page
test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext({ storageState: STORAGE_STATE })).newPage()
  await page.goto('/')
})
test.afterAll(() => page.context().close())

test('runs the scenario and replays without re-executing', async () => {
  const runsBefore = (await page.request.get('/api/runs').then(response => response.json())).length
  await page.getByRole('button', { name: '运行教学代码' }).click()
  // Wait for this run, not an earlier one that also reads 已完成.
  await expect.poll(async () => (await page.request.get('/api/runs').then(response => response.json())) as Array<{ outcome: string }>, { timeout: 20_000 })
    .toEqual(expect.arrayContaining([expect.objectContaining({ outcome: 'completed' })]))
  await expect.poll(async () => (await page.request.get('/api/runs').then(response => response.json())).length).toBe(runsBefore + 1)
  await expect(page.getByLabel('查看运行')).toHaveValue(/^run-/)
  const latest = (await page.request.get('/api/runs').then(response => response.json()))[0] as { runId: string }
  await expect(page.getByLabel('查看运行')).toHaveValue(latest.runId)
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

test('exports the selected run and refuses to import it twice', async () => {
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('link', { name: '导出运行' }).click()
  const download = await downloadPromise
  const path = await download.path()
  const { readFile } = await import('node:fs/promises')
  const bundle = JSON.parse(await readFile(path!, 'utf8'))
  expect(bundle).toMatchObject({ schemaVersion: 1, manifest: { outcome: 'completed' } })
  expect(bundle.records.length).toBe(bundle.manifest.lastSeq + 1)

  await page.getByLabel('导入运行').setInputFiles(path!)
  await expect(page.locator('.banner--error')).toContainText('already exists')
  await page.getByRole('button', { name: '知道了' }).click()
})

test('offers the real model only when the key is configured', async () => {
  const real = page.getByLabel('模型').locator('option[value="real"]')
  await expect(real).toHaveJSProperty('disabled', true)
  await expect(real).toContainText('DEEPSEEK_API_KEY')
})

test('rejects visitors without the launch token', async ({ browser }) => {
  const context = await browser.newContext({ storageState: undefined })
  const response = await (await context.newPage()).goto('/api/state')
  expect(response?.status()).toBe(401)
  await context.close()
})
