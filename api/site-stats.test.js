import assert from 'node:assert/strict';
import { test } from 'node:test';
import handler from './site-stats.js';

const release = {
  tag_name: 'v1.0.0',
  assets: [
    { name: 'CovenCave_x64_en-US.msi', download_count: 7 },
    { name: 'CovenCave.dmg', download_count: 11 },
    { name: 'CovenCave.dmg.sig', download_count: 100 },
    { name: 'latest.json', download_count: 100 },
  ],
};

async function request(t, override = () => undefined) {
  t.mock.method(globalThis, 'fetch', async (url) => {
    const replacement = override(url);
    if (replacement !== undefined) return replacement;
    let data = {};
    if (url.includes('/orgs/')) data = [{ name: 'coven', stargazers_count: 4 }];
    if (url.includes('/releases?')) data = [release];
    if (url.endsWith('/releases/latest')) data = release;
    if (url.includes('discord.com')) data = { approximate_member_count: 20 };
    return { ok: true, json: async () => data };
  });
  const headers = {};
  let body;
  await handler({}, {
    setHeader: (key, value) => { headers[key] = value; },
    end: (value) => { body = JSON.parse(value); },
  });
  return { headers, body };
}

test('complete stats cache installer downloads, excluding signatures and updater metadata', async (t) => {
  const { headers, body } = await request(t);
  assert.equal(body.downloads, 18);
  assert.equal(body.stars, 4);
  assert.match(headers['Cache-Control'], /s-maxage=7200/);
});

test('GitHub rate limits remain unknown and cannot poison the CDN cache', async (t) => {
  const { headers, body } = await request(t, (url) =>
    url.includes('api.github.com') ? { ok: false, status: 403 } : undefined);
  assert.equal(body.downloads, null);
  assert.equal(body.stars, null);
  assert.equal(body.release, null);
  assert.equal(body.discord.count, 20);
  assert.equal(headers['Cache-Control'], 'no-store');
});

test('network failure preserves other stats and is not cached', async (t) => {
  const { headers, body } = await request(t, (url) => {
    if (url.includes('/releases?')) throw new Error('upstream unavailable');
  });
  assert.equal(body.downloads, null);
  assert.equal(body.stars, 4);
  assert.equal(headers['Cache-Control'], 'no-store');
});

test('failed later pagination never publishes a partial download total', async (t) => {
  const { headers, body } = await request(t, (url) => {
    if (new URL(url).searchParams.get('page') === '1') return { ok: true, json: async () => Array(100).fill(release) };
    if (new URL(url).searchParams.get('page') === '2') return { ok: false, status: 503 };
  });
  assert.equal(body.downloads, null);
  assert.equal(headers['Cache-Control'], 'no-store');
});

test('verified zero downloads is distinct from unavailable data', async (t) => {
  const { headers, body } = await request(t, (url) =>
    url.includes('/releases?') ? { ok: true, json: async () => [] } : undefined);
  assert.equal(body.downloads, 0);
  assert.match(headers['Cache-Control'], /s-maxage=7200/);
});

test('partial releases retain each installer version and its matching signature evidence', async (t) => {
  const mac = { tag_name: 'v9.0.0', assets: [{ name: 'Cave-aarch64.dmg', download_count: 1 }] };
  const windows = { tag_name: 'v8.9.0', assets: [
    { name: 'Cave_x64_en-US.msi', download_count: 2, digest: 'sha256:abc' },
    { name: 'Cave_x64_en-US.msi.sig', download_count: 30 },
  ] };
  const { body } = await request(t, (url) => {
    if (url.endsWith('/releases/latest')) return { ok: true, json: async () => mac };
    if (url.includes('/releases?')) return { ok: true, json: async () => [mac, windows] };
  });
  assert.equal(body.downloads, 3);
  assert.equal(body.release.assets.find((a) => a.name.endsWith('.dmg')).release_tag, 'v9.0.0');
  assert.equal(body.release.assets.find((a) => a.name.endsWith('.msi')).release_tag, 'v8.9.0');
  assert.equal(body.release.assets.find((a) => a.name.endsWith('.sig')).release_tag, 'v8.9.0');
});
