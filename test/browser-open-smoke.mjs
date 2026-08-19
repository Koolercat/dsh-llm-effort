import { existsSync } from 'node:fs'
import { chromium } from 'playwright-core'

const url = process.env.DSH_URL
if (url === undefined) throw new Error('DSH_URL is required')

function installedChrome() {
  const candidates = [
    process.env.DSH_EFFORT_CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean)
  return candidates.find((candidate) => existsSync(candidate))
}

const executablePath = installedChrome()
if (executablePath === undefined) {
  if (process.env.DSH_EFFORT_BROWSER_SKIP === '1') {
    console.log('browser-open-smoke: no system Chrome/Chromium found; skipped by DSH_EFFORT_BROWSER_SKIP=1')
    process.exit(0)
  }
  throw new Error('browser-open-smoke: no system Chrome/Chromium found; install Chrome or set DSH_EFFORT_BROWSER_SKIP=1 to skip')
}

const browser = await chromium.launch({ executablePath, headless: true })
try {
  const context = await browser.newContext({ locale: 'zh-CN' })
  const page = await context.newPage()
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })

  async function clickFirstVisible(names, options = {}) {
    for (const name of names) {
      const locator = page.getByText(name, { exact: true }).first()
      try {
        await locator.waitFor({ state: 'visible', timeout: options.timeout ?? 1500 })
        await locator.click()
        return true
      } catch {
        // try the next localized label
      }
    }
    return false
  }

  // First-run onboarding owns the whole surface on first load and intercepts
  // pointer events, so dismiss it before trying to open Settings.
  await clickFirstVisible(['继续', 'Continue'], { timeout: 10000 })
  await clickFirstVisible(['稍后配置', 'Configure later'], { timeout: 5000 })

  // Open the settings panel. The trigger label is localized by the browser
  // locale; both dictionaries are attempted.
  const opened = await clickFirstVisible(['设置', 'Settings'], { timeout: 10000 })
  if (!opened) throw new Error('settings trigger not found')

  // Navigate to the plugin's own settings section.
  const navOpened = await clickFirstVisible(['Effort 管理', 'Effort Controls'], { timeout: 10000 })
  if (!navOpened) throw new Error('Effort settings nav entry not found')

  const headingVisible = await clickFirstVisible([
    '第三方模型 Effort 选项',
    'Third-party model effort options',
  ], { timeout: 10000 })
  if (!headingVisible) throw new Error('Effort section did not mount (heading not found)')

  // The smoke server configured a dummy pi-ai model before launching the
  // browser. Seeing the model row proves llm.models + settings scope rendered,
  // not just that the bundle downloaded.
  await page.getByText('smoke-model', { exact: true }).first().waitFor({ state: 'visible', timeout: 10000 })
  const modifyButton = page.getByRole('button', { name: /修改|Modify/ }).first()
  await modifyButton.waitFor({ state: 'visible', timeout: 10000 })
  await modifyButton.click()
  await page.getByText('low', { exact: true }).first().waitFor({ state: 'visible', timeout: 10000 })

  console.log('browser-open-smoke: Effort settings section mounted and model row opened')
  await context.close()
} catch (error) {
  const screenshot = process.env.DSH_EFFORT_BROWSER_SCREENSHOT ?? '/tmp/dsh-effort-browser-fail.png'
  try {
    const page = browser.contexts().flatMap((context) => context.pages())[0]
    if (page !== undefined) {
      await page.screenshot({ path: screenshot, fullPage: true })
      console.error('browser body text:', (await page.locator('body').innerText()).slice(0, 2000))
    }
  } catch {
    // screenshot is best-effort
  }
  throw error
} finally {
  await browser.close()
}
