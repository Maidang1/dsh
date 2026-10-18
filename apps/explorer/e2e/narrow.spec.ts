/** docs/01 §10: on a narrow screen the main panes switch by tabs instead of being squeezed. */
import { expect, test } from '@playwright/test'

test.use({ viewport: { width: 390, height: 844 } })

test('the workbench shows the tree or the summary, and selecting an instance opens its summary', async ({ page }) => {
  await page.goto('/')
  const tabs = page.getByRole('tablist', { name: '主区域' })
  const tree = page.locator('.workbench__tree')
  const summary = page.locator('.workbench__inspector')
  await expect(tabs).toBeVisible()
  await expect(tree).toBeVisible()
  await expect(summary).toBeHidden()

  await page.locator('.react-flow__node[data-id="agent-loop"]').click()
  await expect(summary).toBeVisible()
  await expect(tree).toBeHidden()
  await expect(tabs.getByRole('tab', { name: '实例摘要（agent-loop）' })).toHaveAttribute('aria-selected', 'true')

  await tabs.getByRole('tab', { name: '插件树' }).click()
  await expect(tree).toBeVisible()
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
})

test('wide screens show both panes and no pane tabs', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await expect(page.getByRole('tablist', { name: '主区域' })).toBeHidden()
  await expect(page.locator('.workbench__tree')).toBeVisible()
  await expect(page.locator('.workbench__inspector')).toBeVisible()
})
