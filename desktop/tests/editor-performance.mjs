import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = await mkdtemp(join(tmpdir(), 'bidoytu-editor-'))
const env = { ...process.env, BIDOYTU_DATA_DIR: dir, BIDOYTU_TEST: '1' }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: ['.', `--user-data-dir=${join(dir, 'electron')}`], env })
try {
  const page = await app.firstWindow()
  // The desktop now opens at the session picker. Create an isolated session
  // before measuring the renderer, matching the normal application flow.
  await page.getByRole('button', { name: 'Create session', exact: true }).click()
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stop proxy', exact: true })).toBeVisible({
    timeout: 30000,
  })
  await page.getByRole('button', { name: 'Decoder', exact: true }).click()
  await page.getByRole('combobox').selectOption('url.decode')
  await page.getByRole('textbox', { name: 'Input editor' }).evaluate((element) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(
      element,
      'line%0A'.repeat(20000),
    )
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const start = Date.now()
  await page.getByRole('button', { name: 'Transform', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Output message' })).toBeVisible()
  const report = {
    lines: 20000,
    rendered_lines: await page.locator('.code-line').count(),
    switch_ms: Date.now() - start,
  }
  console.log(JSON.stringify(report))
  await mkdir('test-results', { recursive: true })
  await writeFile(
    `test-results/editor-${process.env.BENCHMARK_LABEL || 'current'}.json`,
    JSON.stringify(report, null, 2),
  )
} finally {
  await app.close()
  await rm(dir, { recursive: true, force: true })
}
