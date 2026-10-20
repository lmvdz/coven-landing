// Aggregated public stats for the landing page, cached at the CDN.
//
// Why a function: every visitor's browser used to hit GitHub (org stars,
// paged releases for the cumulative install count, latest release for the
// artifact rows, attestation lookup) and Discord directly — up to 8 upstream
// requests per visit against GitHub's 60 req/hr unauthenticated IP limit, so
// the numbers vanished under any real traffic. This endpoint makes those
// calls server-side at most once per cache window per region and serves the
// aggregate to everyone (s-maxage 2h, a day of stale-while-revalidate).
// Honours GITHUB_TOKEN if configured, same as api/download.js.

import { REPO, platformReleases, pickAsset } from './_shared.js';

const ORG = 'OpenCoven';
const GUILD_ID = '1469169435095990448';
const INSTALLER = /\.(dmg|msi|AppImage|exe|deb|rpm)$/i;

async function gh(path, headers) {
  try {
    const r = await fetch(`https://api.github.com${path}`, {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'opencoven-landing',
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const out = {
    stars: null,
    starSplit: [],
    downloads: null,
    release: null,
    hasAttestation: false,
    discord: null,
  };

  // stars: every public repo in the org, summed (mirrors the old client logic)
  const repos = await gh(`/orgs/${ORG}/repos?per_page=100&sort=updated`, headers);
  if (Array.isArray(repos)) {
    out.starSplit = repos
      .map((r) => ({ name: r.name, stars: Number(r.stargazers_count) || 0 }))
      .filter((r) => r.stars > 0)
      .sort((a, b) => b.stars - a.stars);
    out.stars = out.starSplit.reduce((sum, r) => sum + r.stars, 0);
  }

  // installs: cumulative across every release; signatures/updater bundles excluded
  let downloads = 0;
  const history = [];
  for (let page = 1; page <= 5; page++) {
    const rels = await gh(`/repos/${REPO}/releases?per_page=100&page=${page}`, headers);
    if (!Array.isArray(rels)) break;
    history.push(...rels);
    downloads += rels.reduce((sum, rel) => sum + ((rel.assets || []).reduce((n, a) => (
      INSTALLER.test(a.name) ? n + (Number(a.download_count) || 0) : n
    ), 0)), 0);
    if (rels.length < 100) {
      out.downloads = downloads;
      break;
    }
  }

  // latest release, trimmed to the fields the artifact rows use
  const latest = await gh(`/repos/${REPO}/releases/latest`, headers);
  if (latest) {
    out.release = {
      tag_name: latest.tag_name || '',
      assets: [],
    };
    for (const [platform, release] of Object.entries(platformReleases(latest, history))) {
      if (!release) continue;
      const installer = pickAsset(release.assets, platform);
      const assets = release.assets.filter((a) => a.name === installer.name || a.name === `${installer.name}.sig`);
      out.release.assets.push(...assets.map((a) => ({
        name: a.name,
        size: a.size,
        browser_download_url: a.browser_download_url,
        download_count: a.download_count,
        digest: typeof a.digest === 'string' ? a.digest : '',
        release_tag: release.tag_name || '',
      })));
    }
    const arm = out.release.assets.find((a) => /-aarch64\.dmg$/.test(a.name));
    if (arm && arm.digest) {
      const att = await gh(`/repos/${REPO}/attestations/${arm.digest}`, headers);
      out.hasAttestation = !!(att && Array.isArray(att.attestations) && att.attestations.length > 0);
    }
  }

  // discord: total joined members via the public invite; widget online count as fallback
  try {
    const inv = await fetch('https://discord.com/api/v10/invites/opencoven?with_counts=true');
    const d = inv.ok ? await inv.json() : null;
    if (d && Number(d.approximate_member_count)) {
      out.discord = { count: Number(d.approximate_member_count), label: 'members' };
    } else {
      const wr = await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/widget.json`);
      const w = wr.ok ? await wr.json() : null;
      if (w && Number(w.presence_count)) {
        out.discord = { count: Number(w.presence_count), label: 'online in Discord' };
      }
    }
  } catch (err) { /* proof row hides itself when absent */ }

  // Never cache a failed/partial GitHub lookup as public proof. In particular,
  // a rate-limited response must not hide downloads for the entire CDN window.
  const complete = out.stars !== null && out.downloads !== null && out.release !== null;
  res.setHeader('Cache-Control', complete
    ? 'public, s-maxage=7200, stale-while-revalidate=86400'
    : 'no-store');
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(out));
}
