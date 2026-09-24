/*
 * PhotoSuite — download manager
 *
 * Reads the latest GitHub release, wires the real asset URLs into the
 * download cards, highlights the visitor's platform and keeps a short-lived
 * cache so repeat visits don't burn the (60/hour) anonymous API quota.
 *
 * The page is fully usable without any of this: every card ships with a
 * static link to /releases/latest, which this script only upgrades.
 */

const GITHUB_REPO = 'eolix/photosuite';
const GITHUB_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases`;

const CACHE_KEY = 'photosuite:latest-release';
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * One entry per download card. `match` picks the right asset out of the
 * release; `filename` rebuilds the URL if the API is unreachable but we
 * know the version from elsewhere.
 */
const PLATFORMS = [
    {
        id: 'macos',
        label: 'macOS',
        match: /^PhotoSuite_([0-9][0-9.]*)_universal\.dmg$/i,
        filename: (version) => `PhotoSuite_${version}_universal.dmg`,
    },
    {
        id: 'windows',
        label: 'Windows',
        match: /^PhotoSuite_([0-9][0-9.]*)_x64-setup\.exe$/i,
        filename: (version) => `PhotoSuite_${version}_x64-setup.exe`,
    },
    {
        id: 'debian',
        label: 'Linux',
        match: /^PhotoSuite_([0-9][0-9.]*)_amd64\.deb$/i,
        filename: (version) => `PhotoSuite_${version}_amd64.deb`,
    },
    {
        id: 'fedora',
        label: 'Linux',
        match: /^PhotoSuite-([0-9][0-9.]*)-1\.x86_64\.rpm$/i,
        filename: (version) => `PhotoSuite-${version}-1.x86_64.rpm`,
    },
];

/* ------------------------------------------------------------------ *
 * Release data
 * ------------------------------------------------------------------ */

function readCache() {
    try {
        const raw = sessionStorage.getItem(CACHE_KEY);
        if (!raw) return null;
        const cached = JSON.parse(raw);
        if (!cached || Date.now() - cached.at > CACHE_TTL) return null;
        return cached.release;
    } catch {
        return null;
    }
}

function writeCache(release) {
    try {
        sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), release }));
    } catch {
        /* private mode / storage disabled — caching is optional */
    }
}

/**
 * Normalise the GitHub payload down to what the page actually needs.
 */
function normaliseRelease(data) {
    const assets = (data.assets || []).map((asset) => ({
        name: asset.name,
        url: asset.browser_download_url,
        size: asset.size,
    }));

    // Prefer the tag, fall back to parsing a version out of any asset name.
    let version = null;
    if (data.tag_name) {
        version = data.tag_name.replace(/^v/i, '');
    } else {
        for (const asset of assets) {
            for (const platform of PLATFORMS) {
                const match = asset.name.match(platform.match);
                if (match) { version = match[1]; break; }
            }
            if (version) break;
        }
    }

    if (!version) throw new Error('Could not determine the release version');

    return { version, assets, publishedAt: data.published_at || null };
}

async function fetchLatestRelease() {
    const cached = readCache();
    if (cached) return cached;

    const response = await fetch(GITHUB_API, {
        headers: { Accept: 'application/vnd.github+json' },
    });

    if (!response.ok) {
        throw new Error(`GitHub API responded with ${response.status}`);
    }

    const release = normaliseRelease(await response.json());
    writeCache(release);
    return release;
}

/* ------------------------------------------------------------------ *
 * Formatting helpers
 * ------------------------------------------------------------------ */

function formatSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return null;
    const mb = bytes / (1024 * 1024);
    return mb >= 1024
        ? `${(mb / 1024).toFixed(1)} GB`
        : `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
}

function formatDate(iso) {
    if (!iso) return null;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleDateString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
    });
}

function assetFor(platform, release) {
    const found = release.assets.find((asset) => platform.match.test(asset.name));
    if (found) return found;

    // Asset list unavailable or renamed — rebuild the conventional URL.
    return {
        name: platform.filename(release.version),
        url: `${RELEASES_URL}/download/v${release.version}/${platform.filename(release.version)}`,
        size: 0,
    };
}

