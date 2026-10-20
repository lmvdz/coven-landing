import assert from 'node:assert/strict';
import { test } from 'node:test';
import handler from '../../api/download.js';
import { resolvePlatformRelease, RELEASES_PAGE } from '../../api/_shared.js';

const makeRelease = (tag, names, extra = {}) => ({
  tag_name: tag,
  assets: names.map((name) => ({
    name,
    browser_download_url: `https://github.com/OpenCoven/coven-cave/releases/download/${tag}/${name}`,
  })),
  ...extra,
});
const latest = makeRelease('v9.8.7', ['Cave-aarch64.dmg', 'Cave-x86_64.dmg']);
const previous = makeRelease('v9.8.6', ['Cave_x64_en-US.msi', 'Cave_amd64.AppImage']);

for (const platform of ['mac', 'mac-intel', 'windows', 'linux']) {
  test(`${platform} resolves its newest available stable installer without a tag pin`, async (t) => {
    const requested = [];
    t.mock.method(globalThis, 'fetch', async (url) => {
      requested.push(url);
      return {
        ok: true,
        json: async () => url.endsWith('/latest') ? latest : [
          makeRelease('v10-beta', previous.assets.map((a) => a.name), { prerelease: true }),
          makeRelease('v10-draft', previous.assets.map((a) => a.name), { draft: true }),
          latest, previous,
        ],
      };
    });
    let location;
    await handler({ query: { platform } }, {
      setHeader() {},
      writeHead: (status, headers) => { assert.equal(status, 302); location = headers.Location; },
      end() {},
    });
    assert.ok(location.includes(platform.startsWith('mac') ? '/v9.8.7/' : '/v9.8.6/'));
    assert.equal(requested.some((url) => url.includes('/tags/')), false);
  });
}

test('platform lookup searches later pages and excludes signature-only assets', async () => {
  const found = await resolvePlatformRelease('windows', async (path) => {
    if (path.endsWith('/latest')) return latest;
    if (new URL(`https://api.github.com${path}`).searchParams.get('page') === '1') {
      return Array(100).fill(makeRelease('v9.8.7', ['Cave_x64_en-US.msi.sig']));
    }
    return [previous];
  });
  assert.equal(found.tag_name, previous.tag_name);
});

test('unavailable release metadata redirects to GitHub without caching a fabricated version', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 403 }));
  const headers = {};
  await handler({ query: { platform: 'windows' } }, {
    setHeader: (key, value) => { headers[key] = value; },
    writeHead: (_status, value) => Object.assign(headers, value),
    end() {},
  });
  assert.equal(headers.Location, RELEASES_PAGE);
  assert.equal(headers['Cache-Control'], 'no-store');
});
