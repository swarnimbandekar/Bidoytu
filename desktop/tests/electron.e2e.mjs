import { _electron as electron, expect } from '@playwright/test'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = await mkdtemp(join(tmpdir(), 'bidoytu-e2e-'))
await mkdir('test-results', { recursive: true })
const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(
    JSON.stringify(
      { application: 'Bidoytu integration fixture', path: request.url, ok: true },
      null,
      2,
    ),
  )
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const env = { ...process.env, BIDOYTU_DATA_DIR: dir, BIDOYTU_TEST: '1' }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch(
  process.env.BIDOYTU_PACKAGED
    ? {
        executablePath: process.env.BIDOYTU_PACKAGED,
        args: [`--user-data-dir=${join(dir, 'electron')}`],
        env,
      }
    : { args: ['.', `--user-data-dir=${join(dir, 'electron')}`], env },
)
const page = await app.firstWindow()
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
try {
  await expect(page.getByRole('button', { name: 'Create session', exact: true })).toBeVisible()
  await page.evaluate(async () => {
    await window.bidoytu.createSession('E2E session')
  })
  await expect(page.getByRole('button', { name: 'Stop proxy', exact: true })).toBeVisible({
    timeout: 30000,
  })
  await expect(page.getByText('HTTP history', { exact: true }).first()).toBeVisible()
  // Renderer preferences can survive across Electron test profiles on some
  // platforms; reset them so the remainder of this workflow is deterministic.
  await page.getByRole('button', { name: /^Filters/ }).click()
  const startupFilterDialog = page.getByRole('dialog', { name: 'Advanced HTTP history filter' })
  await expect(startupFilterDialog).toBeVisible()
  await page.getByRole('button', { name: 'Reset all' }).click()
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(startupFilterDialog).toBeHidden()
  const security = await app.evaluate(({ BrowserWindow }) => {
    const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()
    return {
      sandbox: prefs.sandbox,
      contextIsolation: prefs.contextIsolation,
      nodeIntegration: prefs.nodeIntegration,
    }
  })
  expect(security).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false })
  expect(await page.evaluate(() => typeof window.require)).toBe('undefined')
  await page.getByRole('button', { name: 'Repeater', exact: true }).click()
  await page.getByRole('textbox', { name: 'Repeater target URL' }).fill(`http://127.0.0.1:${port}`)
  await page
    .getByRole('textbox', { name: 'Request editor' })
    .fill(
      `GET /api/workspaces HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAccept: application/json\r\n\r\n`,
    )
  const repeaterEditor = page.getByRole('textbox', { name: 'Request editor' })
  await repeaterEditor.click({ position: { x: 32, y: 12 } })
  expect(
    await repeaterEditor.evaluate(
      (element) =>
        document.activeElement === element && element.selectionStart === element.selectionEnd,
    ),
  ).toBe(true)
  await page.getByRole('button', { name: /^Send Ctrl/ }).click()
  await expect(page.getByRole('textbox', { name: 'Response editor' })).toHaveValue(
    /Bidoytu integration fixture/,
  )
  // Ctrl+R duplicates the active Repeater request into a new tab.
  await page.keyboard.press('Control+r')
  await expect(page.getByRole('button', { name: 'Request 1 (1)', exact: true })).toBeVisible()
  // Ctrl+I forwards the active request to a new Intruder attack.
  await page.keyboard.press('Control+i')
  await expect(page.getByText('Intruder', { exact: true }).first()).toBeVisible()
  const intruderEditor = page.getByRole('textbox', { name: 'Request template editor' })
  await intruderEditor.click({ position: { x: 32, y: 12 } })
  expect(
    await intruderEditor.evaluate(
      (element) =>
        document.activeElement === element && element.selectionStart === element.selectionEnd,
    ),
  ).toBe(true)
  await expect(page.getByRole('button', { name: 'Request 1 (1)', exact: true })).toBeVisible()
  // Ctrl+I again duplicates the active Intruder attack.
  await page.keyboard.press('Control+i')
  await expect(page.getByRole('button', { name: 'Request 1 (2)', exact: true })).toBeVisible()
  await page.getByRole('button', { name: /^Proxy/ }).click()
  await page.getByRole('tab', { name: 'HTTP history' }).click()
  console.log('Python replay and global shortcuts verified.')
  await expect(page.getByRole('button', { name: 'Stop proxy', exact: true })).toBeVisible({
    timeout: 30000,
  })
  if (await page.getByRole('button', { name: 'Stop proxy', exact: true }).isVisible())
    await page.getByRole('button', { name: 'Stop proxy', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Start proxy', exact: true })).toBeVisible({
    timeout: 30000,
  })
  const reservation = createServer()
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve))
  const proxyPort = reservation.address().port
  await new Promise((resolve) => reservation.close(resolve))
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('spinbutton', { name: 'Proxy port' }).fill(String(proxyPort))
  await page.getByRole('button', { name: /^Proxy/ }).click()
  await page.getByRole('button', { name: 'Start proxy', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stop proxy', exact: true })).toBeVisible({
    timeout: 30000,
  })
  const proxyResponse = await new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port: proxyPort,
        path: `http://127.0.0.1:${port}/proxy-fixture`,
        headers: { host: `127.0.0.1:${port}` },
      },
      (response) => {
        let body = ''
        response.on('data', (chunk) => (body += chunk))
        response.on('end', () => resolve(body))
      },
    )
    request.on('error', reject)
    request.end()
  })
  expect(proxyResponse).toContain('/proxy-fixture')
  await page.getByRole('button', { name: 'Stop proxy', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Start proxy', exact: true })).toBeVisible()
  await page.getByRole('button', { name: /^Proxy/ }).click()
  await page.getByRole('tab', { name: 'HTTP history' }).click()
  console.log('Real proxy capture and shutdown verified.')
  await page
    .getByRole('button')
    .filter({ hasText: /GET127\.0\.0\.1/ })
    .filter({ hasText: '/api/workspaces' })
    .first()
    .click()
  await expect(page.getByRole('region', { name: 'Response message' })).toContainText(
    '/api/workspaces',
  )
  await page.getByRole('button', { name: 'Bookmark selected request' }).click()
  await page.getByRole('button', { name: 'Show bookmarked traffic' }).click()
  await expect(
    page
      .getByRole('button')
      .filter({ hasText: /GET127\.0\.0\.1/ })
      .filter({ hasText: '/api/workspaces' })
      .first(),
  ).toBeVisible()
  await page.getByRole('button', { name: /^Filters/ }).click()
  const filterDialog = page.getByRole('dialog', { name: 'Advanced HTTP history filter' })
  await expect(filterDialog).toBeVisible()
  await filterDialog.locator('label').filter({ hasText: '2xx' }).locator('input').uncheck()
  await expect(page.getByText('No matching requests')).toBeVisible()
  await expect(filterDialog.getByText(/0 of \d+ requests/)).toBeVisible()
  await page.getByRole('button', { name: 'Reset all' }).click()
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(filterDialog).toBeHidden()
  await page.getByRole('button', { name: 'Decoder', exact: true }).click()
  await page.getByRole('textbox', { name: 'Input editor' }).fill('Ymlkb3l0dQ==')
  await page.getByRole('button', { name: 'Transform', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Output message' })).toContainText('bidoytu')
  await page.getByRole('button', { name: 'Target scope', exact: true }).click()
  await page.getByRole('textbox', { name: 'Included hosts' }).fill('127.0.0.1')
  await page.getByRole('button', { name: 'Save scope' }).click()
  await expect(page.getByRole('status')).toContainText('Target scope saved')
  await page.getByRole('button', { name: /^Proxy/ }).click()
  await page.getByRole('tab', { name: 'HTTP history' }).click()
  await page.screenshot({ path: 'test-results/desktop-history.png' })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 760))
  await page.screenshot({ path: 'test-results/desktop-compact.png' })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(errors).toEqual([])
  console.log(
    'Electron E2E passed: sandbox, real Python replay, history, filters, bookmark, decoder, scope, responsive layout.',
  )
} finally {
  await app.close()
  await new Promise((resolve) => server.close(resolve))
  await rm(dir, { recursive: true, force: true })
}