/* ------------------------------------------------------------------ *
 * Platform detection
 * ------------------------------------------------------------------ */

/**
 * Best-effort guess at the visitor's platform id. Linux can't be resolved
 * to deb vs rpm from the browser, so Debian/Ubuntu is the safer default.
 */
function detectPlatform() {
    const hint = navigator.userAgentData?.platform || '';
    const ua = `${hint} ${navigator.userAgent || ''} ${navigator.platform || ''}`.toLowerCase();

    if (/android|iphone|ipad|ipod/.test(ua)) return null; // mobile: no build to offer
    if (/mac|darwin/.test(ua)) return 'macos';
    if (/win/.test(ua)) return 'windows';
    if (/fedora|red hat|rhel|suse|centos/.test(ua)) return 'fedora';
    if (/linux|x11|ubuntu|cros/.test(ua)) return 'debian';
    return null;
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function renderCards(release, detected) {
    PLATFORMS.forEach((platform) => {
        const card = document.querySelector(`.card[data-platform="${platform.id}"]`);
        if (!card) return;

        const asset = assetFor(platform, release);
        const link = card.querySelector('.card__btn');
        const meta = card.querySelector('[data-meta]');

        if (link) {
            link.href = asset.url;
            link.setAttribute('download', '');
            link.setAttribute('aria-label', `Download PhotoSuite ${release.version} for ${card.querySelector('h3').textContent.trim()}`);
        }

        if (meta) {
            const size = formatSize(asset.size);
            meta.textContent = size
                ? `v${release.version} · ${size}`
                : `v${release.version}`;
        }

        if (platform.id === detected) card.classList.add('card--detected');
    });
}

function renderPrimaryButtons(release, detected) {
    const platform = PLATFORMS.find((entry) => entry.id === detected);

    document.querySelectorAll('[data-primary-download]').forEach((button) => {
        const label = button.querySelector('[data-primary-label]');
        const meta = button.querySelector('[data-primary-meta]');

        if (platform) {
            const asset = assetFor(platform, release);
            button.href = asset.url;
            button.setAttribute('download', '');
            if (label) label.textContent = `Download for ${platform.label}`;
            if (meta) {
                const size = formatSize(asset.size);
                const suffix = asset.name.slice(asset.name.lastIndexOf('.'));
                meta.textContent = `v${release.version} · ${suffix}${size ? ` · ${size}` : ''}`;
            }
        } else {
            button.href = `${RELEASES_URL}/latest`;
            if (label) label.textContent = 'Download PhotoSuite';
            if (meta) meta.textContent = `Version ${release.version}`;
        }
    });
}

function renderVersionBadge(release) {
    const badge = document.querySelector('[data-version-badge]');
    if (badge) badge.textContent = `v${release.version}`;
}

function renderFoot(release) {
    const foot = document.querySelector('[data-release-foot]');
    if (!foot) return;

    const released = formatDate(release.publishedAt);
    foot.innerHTML = `
        Version ${release.version}${released ? ` · released ${released}` : ''} ·
        <a href="${RELEASES_URL}" target="_blank" rel="noopener">Changelog &amp; older builds</a>
    `;
}

function renderError() {
    document.querySelectorAll('[data-meta]').forEach((meta) => {
        meta.textContent = 'Latest release';
    });

    const foot = document.querySelector('[data-release-foot]');
    if (foot) {
        foot.innerHTML = `
            Couldn't reach the GitHub API just now — the buttons above still point at the
            <a href="${RELEASES_URL}/latest" target="_blank" rel="noopener">latest release</a>.
        `;
    }
}

async function initDownloads() {
    const detected = detectPlatform();

    try {
        const release = await fetchLatestRelease();
        renderCards(release, detected);
        renderPrimaryButtons(release, detected);
        renderVersionBadge(release);
        renderFoot(release);
    } catch (error) {
        console.error('PhotoSuite: could not load the latest release —', error);
        renderError();
    }
}

/* ------------------------------------------------------------------ *
 * Page chrome: sticky nav state + scroll reveals
 * ------------------------------------------------------------------ */

function initNav() {
    const nav = document.querySelector('.nav');
    if (!nav) return;

    const update = () => nav.classList.toggle('is-stuck', window.scrollY > 8);
    update();
    window.addEventListener('scroll', update, { passive: true });
}

function initReveals() {
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const targets = document.querySelectorAll(
        '.section__head, .card, .shot, .feature, .formats__group, .cta__box'
    );

    if (prefersReducedMotion || !('IntersectionObserver' in window)) return;

    const reveal = (element) => {
        element.classList.add('is-visible');
        observer.unobserve(element);
    };

    const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            if (entry.isIntersecting) reveal(entry.target);
        });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });

    targets.forEach((target, index) => {
        target.classList.add('reveal');
        target.style.transitionDelay = `${Math.min(index % 6, 5) * 60}ms`;
        observer.observe(target);
    });

    // Safety net: nothing stays invisible if the observer never fires
    // (bfcache restores, deep links, prerendering, odd embedded webviews).
    window.setTimeout(() => targets.forEach(reveal), 2500);
}

