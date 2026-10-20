// Release constants shared by the download endpoints (underscore-prefixed
// files in api/ are not deployed as functions).

export const REPO = 'OpenCoven/coven-cave';
export const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;

// platform → predicate that picks its installer asset from the release.
// Order matters only within a platform; each predicate must be unique
// enough to match exactly one asset. `.sig` sidecars are always excluded.
// Mirrored in workers/download-proxy/src/index.js — keep in sync.
export const MATCHERS = {
  mac:         (n) => n.endsWith('.dmg') && /aarch64|arm64/i.test(n),
  'mac-intel': (n) => n.endsWith('.dmg') && /x86_64|x64|intel/i.test(n),
  windows:     (n) => n.endsWith('.msi'),
  linux:       (n) => n.endsWith('.AppImage'),
};

export function pickAsset(assets, platform) {
  const match = MATCHERS[platform];
  if (!match || !Array.isArray(assets)) return null;
  return (
    assets.find(
      (asset) =>
        asset &&
        typeof asset.name === 'string' &&
        !asset.name.endsWith('.sig') &&
        match(asset.name),
    ) ?? null
  );
}

// A partial release must not strand another platform on a manually pinned tag.
// Prefer GitHub's latest stable release, then search published stable releases.
export function platformReleases(latest, releases = []) {
  const candidates = [latest, ...releases].filter((r) => r && !r.draft && !r.prerelease);
  return Object.fromEntries(Object.keys(MATCHERS).map((platform) => [
    platform,
    candidates.find((r) => pickAsset(r.assets, platform)) || null,
  ]));
}

export async function resolvePlatformRelease(platform, get) {
  const latest = await get(`/repos/${REPO}/releases/latest`);
  if (!latest) throw new Error('Latest release unavailable');
  if (platformReleases(latest)[platform]) return latest;
  for (let page = 1; page <= 5; page++) {
    const releases = await get(`/repos/${REPO}/releases?per_page=100&page=${page}`);
    if (!Array.isArray(releases)) throw new Error('Release history unavailable');
    const found = platformReleases(null, releases)[platform];
    if (found) return found;
    if (releases.length < 100) break;
  }
  throw new Error(`No published installer for ${platform}`);
}
