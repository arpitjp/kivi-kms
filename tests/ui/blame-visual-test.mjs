import { chromium } from 'playwright';

const URL = 'http://localhost:5484/';
const SHOT_DIR = new URL('./screenshots', import.meta.url).pathname;

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  
  const errors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  const editor = page.locator('#editor .ProseMirror');
  await editor.waitFor({ state: 'visible' });

  async function shot(name, desc) {
    await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: false });
    console.log(`[${name}] ${desc}`);
  }

  async function clickAndShot(locator, name, desc) {
    if (await locator.count() > 0) {
      // Dismiss any open popup first
      await page.evaluate(() => {
        document.querySelector('.kivi-blame-popup')?.classList.remove('visible');
      });
      await locator.click({ force: true });
      await page.waitForTimeout(400);
      const anns = await page.locator('.kivi-blame-ann').all();
      const annInfo = anns.length > 0 
        ? `${anns.length} ann(s), text: "${(await anns[0].textContent())?.substring(0, 50)}"`
        : 'NO BLAME ANNOTATION';
      await shot(name, `${desc} — ${annInfo}`);
    } else {
      console.log(`[${name}] SKIP — element not found`);
    }
  }

  // 1. Initial state
  await shot('01-initial', 'Initial state (no click yet)');

  // 2. Click paragraph
  await clickAndShot(editor.locator('p').first(), '02-paragraph', 'Blame on paragraph');

  // 3. Click heading
  await clickAndShot(editor.locator('h1').first(), '03-heading', 'Blame on h1');
  await clickAndShot(editor.locator('h2').first(), '04-h2', 'Blame on h2');

  // 4. Click "See also" paragraph (has links, shorter text)
  const seeAlso = editor.locator('p:has(a)').first();
  await clickAndShot(seeAlso, '05-link-para', 'Blame on paragraph with links');

  // 5. Tags line
  await clickAndShot(editor.locator('p').nth(2), '06-tags', 'Blame on tags paragraph');

  // 6. List items
  const firstLi = editor.locator('ul li').first();
  await clickAndShot(firstLi, '07-list-first', 'Blame on first list item');
  const lastLi = editor.locator('ul li').last();
  await clickAndShot(lastLi, '08-list-last', 'Blame on last list item');

  // 7. Ordered list
  const oli = editor.locator('ol li').first();
  await clickAndShot(oli, '09-ordered-list', 'Blame on ordered list item');
  const oliLast = editor.locator('ol li').last();
  await clickAndShot(oliLast, '10-ordered-last', 'Blame on last ordered item');

  // 8. Code block
  await clickAndShot(editor.locator('pre').first(), '11-codeblock', 'Blame on code block');

  // 9. Blockquote
  await clickAndShot(editor.locator('blockquote').first(), '12-blockquote', 'Blame on blockquote');

  // 10. Last paragraph
  const allP = editor.locator('p');
  const pCount = await allP.count();
  if (pCount > 0) {
    await clickAndShot(allP.nth(pCount - 1), '13-last-para', 'Blame on last paragraph');
  }

  // 11. Hover blame to show popup
  const ann = page.locator('.kivi-blame-ann').first();
  if (await ann.count() > 0) {
    await ann.hover();
    await page.waitForTimeout(700);
    await shot('14-popup', 'Blame popup after hover');
    
    // Check popup details
    const popup = page.locator('.kivi-blame-popup');
    const popupVis = await popup.evaluate(el => getComputedStyle(el).display !== 'none');
    const popupBox = popupVis ? await popup.boundingBox() : null;
    console.log(`  Popup visible: ${popupVis}, bbox: ${JSON.stringify(popupBox)}`);
  }

  // 12. Check word wrap button
  const wrapBtn = page.locator('button[aria-label="Toggle word wrap"]');
  const wrapExists = await wrapBtn.count() > 0;
  console.log(`Word wrap button exists: ${wrapExists}`);
  if (wrapExists) {
    const wrapBox = await wrapBtn.boundingBox();
    console.log(`  Word wrap button bbox: ${JSON.stringify(wrapBox)}`);
  }

  // 13. Switch to live-only view and test
  const liveViewBtn = page.locator('[data-mode="live"]').first();
  if (await liveViewBtn.count() > 0) {
    await liveViewBtn.click();
    await page.waitForTimeout(500);
    await clickAndShot(editor.locator('p').first(), '15-live-view', 'Blame in live-only view');
    
    // More room for blame text in live view
    const liveAnn = page.locator('.kivi-blame-ann').first();
    if (await liveAnn.count() > 0) {
      const liveAnnBox = await liveAnn.boundingBox();
      const liveAnnText = await liveAnn.textContent();
      console.log(`  Live view ann: "${liveAnnText?.substring(0, 50)}" bbox: ${JSON.stringify(liveAnnBox)}`);
    }
  }

  // 14. Switch back to split and test markdown-only (blame should be hidden)
  const splitBtn = page.locator('[data-mode="split"]').first();
  if (await splitBtn.count() > 0) {
    await splitBtn.click();
    await page.waitForTimeout(500);
  }
  const mdViewBtn = page.locator('[data-mode="markdown"]').first();
  if (await mdViewBtn.count() > 0) {
    await mdViewBtn.click();
    await page.waitForTimeout(500);
    const mdAnns = await page.locator('.kivi-blame-ann').count();
    console.log(`Markdown-only view annotations: ${mdAnns} (should be 0)`);
    await shot('16-markdown-view', `Markdown only — ${mdAnns} anns`);
  }

  if (errors.length) {
    console.log('\n=== Console errors ===');
    errors.forEach(e => console.log(`  ERROR: ${e}`));
  }

  await browser.close();
  console.log('\nDone! Screenshots in:', SHOT_DIR);
}

run().catch(err => { console.error('Test failed:', err); process.exit(1); });
