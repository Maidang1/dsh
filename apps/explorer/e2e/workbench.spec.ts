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

test('renders only the visible part of a long trace and follows the cursor', async () => {
  const total = (await page.request.get('/api/runs').then(response => response.json()))[0].lastSeq + 1
  const rows = page.locator('.timeline__row')
  expect(await rows.count()).toBeLessThan(total)
  await page.getByRole('slider', { name: '回放位置' }).fill('0')
  await expect(page.locator('.timeline__row.is-current')).toContainText('#0')
  await page.getByRole('button', { name: '到最新（含结算）' }).click()
  await expect(page.locator('.timeline__row.is-current')).toContainText(`#${total - 1}`)
  await page.getByRole('list', { name: /轨迹记录/ }).focus()
  await page.keyboard.press('ArrowUp')
  await expect(page.locator('.timeline__row.is-current')).toContainText(`#${total - 2}`)
  await expect(page.getByText(`回放位置 ${total - 2} /`)).toBeVisible()
})

test('plays the replay at a chosen speed and pauses without running anything', async () => {
  const runsBefore = (await page.request.get('/api/runs').then(response => response.json())).length
  const position = async () => Number((await page.getByText(/^回放位置 -?\d+ \//).textContent())!.match(/-?\d+/)![0])
  await page.getByRole('slider', { name: '回放位置' }).fill('0')
  await page.getByLabel('速度').selectOption('4')
  await page.getByRole('button', { name: '播放回放' }).click()
  await expect.poll(position).toBeGreaterThan(3)
  await page.getByRole('button', { name: '暂停回放' }).click()
  const paused = await position()
  await page.waitForTimeout(400)
  expect(await position()).toBe(paused)
  expect((await page.request.get('/api/runs').then(response => response.json())).length).toBe(runsBefore)
})

test('lists the lifecycle history of an instance and jumps to a transition', async () => {
  await page.getByLabel('列表视图').check()
  await page.getByRole('list', { name: '插件列表' }).getByRole('button', { name: /^prompt-contributor/ }).click()
  const history = page.getByRole('list', { name: /状态变化/ })
  const activation = history.getByRole('button', { name: /已激活.*步骤 mount$/ })
  await expect(activation).toBeVisible()
  await expect(history).toContainText('步骤 unmount')
  const seq = (await activation.textContent())!.match(/#(\d+)/)![1]
  await activation.click()
  await expect(page.getByText(`回放位置 ${seq} /`)).toBeVisible()
  await expect(activation).toHaveAttribute('aria-current', 'step')
  await page.getByLabel('列表视图').uncheck()
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

test('pins and deletes runs and shows the storage usage', async () => {
  await expect(page.getByText(/运行记录 \d+ 个/)).toBeVisible()
  await page.getByLabel('保留').check()
  await expect.poll(async () => (await page.request.get('/api/storage').then(response => response.json())).pinned.length).toBe(1)
  await page.getByLabel('保留').uncheck()
  const before = (await page.request.get('/api/runs').then(response => response.json())).length
  page.once('dialog', dialog => void dialog.accept())
  await page.getByRole('button', { name: '删除运行' }).click()
  await expect.poll(async () => (await page.request.get('/api/runs').then(response => response.json())).length).toBe(before - 1)
  await expect(page.getByLabel('查看运行')).toHaveValue('')
})

test('rejects visitors without the launch token', async ({ browser }) => {
  const context = await browser.newContext({ storageState: undefined })
  const response = await (await context.newPage()).goto('/api/state')
  expect(response?.status()).toBe(401)
  await context.close()
})
