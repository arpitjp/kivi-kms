import { chromium } from 'playwright';

const URL = 'http://localhost:5484/';
const SHOT_DIR = new URL('./screenshots', import.meta.url).pathname;

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  console.log('\n=== Blame Fix Visual Test ===\n');

  async function checkBlame(name) {
    await page.waitForTimeout(500);
    const anns = await page.locator('.kivi-blame-ann').count();
    const codeAnns = await page.locator('.kivi-blame-ann--code').count();
    console.log(`  ${name}: ${anns} blame (${codeAnns} code-specific)`);
    
    // Check overflow
    const editorBox = await page.locator('#editor').first().boundingBox();
    const allAnns = await page.locator('.kivi-blame-ann').all();
    for (const ann of allAnns) {
      const b = await ann.boundingBox();
      if (b && editorBox) {
        if (b.x + b.width > editorBox.x + editorBox.width + 2) {
          console.log(`  ⚠️  OVERFLOW: right edge at ${b.x + b.width}, editor at ${editorBox.x + editorBox.width}`);
        }
        if (b.x < editorBox.x - 2) {
          console.log(`  ⚠️  LEFT OVERFLOW`);
        }
      }
    }
    
    await page.screenshot({ path: `${SHOT_DIR}/blame-${name}.png`, fullPage: false });
  }

  // 1. Heading
  console.log('1. Heading');
  await page.locator('#editor .ProseMirror h1').first().click({ force: true });
  await checkBlame('heading');

  // 2. Paragraph
  console.log('2. Paragraph');
  await page.locator('#editor .ProseMirror p').first().click({ force: true });
  await checkBlame('paragraph');

  // 3. List item
  console.log('3. List item');
  await page.locator('#editor .ProseMirror li').first().click({ force: true });
  await checkBlame('list-item');

  // 4. Code block — click on FIRST line
  console.log('4. Code block first line');
  const codeEl = page.locator('#editor .ProseMirror pre code').first();
  if (await codeEl.count() > 0) {
    const box = await codeEl.boundingBox();
    if (box) {
      // Click near the start of the first line
      await page.mouse.click(box.x + 20, box.y + 8);
      await checkBlame('code-line1');
    }
  }

  // 5. Code block — click on SECOND (last) line
  console.log('5. Code block second line');
  if (await codeEl.count() > 0) {
    const box = await codeEl.boundingBox();
    if (box) {
      // Click near the bottom/last line
      await page.mouse.click(box.x + 20, box.y + box.height - 8);
      await checkBlame('code-line2');
    }
  }

  // 6. Blockquote
  console.log('6. Blockquote');
  const bq = page.locator('#editor .ProseMirror blockquote');
  if (await bq.count() > 0) {
    await bq.first().click({ force: true });
    await checkBlame('blockquote');
  }

  // 7. Ordered list item
  console.log('7. Ordered list');
  const olItem = page.locator('#editor .ProseMirror ol li').first();
  if (await olItem.count() > 0) {
    await olItem.click({ force: true });
    await checkBlame('ordered-list');
  }

  // 8. Last paragraph (That's it for now)
  console.log('8. Last paragraph');
  const paras = page.locator('#editor .ProseMirror p');
  const count = await paras.count();
  if (count > 0) {
    await paras.nth(count - 1).click({ force: true });
    await checkBlame('last-para');
  }

  // 9. Tags paragraph
  console.log('9. Tags paragraph');
  const tagP = page.locator('#editor .ProseMirror p:has-text("#editor")');
  if (await tagP.count() > 0) {
    await tagP.first().click({ force: true });
    await checkBlame('tags');
  }

  // 10. Test scrolling behaviour — scroll editor and check blame still works
  console.log('10. After scroll');
  await page.evaluate(() => {
    const ed = document.querySelector('#editor .ProseMirror');
    if (ed) ed.scrollTop += 100;
  });
  await page.locator('#editor .ProseMirror h1').first().click({ force: true });
  await checkBlame('after-scroll');

  await browser.close();
  console.log('\n=== Done! ===\n');
}

run().catch(err => { console.error('Test failed:', err); process.exit(1); });
