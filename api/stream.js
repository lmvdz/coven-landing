// Same-origin streaming proxy — tier 2 of the download cascade.
//
// The landing page's in-button progress UI needs to read installer bytes
// with fetch + ReadableStream, which GitHub's asset hosting blocks
// cross-origin (no CORS headers on any redirect hop). This edge function
// fetches the asset server-side and passes the body through same-origin,
// so no CORS applies at all.
//
// Cascade (src/scripts/reforged.js): the Cloudflare worker
// (workers/download-proxy, free egress) is tried first when configured;
// this endpoint is the zero-setup fallback; plain /download/:platform
// navigation is the last resort. Each download's bytes count against
// Vercel data transfer — if the plan's cap pauses functions, this tier
// starts failing and clicks degrade to the native download on their own.
//
// Edge runtime, not Node: an in-flight streaming response has no
// wall-clock cap here, while Node functions are killed at maxDuration —
// which would truncate a 73 MB installer on a slow connection.
//
// Routed via vercel.json rewrites: /stream/:platform → /api/stream?platform=:platform

import { MATCHERS, RELEASES_PAGE, resolvePlatformRelease, pickAsset } from './_shared.js';

export const config = { runtime: 'edge' };

// Cache successful platform resolutions only, for five minutes.
const releaseCache = new Map();
async function latestRelease(platform) {
  const cached = releaseCache.get(platform);
  if (cached && Date.now() - cached.at < 300000) return cached.release;
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'opencoven-landing' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const release = await resolvePlatformRelease(platform, async (path) => {
    const response = await fetch(`https://api.github.com${path}`, { headers, signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`GitHub API ${response.status}`);
    return response.json();
  });
  releaseCache.set(platform, { at: Date.now(), release });
  return release;
}

export default async function handler(request) {
  const platform = new URL(request.url).searchParams.get('platform') ?? '';
  if (!MATCHERS[platform]) {
    return Response.redirect(RELEASES_PAGE, 302);
  }

  try {
    const release = await latestRelease(platform);
    const asset = pickAsset(release.assets, platform);
    if (!asset || !asset.browser_download_url) {
      throw new Error(`no asset for ${platform}`);
    }

    const upstream = await fetch(asset.browser_download_url, {
      headers: { 'User-Agent': 'opencoven-landing' },
    });
    if (!upstream.ok || !upstream.body) {
      throw new Error(`asset fetch ${upstream.status}`);
    }

    const headers = new Headers({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${asset.name}"`,
      'Cache-Control': 'public, max-age=600',
    });
    const length = upstream.headers.get('Content-Length');
    if (length) headers.set('Content-Length', length);
    // Vercel's edge streams chunked and drops Content-Length; carry the
    // real size in a custom header so progress UIs can still compute %.
    if (asset.size) headers.set('X-File-Size', String(asset.size));

    return new Response(upstream.body, { status: 200, headers });
  } catch {
    // Rate limit, missing asset, upstream failure — the client treats
    // the resulting HTML redirect as "not streamable" and falls back to
    // its native download path.
    return Response.redirect(RELEASES_PAGE, 302);
  }
}
