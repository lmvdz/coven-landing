// Browser-native downloads; release metadata only enhances the artifact menu.
import { register } from './actions.js';
let dlAway = null;
let dlEsc = null;
let copyT = null;

function pickPlatform(e) {
  // the tab lives inside the menu, so the outside-click closer must not see this
  e.stopPropagation();
  const tab = e.currentTarget;
  const menu = tab.closest('[data-dl-menu]');
  const plat = tab.getAttribute('data-dl-plat');
  if (!menu) return;
  const paint = () => {
    menu.querySelectorAll('[data-dl-pane]').forEach((p) => {
      p.style.setProperty('display', p.getAttribute('data-dl-pane') === plat ? 'flex' : 'none', 'important');
    });
    menu.querySelectorAll('[data-dl-plat]').forEach((t) => {
      const on = t.getAttribute('data-dl-plat') === plat;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.style.setProperty('background', on ? 'var(--cv-bg-hover)' : 'transparent', 'important');
      t.style.setProperty('border-color', on ? 'color-mix(in oklch, var(--cv-accent) 45%, transparent)' : 'var(--cv-border-hairline)', 'important');
      t.style.setProperty('color', on ? 'var(--cv-text-primary)' : 'var(--cv-text-secondary)', 'important');
    });
  };
  paint();
  requestAnimationFrame(paint);
}

function setDownloads(open, only) {
  const menus = Array.from(document.querySelectorAll('[data-dl-menu]'));
  menus.filter((m) => m !== only).forEach((m) => {
    m.style.visibility = 'hidden';
    m.style.opacity = '0';
    m.style.transform = 'translateY(-6px)';
  });
  const menu = only || menus[0];
  if (!menu) return;
  menu.style.visibility = open ? 'visible' : 'hidden';
  menu.style.opacity = open ? '1' : '0';
  menu.style.transform = open ? 'none' : 'translateY(-6px)';
  if (open && !dlAway) {
    dlAway = (ev) => { if (!menu.contains(ev.target)) setDownloads(false); };
    dlEsc = (ev) => { if (ev.key === 'Escape') setDownloads(false); };
    document.addEventListener('click', dlAway);
    document.addEventListener('keydown', dlEsc);
  } else if (!open && dlAway) {
    document.removeEventListener('click', dlAway);
    document.removeEventListener('keydown', dlEsc);
    dlAway = null;
    dlEsc = null;
  }
}

function toggleDownloads(e) {
  e.stopPropagation();
  const wrap = e.currentTarget.parentElement;
  const menu = wrap ? wrap.querySelector('[data-dl-menu]') : null;
  if (!menu) return;
  const open = menu.style.visibility === 'visible';
  setDownloads(!open, menu);
}

function copy(e) {
  const btn = e.currentTarget;
  const text = btn.dataset.copy || '';
  const flash = () => {
    const label = btn.querySelector('[data-copy-label]');
    if (!label) return;
    if (!label.dataset.idle) label.dataset.idle = label.textContent;
    label.textContent = 'copied';
    label.style.opacity = '1';
    label.style.color = 'var(--cv-accent)';
    clearTimeout(copyT);
    copyT = setTimeout(() => {
      label.textContent = label.dataset.idle || 'copy';
      label.style.opacity = '';
      label.style.color = '';
    }, 1500);
  };
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (err) { /* clipboard unavailable */ }
    document.body.removeChild(ta);
    flash();
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(flash, fallback);
  } else {
    fallback();
  }
  // the how-it-works quickstart advances its step cards on copy
  const card = btn.closest ? btn.closest('[data-step-card]') : null;
  if (card) document.dispatchEvent(new CustomEvent('redesign:copystep', { detail: Number(card.dataset.stepCard) }));
}

// the pane region holds its tallest pane, measured rather than guessed — panes
// change height when assets resolve or the provenance block appears, and the
// tab row must not move
export function fitMenus() {
  document.querySelectorAll('[data-dl-panes]').forEach((wrap) => {
    let tallest = 0;
    wrap.querySelectorAll('[data-dl-pane]').forEach((pane) => {
      const prev = pane.getAttribute('style') || '';
      const hidden = getComputedStyle(pane).display === 'none';
      if (hidden) pane.style.setProperty('display', 'flex', 'important');
      tallest = Math.max(tallest, pane.offsetHeight);
      if (hidden) pane.setAttribute('style', prev);
    });
    if (tallest) wrap.style.minHeight = tallest + 'px';
  });
}

