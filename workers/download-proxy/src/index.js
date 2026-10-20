// CORS streaming proxy for CovenCave installers.
//
// GitHub serves release assets without CORS headers on any hop of its
// redirect chain, so the landing page's in-browser streamed download
// (fetch + ReadableStream progress in src/scripts/reforged.js) cannot
// read the bytes directly. This worker fetches the asset server-side —
// where CORS does not apply — and passes the body through unchanged
// with reflected-origin CORS headers and an exposed Content-Length,
// which is exactly what the progress UI needs.
//
//   GET /:platform   → 200 stream of the latest installer for that
//                      platform (mac | mac-intel | windows | linux)
//   anything else    → 302 to the human-readable releases page
//
// The body is a pass-through stream (`new Response(upstream.body)`), so
// the worker buffers nothing and stays within free-tier CPU limits
// regardless of asset size. Deployed by CI on push to main — see
// .github/workflows/deploy-download-worker.yml.

import { MATCHERS, RELEASES_PAGE, pickAsset, resolvePlatformRelease } from '../../../api/_shared.js';
export { MATCHERS, pickAsset };
const USER_AGENT = 'opencoven-download-worker';

// "https://*.vercel.app" → wildcard subdomain, "http://localhost:*" →
// wildcard port. Everything else must match exactly.
export function parseAllowedOrigins(raw) {
  return String(raw ?? '')
    .split(',')
    .map((pattern) => pattern.trim())
    .filter(Boolean)
    .map(
      (pattern) =>
        new RegExp(
          `^${pattern
            .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '[a-z0-9.-]+')}$`,
          'i',
        ),
    );
}

export function corsFor(origin, allowedOrigins) {
  if (!origin || !allowedOrigins.some((pattern) => pattern.test(origin))) {
    return {};
  }
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Expose-Headers':
      'Content-Length, Content-Disposition, X-File-Size',
    Vary: 'Origin',
  };
}

async function resolveAsset(platform, env) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': USER_AGENT,
  };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;

  const release = await resolvePlatformRelease(platform, async (path) => {
    const response = await fetch(`https://api.github.com${path}`, {
      headers, signal: AbortSignal.timeout(8000),
      cf: { cacheTtlByStatus: { '200-299': 300, '400-599': 0 } },
    });
    if (!response.ok) throw new Error(`GitHub API ${response.status}`);
    return response.json();
  });
  const asset = pickAsset(release.assets, platform);
  if (!asset || !asset.browser_download_url) {
    throw new Error(`no asset for ${platform}`);
  }
  return asset;
}

function redirectToReleases(cors) {
  return new Response(null, {
    status: 302,
    headers: {
      ...cors,
      Location: RELEASES_PAGE,
      'Cache-Control': 'no-store',
    },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') ?? '';
    const cors = corsFor(origin, parseAllowedOrigins(env.ALLOWED_ORIGINS));

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Max-Age': '86400',
        },
      });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('method not allowed', {
        status: 405,
        headers: { ...cors, Allow: 'GET, HEAD, OPTIONS' },
      });
    }

    const platform = decodeURIComponent(
      new URL(request.url).pathname.replace(/^\/+|\/+$/g, ''),
    );
    if (!MATCHERS[platform]) return redirectToReleases(cors);

    try {
      const asset = await resolveAsset(platform, env);
      const upstream = await fetch(asset.browser_download_url, {
        headers: { 'User-Agent': USER_AGENT },
      });
      if (!upstream.ok || !upstream.body) {
        throw new Error(`asset fetch ${upstream.status}`);
      }

      const headers = new Headers(cors);
      headers.set('Content-Type', 'application/octet-stream');
      headers.set('Content-Disposition', `attachment; filename="${asset.name}"`);
      headers.set('Cache-Control', 'public, max-age=600');
      const length = upstream.headers.get('Content-Length');
      if (length) headers.set('Content-Length', length);
      // Belt-and-braces size signal for progress UIs behind proxies that
      // re-chunk the stream and drop Content-Length (Vercel's edge does).
      if (asset.size) headers.set('X-File-Size', String(asset.size));

      return new Response(request.method === 'HEAD' ? null : upstream.body, {
        status: 200,
        headers,
      });
    } catch {
      // Rate limit, missing asset, upstream failure — send the visitor
      // somewhere useful instead of erroring. The landing page's client
      // treats the resulting HTML as "not streamable" and falls back to
      // its native download path.
      return redirectToReleases(cors);
    }
  },
};
