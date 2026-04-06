import { chromium } from 'playwright';

const URL = 'http://localhost:5484/';
const SHOT_DIR = new URL('./screenshots', import.meta.url).pathname;

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // Open graph view - click the graph button
  const graphBtn = page.locator('button[aria-label="Graph View (Ctrl+G)"]').first();
  if (await graphBtn.count() === 0) {
    // Try clicking by text
    const btns = page.locator('button');
    const count = await btns.count();
    for (let i = 0; i < count; i++) {
      const title = await btns.nth(i).getAttribute('title');
      if (title?.includes('Graph')) {
        await btns.nth(i).click();
        break;
      }
    }
  } else {
    await graphBtn.click();
  }
  
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${SHOT_DIR}/graph-local.png`, fullPage: false });
  console.log('Screenshot: graph-local (Local mode)');

  // Try Global mode
  const globalTab = page.locator('.graph-tab:has-text("Global")');
  if (await globalTab.count() > 0) {
    await globalTab.click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${SHOT_DIR}/graph-global.png`, fullPage: false });
    console.log('Screenshot: graph-global (Global mode)');
  }

  // Try Hierarchy mode
  const hierTab = page.locator('.graph-tab:has-text("Hierarchy")');
  if (await hierTab.count() > 0) {
    await hierTab.click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${SHOT_DIR}/graph-hierarchy.png`, fullPage: false });
    console.log('Screenshot: graph-hierarchy (Hierarchy mode)');
  }

  // Switch back to Local
  const localTab = page.locator('.graph-tab:has-text("Local")');
  if (await localTab.count() > 0) {
    await localTab.click();
    await page.waitForTimeout(1500);
  }

  // Close graph and take screenshot of raw editor with line numbers
  const closeBtn = page.locator('#close-graph');
  if (await closeBtn.count() > 0) {
    await closeBtn.click();
    await page.waitForTimeout(500);
  }

  // Screenshot of the editor with raw pane (line numbers)
  await page.screenshot({ path: `${SHOT_DIR}/raw-editor-linenums.png`, fullPage: false });
  console.log('Screenshot: raw-editor-linenums');

  await browser.close();
  console.log('\nDone!');
}

run().catch(err => { console.error('Test failed:', err); process.exit(1); });