function detectOs() {
  // navigator.platform first: Chrome's UA reduction freezes the UA string
  // (and can freeze userAgentData) to Windows on every desktop OS
  const plat = navigator.platform || (navigator.userAgentData && navigator.userAgentData.platform) || navigator.userAgent || '';
  return /Win/i.test(plat) ? 'windows'
    : (/Linux|X11/i.test(plat) && !/Android/i.test(navigator.userAgent || '')) ? 'linux'
    : 'mac';
}

// asset names carry the version, so a fixed /latest/download/ path cannot stay
// current — the panel names a version in the markup and then rewrites itself
// from the newest release via the CDN-cached stats endpoint
export function loadArtifacts() {
  const SLOTS = [
    { slot: 'mac-arm64', match: /-aarch64\.dmg$/, cmd: (f) => 'shasum -a 256 ~/Downloads/' + f },
    { slot: 'mac-x64', match: /-x86_64\.dmg$/, cmd: (f) => 'shasum -a 256 ~/Downloads/' + f },
    { slot: 'win-x64', match: /_x64_.*\.msi$/, cmd: (f) => 'certutil -hashfile ' + f + ' SHA256' },
    { slot: 'linux-amd64', match: /_amd64\.AppImage$/, cmd: (f) => 'sha256sum ' + f },
  ];
  fetch('/api/site-stats')
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      const rel = d && d.release;
      const assets = (rel && rel.assets) || [];
      if (!assets.length) return;
      // provenance answered server-side (cached attestation lookup)
      if (d && d.hasAttestation) {
        document.querySelectorAll('[data-art-prov-block]').forEach((el) => { el.style.display = 'flex'; });
        fitMenus();
      }
      SLOTS.forEach((spec) => {
        const asset = assets.find((a) => spec.match.test(a.name) && !/\.sig$/.test(a.name));
        const sig = asset && assets.find((a) => a.name === asset.name + '.sig');
        const digest = asset && typeof asset.digest === 'string' ? asset.digest : '';
        document.querySelectorAll('[data-art="' + spec.slot + '"]').forEach((row) => {
          if (!asset) return;
          row.setAttribute('href', asset.browser_download_url);
          row.dataset.releaseTag = asset.release_tag || rel.tag_name || '';
          const f = row.querySelector('[data-art-file]');
          if (f) f.textContent = asset.name;
          const sz = row.querySelector('[data-art-size]');
          if (sz) sz.textContent = (asset.size / 1048576).toFixed(1).replace(/\.0$/, '') + ' MB';
        });
        document.querySelectorAll('[data-art-verify="' + spec.slot + '"]').forEach((btn) => {
          if (!asset || !digest) { btn.style.display = 'none'; return; }
          btn.style.display = 'flex';
          btn.setAttribute('data-copy', spec.cmd(asset.name));
          const h = btn.querySelector('[data-art-hash]');
          if (h && digest) h.textContent = digest.slice(0, digest.startsWith('sha256:') ? 24 : 17) + '…';
        });
        document.querySelectorAll('[data-art-sig="' + spec.slot + '"]').forEach((link) => {
          if (sig) { link.setAttribute('href', sig.browser_download_url); link.style.display = 'inline-flex'; }
          else link.style.display = 'none';
        });
      });
      document.querySelectorAll('[data-dl-pane]').forEach((pane) => {
        const versions = [...new Set([...pane.querySelectorAll('[data-release-tag]')].map((row) => row.dataset.releaseTag).filter(Boolean))];
        const label = pane.querySelector('[data-art-ver]');
        if (label && versions.length) label.textContent = versions.join(' / ');
      });

    })
    .then(() => fitMenus())
    .catch(() => {});
}

// the primary button is authored for macOS; retarget it for the visitor's OS
// before the release data lands (and permanently if the stats API is down)
export function adaptPlatform() {
  const os = detectOs();
  if (os === 'mac') return;
  const label = os === 'windows' ? 'Download Cave for Windows' : 'Download Cave for Linux';
  document.querySelectorAll('[data-dl-btn]').forEach((btn) => {
    btn.setAttribute('href', '/download/' + os);
    if (!btn.dataset.dlLabel) btn.dataset.dlLabel = label;
    const l = btn.querySelector('[data-dl-label]');
    if (l && !btn.dataset.dlState) l.textContent = label;
  });
}

export function initDownloads() {
  register('toggleDownloads', toggleDownloads);
  register('pickPlatform', pickPlatform);
  register('copy', copy);
  adaptPlatform();
  loadArtifacts();
  setTimeout(fitMenus, 60);
}
