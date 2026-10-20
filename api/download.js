// Direct-download resolver — 302s to the latest CovenCave installer.
//
// Why a function: GitHub release asset filenames carry version suffixes
// (CovenCave-v0.1.0-aarch64.dmg), so a static redirect breaks on every
// release. This resolves the *latest* release at request time and points
// the visitor straight at the correct installer file — a real download,
// never the GitHub Releases listing page.
//
// Routed via vercel.json rewrites: /download/:platform → /api/download?platform=:platform
//
// Rate limits: unauthenticated GitHub API is 60 req/hr per outbound IP.
// We cache the 302 at the Vercel CDN (s-maxage) so real traffic almost
// never reaches GitHub, and honour GITHUB_TOKEN if one is configured.

import { MATCHERS, RELEASES_PAGE, pickAsset, resolvePlatformRelease } from './_shared.js';

export default async function handler(req, res) {
  const platform = String(req.query.platform || '').toLowerCase();
  const match = MATCHERS[platform];

  // Unknown platform → send them to the human-readable releases page
  // rather than erroring. Not cached, so a fix takes effect immediately.
  if (!match) {
    res.setHeader('Cache-Control', 'no-store');
    res.writeHead(302, { Location: RELEASES_PAGE });
    return res.end();
  }

  try {
    const headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'opencoven-landing',
    };
    if (process.env.GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }

    const release = await resolvePlatformRelease(platform, async (path) => {
      const response = await fetch(`https://api.github.com${path}`, {
        headers, signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error(`GitHub API ${response.status}`);
      return response.json();
    });
    const asset = pickAsset(release.assets, platform);

    if (!asset || !asset.browser_download_url) throw new Error(`no asset for ${platform}`);

    // Cache the resolved redirect at the CDN for 10 min, and serve a
    // stale one for up to a day while revalidating — keeps us well under
    // GitHub's rate limit even under load.
    res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=86400');
    res.writeHead(302, { Location: asset.browser_download_url });
    return res.end();
  } catch (err) {
    // Any failure (rate limit, network, missing asset) degrades to the
    // releases page so the button always does something useful.
    res.setHeader('Cache-Control', 'no-store');
    res.writeHead(302, { Location: RELEASES_PAGE });
    return res.end();
  }
}