/* ------------------------------------------------------------------ *
 * Screenshot lightbox
 * ------------------------------------------------------------------ */

function initLightbox() {
    const lightbox = document.getElementById('lightbox');
    const triggers = [...document.querySelectorAll('[data-lightbox]')];
    if (!lightbox || !triggers.length) return;

    const image = lightbox.querySelector('.lightbox__img');
    const caption = lightbox.querySelector('.lightbox__caption');
    const closeButton = lightbox.querySelector('.lightbox__close');

    let index = 0;
    let lastFocused = null;

    const show = (next) => {
        index = (next + triggers.length) % triggers.length;
        const trigger = triggers[index];
        const title = trigger.dataset.caption || '';

        image.src = trigger.dataset.lightbox;
        image.alt = title ? `${title} — PhotoSuite screenshot` : 'PhotoSuite screenshot';
        caption.innerHTML = `<b>${title}</b> · ${index + 1} of ${triggers.length}`;

        // Warm the neighbouring full-size images so paging feels instant.
        [index + 1, index - 1].forEach((offset) => {
            const neighbour = triggers[(offset + triggers.length) % triggers.length];
            new Image().src = neighbour.dataset.lightbox;
        });
    };

    const open = (position) => {
        lastFocused = document.activeElement;
        show(position);
        lightbox.hidden = false;
        document.body.classList.add('is-locked');
        requestAnimationFrame(() => lightbox.classList.add('is-open'));
        closeButton.focus();
    };

    const close = () => {
        lightbox.classList.remove('is-open');
        document.body.classList.remove('is-locked');
        window.setTimeout(() => { lightbox.hidden = true; image.src = ''; }, 200);
        if (lastFocused) lastFocused.focus();
    };

    triggers.forEach((trigger, position) => {
        trigger.addEventListener('click', () => open(position));
    });

    lightbox.querySelectorAll('[data-lightbox-close]')
        .forEach((element) => element.addEventListener('click', close));
    lightbox.querySelector('[data-lightbox-prev]').addEventListener('click', () => show(index - 1));
    lightbox.querySelector('[data-lightbox-next]').addEventListener('click', () => show(index + 1));

    document.addEventListener('keydown', (event) => {
        if (lightbox.hidden) return;
        if (event.key === 'Escape') close();
        else if (event.key === 'ArrowRight') show(index + 1);
        else if (event.key === 'ArrowLeft') show(index - 1);
        else if (event.key === 'Tab') {
            // Keep focus inside the dialog while it is open.
            event.preventDefault();
            const focusable = [...lightbox.querySelectorAll('button')];
            const current = focusable.indexOf(document.activeElement);
            const step = event.shiftKey ? -1 : 1;
            focusable[(current + step + focusable.length) % focusable.length].focus();
        }
    });
}

function init() {
    initNav();
    initReveals();
    initLightbox();
    initDownloads();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}
