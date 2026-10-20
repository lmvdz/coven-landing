import { test, expect } from '@playwright/test';

test.use({ reducedMotion: 'reduce' });

test('release metadata supplies distinct platform versions and only evidenced checksums', async ({ page }) => {
  const artifacts = [
    { slot: 'mac-arm64', name: 'Cave-v9.8.7-aarch64.dmg', release_tag: 'v9.8.7' },
    { slot: 'mac-x64', name: 'Cave-v9.8.6-x86_64.dmg', release_tag: 'v9.8.6' },
    { slot: 'win-x64', name: 'Cave_9.8.5_x64_en-US.msi', release_tag: 'v9.8.5' },
    { slot: 'linux-amd64', name: 'Cave_9.8.4_amd64.AppImage', release_tag: 'v9.8.4' },
  ];
  await page.route('**/api/site-stats', (route) => route.fulfill({ json: {
    downloads: 1234,
    release: { tag_name: 'v9.8.7', assets: [...artifacts.map((a) => ({
      ...a, size: 1048576,
      digest: a.slot === 'mac-arm64' ? `sha256:${'a'.repeat(64)}` : '',
      browser_download_url: `https://github.com/OpenCoven/coven-cave/releases/download/${a.release_tag}/${a.name}`,
    })), {
      name: `${artifacts[0].name}.sig`,
      browser_download_url: 'https://github.com/OpenCoven/coven-cave/releases/download/v9.8.7/Cave-v9.8.7-aarch64.dmg.sig',
    }] },
  } }));
  await page.goto('/');
  await expect(page.locator('[data-proof="downloads"]')).toBeVisible();
  await expect(page.locator('[data-dlcount]')).toHaveText('1,234');
  for (const a of artifacts) {
    const row = page.locator(`[data-art="${a.slot}"]`).first();
    await expect(row).toHaveAttribute('href', new RegExp(`/${a.release_tag}/${a.name}$`));
    await expect(row.locator('[data-art-file]')).toHaveText(a.name);
    await expect(page.locator(`[data-art-verify="${a.slot}"]`).first()).toHaveCSS('display', a.slot === 'mac-arm64' ? 'flex' : 'none');
  }
  await expect(page.locator('[data-art-verify="mac-arm64"]').first()).toHaveAttribute('data-copy', `shasum -a 256 ~/Downloads/${artifacts[0].name}`);
  await expect(page.locator('[data-art-sig="mac-arm64"]').first()).toHaveCSS('display', 'flex');
  await expect(page.locator('[data-dl-pane="windows"] [data-art-ver]').first()).toHaveText('v9.8.5');
  await expect(page.locator('[data-dl-pane="mac"] [data-art-ver]').first()).toHaveText('v9.8.7 / v9.8.6');
});

test('failed stats leave version-free browser-native download links', async ({ page }) => {
  await page.route('**/api/site-stats', (route) => route.fulfill({ status: 503 }));
  await page.goto('/');
  for (const [slot, platform] of Object.entries({
    'mac-arm64': 'mac', 'mac-x64': 'mac-intel', 'win-x64': 'windows', 'linux-amd64': 'linux',
  })) {
    await expect(page.locator(`[data-art="${slot}"]`).first()).toHaveAttribute('href', `/download/${platform}`);
    await expect(page.locator(`[data-art-verify="${slot}"]`).first()).toHaveCSS('display', 'none');
    await expect(page.locator(`[data-art-sig="${slot}"]`).first()).toHaveCSS('display', 'none');
  }
  await expect(page.locator('[data-proof="downloads"]')).toBeHidden();
  await expect(page.locator('a[data-dl-btn]').first()).toHaveAttribute('href', /^\/download\//);
  await expect(page.locator('[data-r="dlwrap"]').first()).not.toContainText(/v\d+\.\d+\.\d+/);
});

test('all desktop downloads remain available without JavaScript', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto('/');
  for (const platform of ['mac', 'mac-intel', 'windows', 'linux']) {
    await expect(page.locator(`noscript a[href="/download/${platform}"]`).first()).toBeVisible();
  }
  await context.close();
});
