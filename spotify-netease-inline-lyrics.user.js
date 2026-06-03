// ==UserScript==
// @name         Spotify 网易云翻译歌词行内嵌入
// @namespace    https://local.user.script
// @version      0.2.9
// @description  将网易云翻译歌词嵌入 Spotify 网页歌词原文下方（行内显示）
// @author       GoodJoe
// @license      MIT
// @match        *://open.spotify.com/*
// @icon         https://open.spotify.com/favicon.ico
// @connect      interface.music.163.com
// @grant        GM.xmlHttpRequest
// @grant        GM_xmlhttpRequest
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM_getValue
// @grant        GM_setValue
// @require      https://fastly.jsdelivr.net/npm/crypto-js@4.2.0/crypto-js.min.js
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  const LOG = '[NCM Inline Lyrics]';
  const EAPI_AES_KEY = 'e82ckenh8dichen8';
  const EAPI_ENCODE_KEY = '3go8&$8*3*3h0k(2)2';
  const EAPI_CHECK_TOKEN = '9ca17ae2e6ffcda170e2e6ee8ad85dba908ca4d74da9ac8ea2d44e938f9eadc66da5a8979af572a5a9b68ac12af0feaec3b92aa69af9b1d372f6b8adccb35e968b9bb6c14f908d0099fb6ff48efdacd361f5b6ee9e';
  const EAPI_BASE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) NeteaseMusicDesktop/3.0.14.2534',
  };
  const EAPI_BASE_COOKIES = {
    os: 'osx',
    appver: '3.0.14',
    requestId: 0,
    osver: '15.6.1',
  };

  const TICK_MS = 1000;
  const DOM_SWEEP_MS = 2200;
  const RENDER_THROTTLE_MS = 100;
  const REMOVE_GRACE_MS = 3200;
  const GRADIENT_REFRESH_MS = 2600;
  const SEARCH_LIMIT = 12;
  const MAX_RESULTS = 20;

  const gmXhr = (typeof GM !== 'undefined' && GM.xmlHttpRequest)
    ? GM.xmlHttpRequest.bind(GM)
    : (typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest : null);

  const gmGetValue = (typeof GM !== 'undefined' && GM.getValue)
    ? GM.getValue.bind(GM)
    : (typeof GM_getValue === 'function' ? (k, d) => Promise.resolve(GM_getValue(k, d)) : null);

  const gmSetValue = (typeof GM !== 'undefined' && GM.setValue)
    ? GM.setValue.bind(GM)
    : (typeof GM_setValue === 'function' ? (k, v) => Promise.resolve(GM_setValue(k, v)) : null);

  if (!gmXhr || !gmGetValue || !gmSetValue) {
    console.error(`${LOG} 缺少 GM API，无法运行。`);
    return;
  }

  class CookieJar {
    constructor(storageKey) {
      this.storageKey = storageKey;
    }

    async get(url) {
      const allCookies = await gmGetValue(this.storageKey, {});
      const now = Date.now();
      const { hostname, pathname } = new URL(url);
      const matchingCookies = [];
      let needsSave = false;

      for (const domain in allCookies) {
        if (!hostname.endsWith(domain)) continue;
        const domainJar = allCookies[domain];
        for (const path in domainJar) {
          if (!pathname.startsWith(path)) continue;
          const pathJar = domainJar[path];
          for (const name in pathJar) {
            const cookie = pathJar[name];
            if (cookie.expires && cookie.expires < now) {
              delete pathJar[name];
              needsSave = true;
            } else {
              matchingCookies.push(`${name}=${cookie.value}`);
            }
          }
          if (Object.keys(pathJar).length === 0) delete domainJar[path];
        }
        if (Object.keys(domainJar).length === 0) delete allCookies[domain];
      }

      if (needsSave) await gmSetValue(this.storageKey, allCookies);
      return matchingCookies.join('; ');
    }

    async set(url, setCookieHeader) {
      if (!setCookieHeader) return;
      const allCookies = await gmGetValue(this.storageKey, {});
      const { hostname } = new URL(url);

      const parts = setCookieHeader.split(';').map((p) => p.trim());
      const [name, value] = parts[0].split('=').map((s) => s.trim());
      if (!name) return;

      const cookie = { value };
      let domain = hostname;
      let path = '/';

      parts.slice(1).forEach((part) => {
        const [keyRaw, valRaw] = part.split('=');
        const key = String(keyRaw || '').trim().toLowerCase();
        const val = String(valRaw || '').trim();
        if (key === 'expires') cookie.expires = new Date(val).getTime();
        if (key === 'max-age') cookie.expires = Date.now() + (parseInt(val, 10) * 1000);
        if (key === 'path') path = val || '/';
        if (key === 'domain') domain = val.startsWith('.') ? val.slice(1) : val;
      });

      allCookies[domain] = allCookies[domain] || {};
      allCookies[domain][path] = allCookies[domain][path] || {};
      allCookies[domain][path][name] = cookie;

      await gmSetValue(this.storageKey, allCookies);
    }
  }

  const cookieJar = new CookieJar('ncm.inline.cookies');

  function eapi(path, options = {}) {
    return new Promise(async (resolve, reject) => {
      try {
        const { data = {}, headers = {}, header = {}, cookies = {}, params = {} } = options;
        Object.assign(header, EAPI_BASE_COOKIES);
        Object.assign(headers, EAPI_BASE_HEADERS);
        Object.assign(cookies, EAPI_BASE_COOKIES);

        const queryStr = new URLSearchParams(params).toString();
        const url = `https://interface.music.163.com/eapi${path}${queryStr ? `?${queryStr}` : ''}`;

        const storedCookies = await cookieJar.get(url);
        if (storedCookies) {
          storedCookies.split('; ').forEach((c) => {
            const [k, v] = c.split('=', 2);
            if (k) cookies[k] = v;
          });
        }

        data.header = JSON.stringify(header);
        const body = JSON.stringify(data);
        const sign = CryptoJS.MD5(`nobody/api${path}use${body}md5forencrypt`).toString();

        gmXhr({
          url,
          method: 'POST',
          headers: {
            ...headers,
            'Content-Type': 'application/x-www-form-urlencoded',
            Cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '),
          },
          data: `params=${encodeURIComponent(
            CryptoJS.AES.encrypt(
              `/api${path}-36cd479b6b5-${body}-36cd479b6b5-${sign}`,
              CryptoJS.enc.Utf8.parse(EAPI_AES_KEY),
              { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 },
            ).toString(CryptoJS.format.Hex).toUpperCase(),
          )}`,
          responseType: 'json',
          anonymous: true,
          onerror: reject,
          ontimeout: reject,
          onload: async (response) => {
            try {
              if (response.responseHeaders) {
                const setCookieHeaders = response.responseHeaders
                  .split('\r\n')
                  .filter((h) => h.toLowerCase().startsWith('set-cookie:'))
                  .map((h) => h.slice(h.indexOf(':') + 1).trim());

                for (const rawHeader of setCookieHeaders) {
                  const cookieStrings = rawHeader.split(/,(?=\s*[^=;\s]+=)/);
                  for (const cookieStr of cookieStrings) {
                    if (cookieStr) await cookieJar.set(url, cookieStr.trim());
                  }
                }
              }

              if (response.status >= 200 && response.status < 300) {
                const res = response.response;
                if (res && res.code === 200) {
                  resolve(res);
                } else {
                  reject(new Error((res && (res.message || res.msg)) || 'EAPI error'));
                }
                return;
              }
              reject(new Error(`HTTP ${response.status}: ${response.statusText}`));
            } catch (err) {
              reject(err);
            }
          },
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  const cloudmusic = {
    register(deviceId) {
      const encode = (someId) => {
        let xored = '';
        for (let i = 0; i < someId.length; i += 1) {
          const cc = someId.charCodeAt(i) ^ EAPI_ENCODE_KEY.charCodeAt(i % EAPI_ENCODE_KEY.length);
          xored += String.fromCharCode(cc);
        }
        const wordArray = CryptoJS.enc.Utf8.parse(xored);
        return btoa(`${someId} ${CryptoJS.MD5(wordArray).toString(CryptoJS.enc.Base64)}`);
      };

      return eapi('/register/anonimous', {
        data: { username: encode(deviceId) },
        params: { _nmclfl: '1' },
      });
    },
    search(keyword, limit = SEARCH_LIMIT) {
      return eapi('/search/song/list/page', {
        data: {
          offset: '0',
          scene: 'NORMAL',
          needCorrect: 'true',
          checkToken: EAPI_CHECK_TOKEN,
          keyword,
          limit: String(limit),
          verifyId: 1,
        },
        headers: {
          'X-Anticheattoken': EAPI_CHECK_TOKEN,
        },
        params: { _nmclfl: '1' },
      });
    },
    lyric(id) {
      return eapi('/song/lyric/v1', {
        data: {
          id,
          tv: '-1',
          yv: '-1',
          rv: '-1',
          lv: '-1',
          verifyId: 1,
        },
        params: { _nmclfl: '1' },
      });
    },
  };

  function parseLrc(txt = '') {
    return txt
      .split(/\r?\n/)
      .flatMap((lineRaw) => {
        const line = String(lineRaw || '').trim();
        if (!line) return [];
        const m = line.match(/^\[(\d{2}):(\d{2})(?:[.:](\d{2,3}))?]\s*(.*)$/);
        if (m) {
          const [, mm, ss, ff = '0', text] = m;
          const sub = ff.length === 3 ? +ff : +ff * 10;
          const t = (+mm) * 60000 + (+ss) * 1000 + sub;
          return [{ t, text }];
        }
        try {
          const obj = JSON.parse(line);
          if (Number.isFinite(obj?.t) && Array.isArray(obj?.c)) {
            return [{ t: +obj.t, text: obj.c.map((x) => x?.tx || '').join('') }];
          }
        } catch (_) {}
        return [];
      })
      .sort((a, b) => a.t - b.t);
  }

  function findNear(arr, t, tol = 600) {
    if (!arr || arr.length === 0) return '';
    let lo = 0;
    let hi = arr.length - 1;
    let best = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const dt = arr[mid].t - t;
      if (!best || Math.abs(dt) < Math.abs(best.t - t)) best = arr[mid];
      if (dt < 0) lo = mid + 1;
      else hi = mid - 1;
    }
    return best && Math.abs(best.t - t) <= tol ? String(best.text || '').trim() : '';
  }

  function normalizeText(s) {
    return String(s || '')
      .normalize('NFKC')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function levenshtein(a, b) {
    const an = a.length;
    const bn = b.length;
    if (!an) return bn;
    if (!bn) return an;
    const m = Array.from({ length: bn + 1 }, () => Array(an + 1).fill(0));
    for (let i = 0; i <= an; i += 1) m[0][i] = i;
    for (let j = 0; j <= bn; j += 1) m[j][0] = j;
    for (let j = 1; j <= bn; j += 1) {
      for (let i = 1; i <= an; i += 1) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        m[j][i] = Math.min(m[j][i - 1] + 1, m[j - 1][i] + 1, m[j - 1][i - 1] + cost);
      }
    }
    return m[bn][an];
  }

  function similarity(a, b) {
    const x = normalizeText(a);
    const y = normalizeText(b);
    if (!x || !y) return 0;
    if (x === y) return 1;
    if (x.includes(y) || y.includes(x)) return 0.92;
    const dist = levenshtein(x, y);
    return 1 - dist / Math.max(x.length, y.length);
  }

  function buildTimeline(lyricsData) {
    const O = parseLrc(lyricsData?.lrc?.lyric || '');
    const T = parseLrc(lyricsData?.tlyric?.lyric || '');

    return O.map((o) => ({
      t: o.t,
      orig: String(o.text || '').trim(),
      trans: findNear(T, o.t),
    })).filter((x) => x.orig && x.trans);
  }

  function buildTranslationMap(timeline) {
    const byText = new Map();
    for (const row of timeline) {
      const key = normalizeText(row.orig);
      if (!key) continue;
      if (!byText.has(key)) byText.set(key, row.trans);
    }
    return byText;
  }

  function splitTitle(title) {
    const t = String(title || '').trim();
    if (!t) return [];
    const parts = t
      .split(/\s+-\s+|\s*\|\s*|\s*\/\s*|\s*:\s*/g)
      .map((x) => x.replace(/\(.*?\)|\[.*?]/g, '').trim())
      .filter(Boolean);
    return [...new Set(parts.length ? parts : [t])];
  }

  function collectKeywords(title, artist) {
    const titleParts = splitTitle(title);
    const kws = new Set();
    for (const p of titleParts) kws.add(p);
    kws.add(`${title} ${artist}`.trim());
    kws.add(`${artist} ${title}`.trim());
    return [...kws].filter((x) => x.length > 1);
  }

  function songScore(songName, songArtists, title, artist) {
    const st = normalizeText(songName);
    const ta = normalizeText(title);
    const ar = normalizeText(artist);
    const titleScore = similarity(st, ta);
    const artistScore = Math.max(0, ...songArtists.map((x) => similarity(x, ar)));
    const containBonus = st.includes(ta) || ta.includes(st) ? 0.1 : 0;
    return titleScore * 10 + artistScore * 2 + containBonus;
  }

  function addStyles() {
    if (document.getElementById('ncm-inline-style')) return;
    const style = document.createElement('style');
    style.id = 'ncm-inline-style';
    style.textContent = `
      .ncm-inline-trans {
        margin-top: 0.22em;
        font-size: 0.58em;
        line-height: 1.35;
        color: inherit;
        font-weight: inherit;
        letter-spacing: 0.01em;
        pointer-events: none;
        white-space: pre-wrap;
      }
      [data-testid="lyrics-line"].ncm-inline-host,
      [data-testid="lyrics-line-always-visible"].ncm-inline-host {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
      }
      .ncm-lyrics-gradient-host {
        position: relative !important;
        overflow: hidden !important;
        isolation: isolate;
      }
      .ncm-lyrics-gradient-host.ncm-lyrics-gradient-paused .ncm-lyrics-gradient-layer,
      .ncm-lyrics-gradient-host.ncm-lyrics-gradient-paused .ncm-lyrics-gradient-layer::before,
      .ncm-lyrics-gradient-host.ncm-lyrics-gradient-paused .ncm-lyrics-gradient-layer::after {
        animation-play-state: paused !important;
      }
      .ncm-lyrics-gradient-layer {
        position: relative !important;
        overflow: hidden !important;
        background-image:
          radial-gradient(146% 136% at 9% 11%, var(--ncm-grad-1, rgba(166, 109, 214, 0.88)) 0%, transparent 66%),
          radial-gradient(144% 134% at 91% 14%, var(--ncm-grad-2, rgba(240, 139, 167, 0.86)) 0%, transparent 66%),
          radial-gradient(152% 140% at 15% 88%, var(--ncm-grad-5, rgba(91, 103, 197, 0.82)) 0%, transparent 68%),
          radial-gradient(148% 138% at 86% 84%, var(--ncm-grad-6, rgba(86, 57, 132, 0.80)) 0%, transparent 68%),
          linear-gradient(132deg, var(--ncm-grad-3, rgba(81, 62, 156, 0.92)) 0%, var(--ncm-grad-4, rgba(19, 16, 42, 0.99)) 100%) !important;
        background-size: 214% 210%, 212% 208%, 220% 216%, 214% 210%, 168% 168% !important;
        background-position: 2% 7%, 98% 12%, 12% 92%, 92% 84%, 50% 50% !important;
        background-repeat: no-repeat !important;
        animation: ncm-gradient-bg-flow 4.6s linear infinite !important;
        will-change: background-position, filter, transform;
        transform: translateZ(0);
        transition: background-image 900ms ease, background-color 900ms ease !important;
      }
      .ncm-lyrics-gradient-layer::before {
        content: "";
        position: absolute;
        inset: -26%;
        pointer-events: none;
        background-image:
          linear-gradient(106deg, rgba(0, 0, 0, 0) 0%, var(--ncm-grad-2, rgba(240, 139, 167, 0.24)) 36%, rgba(0, 0, 0, 0) 68%),
          linear-gradient(286deg, rgba(0, 0, 0, 0) 6%, var(--ncm-grad-5, rgba(91, 103, 197, 0.20)) 42%, rgba(0, 0, 0, 0) 74%);
        mix-blend-mode: soft-light;
        opacity: 0.42;
        filter: blur(28px) saturate(118%);
        animation: ncm-gradient-blob-drift 5.2s ease-in-out infinite alternate;
      }
      .ncm-lyrics-gradient-layer::after {
        content: "";
        position: absolute;
        inset: 0;
        pointer-events: none;
        opacity: 0.12;
        mix-blend-mode: soft-light;
        background-image:
          repeating-linear-gradient(26deg, rgba(255, 255, 255, 0.15) 0 1px, rgba(0, 0, 0, 0) 1px 3px),
          repeating-linear-gradient(152deg, rgba(0, 0, 0, 0.13) 0 1px, rgba(0, 0, 0, 0) 1px 4px);
        animation: ncm-gradient-noise-drift 0.55s steps(2, end) infinite;
      }
      @keyframes ncm-gradient-bg-flow {
        0% {
          background-position: 3% 9%, 97% 11%, 10% 90%, 90% 86%, 49% 51%;
        }
        25% {
          background-position: 18% 3%, 86% 24%, 18% 76%, 78% 93%, 53% 47%;
        }
        50% {
          background-position: 34% 16%, 72% 8%, 6% 84%, 96% 72%, 46% 56%;
        }
        75% {
          background-position: 20% 23%, 90% 18%, 16% 94%, 82% 79%, 54% 45%;
        }
        100% {
          background-position: 4% 10%, 98% 14%, 13% 88%, 90% 84%, 50% 50%;
        }
      }
      @keyframes ncm-gradient-blob-drift {
        0% {
          transform: translate(-10%, -8%) scale(1.04) rotate(-11deg);
        }
        50% {
          transform: translate(12%, 10%) scale(1.17) rotate(9deg);
        }
        100% {
          transform: translate(-12%, 13%) scale(1.08) rotate(-12deg);
        }
      }
      @keyframes ncm-gradient-noise-drift {
        0% {
          transform: translate(0, 0);
        }
        50% {
          transform: translate(-0.8px, 0.9px);
        }
        100% {
          transform: translate(0.9px, -0.7px);
        }
      }
    `;
    document.head.appendChild(style);
  }

  function getNowPlaying() {
    const titleEl = document.querySelector('div[data-testid="context-item-info-title"]');
    const authorEl = document.querySelector('div[data-testid="context-item-info-subtitles"]');
    const timeEl = document.querySelector('div[data-testid="playback-position"]');
    const durationEl = document.querySelector('div[data-testid="playback-duration"]');

    if (!titleEl || !authorEl || !timeEl || !durationEl) return null;

    const title = (titleEl.textContent || '').trim();
    const artist = (authorEl.textContent || '').trim();
    if (!title || !artist) return null;

    return {
      key: `${title} - ${artist}`,
      title: title.normalize('NFKC'),
      artist: artist.normalize('NFKC'),
    };
  }

  function clamp255(v) {
    return Math.max(0, Math.min(255, Math.round(v)));
  }

  function rgbToHsl(r, g, b) {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const d = max - min;
    let h = 0;
    const l = (max + min) / 2;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    if (d !== 0) {
      if (max === rn) h = ((gn - bn) / d) % 6;
      else if (max === gn) h = (bn - rn) / d + 2;
      else h = (rn - gn) / d + 4;
      h /= 6;
      if (h < 0) h += 1;
    }
    return { h, s, l };
  }

  function hslToRgb(h, s, l) {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hue = (t) => {
      let x = t;
      if (x < 0) x += 1;
      if (x > 1) x -= 1;
      if (x < 1 / 6) return p + (q - p) * 6 * x;
      if (x < 1 / 2) return q;
      if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
      return p;
    };
    if (s === 0) {
      const gray = clamp255(l * 255);
      return { r: gray, g: gray, b: gray };
    }
    return {
      r: clamp255(hue(h + 1 / 3) * 255),
      g: clamp255(hue(h) * 255),
      b: clamp255(hue(h - 1 / 3) * 255),
    };
  }

  function shiftColor(color, dh = 0, ds = 0, dl = 0) {
    const hsl = rgbToHsl(color.r, color.g, color.b);
    const h = (hsl.h + dh + 1) % 1;
    const s = Math.max(0.05, Math.min(0.95, hsl.s + ds));
    const l = Math.max(0.08, Math.min(0.90, hsl.l + dl));
    return hslToRgb(h, s, l);
  }

  function rgba(color, alpha) {
    return `rgba(${clamp255(color.r)}, ${clamp255(color.g)}, ${clamp255(color.b)}, ${alpha})`;
  }

  function parseRgbText(text) {
    const m = String(text || '').match(/rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
    if (!m) return null;
    return { r: clamp255(+m[1]), g: clamp255(+m[2]), b: clamp255(+m[3]) };
  }

  function getCoverImageSrc() {
    const exactSelectors = [
      'footer [data-testid="cover-art-image"] img',
      '[data-testid="now-playing-bar"] [data-testid="cover-art-image"] img',
      '[data-testid="now-playing-widget"] [data-testid="cover-art-image"] img',
      '[data-testid="now-playing-widget"] img',
      '[data-testid="cover-art-image"] img',
    ];
    for (const sel of exactSelectors) {
      const img = document.querySelector(sel);
      if (!(img instanceof HTMLImageElement)) continue;
      const src = String(img.currentSrc || img.src || '').trim();
      if (!src || !/i\.scdn\.co\/image\//.test(src)) continue;
      return src;
    }

    const footerImgs = Array.from(document.querySelectorAll('footer img[src*="i.scdn.co/image/"]'));
    for (const img of footerImgs) {
      if (!(img instanceof HTMLImageElement)) continue;
      const src = String(img.currentSrc || img.src || '').trim();
      if (src) return src;
    }

    const selectors = [
      '#main-view img[src*="i.scdn.co/image/"]',
      'img[src*="i.scdn.co/image/"]',
    ];

    for (const sel of selectors) {
      const img = document.querySelector(sel);
      if (!(img instanceof HTMLImageElement)) continue;
      const src = String(img.currentSrc || img.src || '').trim();
      if (!src) continue;
      return src;
    }
    return '';
  }

  function getGradientHost() {
    // Spotify web-player lyrics wrapper carries inline CSS vars like
    // --lyrics-color-background / --lyrics-color-active. This is the
    // most stable runtime marker for the actual lyrics background layer.
    const byRuntimeVars = document.querySelector(
      '#lyrics-cinema [style*="--lyrics-color-background"], #main-view [style*="--lyrics-color-background"]',
    );
    if (byRuntimeVars instanceof HTMLElement) return byRuntimeVars;

    const lyricsRoot = getLyricsRoot();
    if (!lyricsRoot) return null;
    let node = lyricsRoot;
    while (node && node !== document.body && node !== document.documentElement) {
      const styleText = String(node.getAttribute('style') || '');
      if (styleText.includes('--lyrics-color-background')) return node;
      node = node.parentElement;
    }

    // Fallback if Spotify updates variable names.
    const byKnownAnchor = document.querySelector('#lyrics-cinema') || document.querySelector('#main-view');
    if (byKnownAnchor instanceof HTMLElement) return byKnownAnchor;
    return lyricsRoot;
  }

  function pickGradientPaintLayer(host) {
    if (!(host instanceof HTMLElement)) return host;

    const hostChildren = Array.from(host.children).filter((el) => el instanceof HTMLElement);
    for (const child of hostChildren) {
      const cs = getComputedStyle(child);
      const hasSolidBg = cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent';
      const pos = cs.position;
      const isOverlayLike = (pos === 'absolute' || pos === 'sticky' || pos === 'fixed') && child.clientHeight > host.clientHeight * 0.55;
      if (hasSolidBg || isOverlayLike) {
        return child;
      }
    }

    return host;
  }

  const coverPaletteCache = new Map();
  let gradientHost = null;
  let gradientLayer = null;
  let gradientTrackKey = '';
  let gradientCoverSrc = '';
  let gradientUpdateToken = 0;
  let lastGradientPalette = null;
  let currentPlaybackPaused = false;
  let lastPlaybackSecond = -1;
  let lastPlaybackProbeMs = 0;

  function parseClockTextToSec(text) {
    const v = String(text || '').trim();
    if (!v) return -1;
    const m = v.match(/^(\d+):(\d{2})$/);
    if (!m) return -1;
    return Number(m[1]) * 60 + Number(m[2]);
  }

  function detectPausedByPlayButton() {
    const btn = document.querySelector('button[data-testid="control-button-playpause"]');
    if (!(btn instanceof HTMLElement)) return null;
    const label = String(btn.getAttribute('aria-label') || btn.getAttribute('title') || '').toLowerCase();
    // Spotify 的按钮语义通常是“点击后执行的动作”：
    // 显示 Pause/暂停 => 当前正在播放；显示 Play/播放 => 当前已暂停。
    if (/(pause|暂停)/.test(label)) return false;
    if (/(play|播放)/.test(label)) return true;
    return null;
  }

  function detectPausedByProgressClock() {
    const posEl = document.querySelector('div[data-testid="playback-position"]');
    if (!(posEl instanceof HTMLElement)) return null;
    const sec = parseClockTextToSec(posEl.textContent);
    if (sec < 0) return null;

    const now = Date.now();
    if (lastPlaybackSecond < 0) {
      lastPlaybackSecond = sec;
      lastPlaybackProbeMs = now;
      return null;
    }

    if (sec > lastPlaybackSecond) {
      lastPlaybackSecond = sec;
      lastPlaybackProbeMs = now;
      return false;
    }

    if (sec < lastPlaybackSecond) {
      lastPlaybackSecond = sec;
      lastPlaybackProbeMs = now;
      return false;
    }

    if ((now - lastPlaybackProbeMs) > 1800) {
      return true;
    }
    return null;
  }

  function getPlaybackPausedState() {
    const byButton = detectPausedByPlayButton();
    if (typeof byButton === 'boolean') return byButton;

    const byClock = detectPausedByProgressClock();
    if (typeof byClock === 'boolean') return byClock;
    return currentPlaybackPaused;
  }

  function syncGradientPlayState() {
    if (!(gradientHost instanceof HTMLElement)) return;
    gradientHost.classList.toggle('ncm-lyrics-gradient-paused', currentPlaybackPaused);
    if (gradientLayer instanceof HTMLElement) {
      gradientLayer.style.setProperty('animation-play-state', currentPlaybackPaused ? 'paused' : 'running', 'important');
    }
  }

  function colorDistSq(a, b) {
    const dr = a.r - b.r;
    const dg = a.g - b.g;
    const db = a.b - b.b;
    return dr * dr + dg * dg + db * db;
  }

  function pickDistinctByDistance(pool, targetCount) {
    const src = pool.filter(Boolean);
    if (!src.length) return [];
    const picked = [src[0]];
    const left = src.slice(1);

    while (picked.length < targetCount && left.length) {
      let bestIdx = 0;
      let bestScore = -1;
      for (let i = 0; i < left.length; i += 1) {
        const cand = left[i];
        const nearest = Math.min(...picked.map((p) => colorDistSq(cand, p)));
        if (nearest > bestScore) {
          bestScore = nearest;
          bestIdx = i;
        }
      }
      picked.push(left.splice(bestIdx, 1)[0]);
    }
    return picked;
  }

  function normalizePalette(palette) {
    // 按用户要求：直接使用封面采样原色，不做任何色相/饱和度/明度偏移。
    const base = palette && palette.length ? palette : [
      { r: 160, g: 140, b: 190 },
      { r: 210, g: 140, b: 170 },
      { r: 90, g: 110, b: 190 },
      { r: 34, g: 30, b: 54 },
    ];
    const distinct = pickDistinctByDistance(base, 4);
    const cTopLeft = distinct[0] || base[0];
    const cTopRight = distinct[1] || distinct[0] || base[1];
    const cBottomLeft = distinct[2] || distinct[1] || distinct[0] || base[2];
    const cBottomRight = distinct[3] || distinct[2] || distinct[1] || distinct[0] || base[3];
    const cBaseDark = distinct[3] || distinct[0] || base[3];

    return {
      g1: rgba(cTopLeft, 0.86),
      g2: rgba(cTopRight, 0.84),
      g3: rgba(cBottomLeft, 0.92),
      g4: rgba(cBaseDark, 0.995),
      g5: rgba(cBottomLeft, 0.82),
      g6: rgba(cBottomRight, 0.80),
    };
  }

  async function extractPaletteFromCover(src) {
    const hit = coverPaletteCache.get(src);
    if (hit) return hit;

    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.crossOrigin = 'anonymous';
      el.referrerPolicy = 'no-referrer';
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = src;
    });

    const size = 56;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('no canvas context');
    ctx.drawImage(img, 0, 0, size, size);
    const pixels = ctx.getImageData(0, 0, size, size).data;

    const bins = new Map();
    for (let i = 0; i < pixels.length; i += 16) {
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      const a = pixels[i + 3];
      if (a < 180) continue;
      const { h, s, l } = rgbToHsl(r, g, b);

      const key = `${r >> 5}-${g >> 5}-${b >> 5}`;
      const cur = bins.get(key) || { count: 0, r: 0, g: 0, b: 0, s: 0, l: 0, h: 0 };
      cur.count += 1;
      cur.r += r;
      cur.g += g;
      cur.b += b;
      cur.s += s;
      cur.l += l;
      cur.h += h;
      bins.set(key, cur);
    }

    let candidates = Array.from(bins.values()).map((v) => {
      const count = v.count || 1;
      const color = {
        r: clamp255(v.r / count),
        g: clamp255(v.g / count),
        b: clamp255(v.b / count),
      };
      const sat = v.s / count;
      const lig = v.l / count;
      const hue = v.h / count;
      const vivid = count * (0.40 + sat) * (1 - Math.abs(lig - 0.50) * 0.70);
      const darkBoost = count * (lig < 0.32 ? 1.25 : 0.0);
      const lightBoost = count * (lig > 0.74 ? 1.25 : 0.0);
      const neutralBoost = count * (sat < 0.18 ? 0.65 : 0.0);
      const coreBandBoost = count * (lig > 0.22 && lig < 0.76 ? 0.45 : 0);
      const score = vivid + darkBoost + lightBoost + neutralBoost + coreBandBoost;
      return { color, sat, lig, hue, score };
    }).sort((a, b) => b.score - a.score);

    if (!candidates.length) {
      throw new Error('palette extraction failed');
    }

    const top = candidates.slice(0, 32);
    const dominant = top[0];
    const darkCand = top.filter((c) => c.lig <= 0.28).sort((a, b) => b.score - a.score)[0];
    const lightCand = top.filter((c) => c.lig >= 0.72).sort((a, b) => b.score - a.score)[0];
    const accentCand = top
      .filter((c) => c !== dominant)
      .sort((a, b) => {
        const dsA = colorDistSq(a.color, dominant.color);
        const dsB = colorDistSq(b.color, dominant.color);
        return dsB - dsA;
      })[0];

    const seeds = [dominant, accentCand, darkCand, lightCand]
      .filter(Boolean)
      .map((x) => x.color);
    const result = pickDistinctByDistance(seeds, 4);
    const filler = pickDistinctByDistance(top.map((x) => x.color), 12);
    for (const c of filler) {
      if (result.length >= 4) break;
      if (result.every((p) => colorDistSq(p, c) > 1200)) result.push(c);
    }

    while (result.length < 4) {
      result.push(result[result.length - 1] || dominant.color);
    }

    coverPaletteCache.set(src, result);
    return result;
  }

  function buildFallbackPalette(host) {
    const cs = getComputedStyle(host);
    const base = parseRgbText(cs.backgroundColor) || { r: 120, g: 40, b: 40 };
    return [base, base, base, base];
  }

  function applyGradientVars(host, palette) {
    const p = normalizePalette(palette);
    const layer = pickGradientPaintLayer(host);
    gradientLayer = layer;

    host.classList.add('ncm-lyrics-gradient-host');
    layer.classList.add('ncm-lyrics-gradient-layer');
    layer.style.setProperty('--ncm-grad-1', p.g1);
    layer.style.setProperty('--ncm-grad-2', p.g2);
    layer.style.setProperty('--ncm-grad-3', p.g3);
    layer.style.setProperty('--ncm-grad-4', p.g4);
    layer.style.setProperty('--ncm-grad-5', p.g5);
    layer.style.setProperty('--ncm-grad-6', p.g6);
    layer.style.setProperty('background-color', p.g4, 'important');
    layer.style.setProperty('background-blend-mode', 'normal, normal, normal, normal, normal', 'important');
    layer.style.setProperty('background-size', '214% 210%, 212% 208%, 220% 216%, 214% 210%, 168% 168%', 'important');
    layer.style.setProperty('background-position', '2% 7%, 98% 12%, 12% 92%, 92% 84%, 50% 50%', 'important');
    layer.style.setProperty('background-repeat', 'no-repeat', 'important');
    layer.style.setProperty('animation', 'ncm-gradient-bg-flow 4.6s linear infinite', 'important');
    layer.style.setProperty('will-change', 'background-position, filter, transform', 'important');
    layer.style.setProperty('transform', 'translateZ(0)', 'important');
    syncGradientPlayState();
    lastGradientPalette = palette;
  }

  async function updateLyricsGradient(trackKey) {
    const host = getGradientHost();
    if (!host) return;

    if (gradientHost && gradientHost !== host) {
      gradientHost.classList.remove('ncm-lyrics-gradient-host');
      gradientHost.classList.remove('ncm-lyrics-gradient-paused');
      if (gradientLayer instanceof HTMLElement) {
        gradientLayer.classList.remove('ncm-lyrics-gradient-layer');
        gradientLayer.style.removeProperty('--ncm-grad-1');
        gradientLayer.style.removeProperty('--ncm-grad-2');
        gradientLayer.style.removeProperty('--ncm-grad-3');
        gradientLayer.style.removeProperty('--ncm-grad-4');
        gradientLayer.style.removeProperty('--ncm-grad-5');
        gradientLayer.style.removeProperty('--ncm-grad-6');
        gradientLayer.style.removeProperty('background-blend-mode');
        gradientLayer.style.removeProperty('background-size');
        gradientLayer.style.removeProperty('background-position');
        gradientLayer.style.removeProperty('background-repeat');
        gradientLayer.style.removeProperty('animation');
        gradientLayer.style.removeProperty('animation-play-state');
        gradientLayer.style.removeProperty('will-change');
        gradientLayer.style.removeProperty('transform');
      }
      gradientLayer = null;
    }
    gradientHost = host;

    const coverSrc = getCoverImageSrc();
    if (trackKey === gradientTrackKey && coverSrc && coverSrc === gradientCoverSrc) {
      if (lastGradientPalette) applyGradientVars(host, lastGradientPalette);
      return;
    }

    gradientTrackKey = trackKey;
    gradientCoverSrc = coverSrc;
    const token = ++gradientUpdateToken;

    try {
      const palette = coverSrc ? await extractPaletteFromCover(coverSrc) : buildFallbackPalette(host);
      if (token !== gradientUpdateToken) return;
      applyGradientVars(host, palette);
    } catch (err) {
      if (token !== gradientUpdateToken) return;
      console.debug(`${LOG} 封面取色失败，使用回退色:`, err);
      applyGradientVars(host, buildFallbackPalette(host));
    }
  }

  function extractLyricsLineElements() {
    const selectors = [
      '#main-view [data-testid="lyrics-line"]',
      '#main-view [data-testid="lyrics-line-always-visible"]',
      '[data-testid="lyrics-container"] [data-testid="lyrics-line"]',
      '[data-testid="lyrics-container"] p',
    ];
    const all = [];
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach((el) => all.push(el));
    }

    const dedup = [];
    const seen = new Set();
    for (const el of all) {
      if (!(el instanceof HTMLElement)) continue;
      if (seen.has(el)) continue;
      seen.add(el);

      const txt = (el.textContent || '').trim();
      if (!txt) continue;
      if (txt.length > 140) continue;
      if (/^\d+:\d+$/.test(txt)) continue;

      dedup.push(el);
    }
    return dedup;
  }

  function getLyricsRoot() {
    const line = document.querySelector('#main-view [data-testid="lyrics-line"], #main-view [data-testid="lyrics-line-always-visible"]');
    if (line && line.parentElement) return line.parentElement;
    const container = document.querySelector('[data-testid="lyrics-container"]');
    if (container) return container;
    return document.querySelector('#main-view') || document.body;
  }

  function resolveTranslationForLine(lineText, transMap) {
    const key = normalizeText(lineText);
    if (!key) return '';

    const exact = transMap.get(key);
    if (exact) return exact;

    let best = '';
    let bestScore = 0.82;
    for (const [orig, trans] of transMap.entries()) {
      const score = similarity(orig, key);
      if (score > bestScore) {
        bestScore = score;
        best = trans;
      }
    }
    return best;
  }

  function getLineVisualSource(host) {
    for (const node of Array.from(host.childNodes)) {
      if (node instanceof HTMLElement && node.classList.contains('ncm-inline-trans')) continue;
      if (node instanceof HTMLElement) return node;
    }
    return host;
  }

  function getLineVisualSignature(host) {
    const src = getLineVisualSource(host);
    const cs = getComputedStyle(src);
    return `${cs.color}|${cs.opacity}|${cs.fontWeight}`;
  }

  function syncTranslationVisual(host, transEl) {
    if (!transEl) return;
    const src = getLineVisualSource(host);
    const cs = getComputedStyle(src);
    transEl.style.color = cs.color;
    transEl.style.opacity = cs.opacity;
    transEl.style.fontWeight = cs.fontWeight;
  }

  function upsertTranslationLine(host, trans) {
    let transEl = host.querySelector(':scope > .ncm-inline-trans');
    if (!trans) {
      if (transEl) transEl.remove();
      host.classList.remove('ncm-inline-host');
      return null;
    }

    if (!transEl) {
      transEl = document.createElement('div');
      transEl.className = 'ncm-inline-trans';
      host.appendChild(transEl);
      host.classList.add('ncm-inline-host');
    }

    if (transEl.textContent !== trans) {
      transEl.textContent = trans;
    }

    syncTranslationVisual(host, transEl);
    return transEl;
  }

  function getOriginalLineText(line) {
    const pieces = [];
    for (const node of Array.from(line.childNodes)) {
      if (node instanceof HTMLElement && node.classList.contains('ncm-inline-trans')) continue;
      pieces.push(node.textContent || '');
    }
    const merged = pieces.join('').trim();
    if (merged) return merged;

    const transNode = line.querySelector(':scope > .ncm-inline-trans');
    const full = (line.textContent || '').trim();
    if (!transNode) return full;

    const transText = (transNode.textContent || '').trim();
    if (!transText) return full;
    return full.replace(transText, '').trim();
  }

  let lineStateMap = new WeakMap();
  let isRendering = false;
  let renderScheduled = false;
  let lastRenderTs = 0;
  let lyricsObserver = null;
  let observerRoot = null;

  function renderInlineTranslations(transMap) {
    const lines = extractLyricsLineElements();
    if (!lines.length) return;

    const nowTs = Date.now();
    isRendering = true;
    for (const line of lines) {
      const transNode = line.querySelector(':scope > .ncm-inline-trans');
      const origText = getOriginalLineText(line);
      const visualSig = getLineVisualSignature(line);

      const trans = resolveTranslationForLine(origText, transMap);
      const prev = lineStateMap.get(line) || {};
      const prevTransDom = transNode ? (transNode.textContent || '') : '';
      if (prev && prev.orig === origText && prev.trans === trans && prevTransDom === trans && prev.visualSig === visualSig) {
        continue;
      }
      if (trans) {
        const el = upsertTranslationLine(line, trans);
        if (el) syncTranslationVisual(line, el);
        lineStateMap.set(line, { orig: origText, trans, missingSince: 0, missingOrig: '', visualSig });
      } else {
        // Spotify 切高亮时会短暂替换几行 DOM，优先保留旧翻译避免“消失再出现”
        let shouldRemove = false;
        if (transNode) {
          if (prev.missingOrig !== origText || !prev.missingSince) {
            prev.missingOrig = origText;
            prev.missingSince = nowTs;
          } else if ((nowTs - prev.missingSince) > REMOVE_GRACE_MS) {
            shouldRemove = true;
          }
        }

        // 若同一首歌里已有旧翻译，宁可暂时保留，避免切行闪烁
        if (shouldRemove && transNode) {
          upsertTranslationLine(line, '');
          lineStateMap.set(line, { orig: origText, trans: '', missingSince: 0, missingOrig: '', visualSig });
        } else {
          if (transNode) syncTranslationVisual(line, transNode);
          prev.visualSig = visualSig;
          lineStateMap.set(line, prev);
        }
      }
    }
    isRendering = false;
  }

  function clearTranslations() {
    document.querySelectorAll('.ncm-inline-trans').forEach((el) => el.remove());
    document.querySelectorAll('.ncm-inline-host').forEach((el) => el.classList.remove('ncm-inline-host'));
    lineStateMap = new WeakMap();
  }

  async function ensureRegister() {
    const registerTime = Number(await gmGetValue('ncm.inline.register.time', 0));
    const now = Date.now();
    if (now - registerTime < 7 * 24 * 60 * 60 * 1000) return;

    try {
      const deviceId = '7B79802670C7A45DB9091976D71E0AE829E28926C6C34A1B8644';
      await cloudmusic.register(deviceId);
      await gmSetValue('ncm.inline.register.time', now);
      console.log(`${LOG} 注册匿名设备成功。`);
    } catch (err) {
      console.warn(`${LOG} 注册匿名设备失败:`, err);
    }
  }

  let currentTrackKey = '';
  let currentTransMap = new Map();
  let lyricsReadyForTrack = '';

  async function searchAndLoadLyrics(title, artist, trackKey) {
    const keywords = collectKeywords(title, artist);
    const allResults = [];
    const seen = new Set();

    for (const kw of keywords) {
      try {
        const res = await cloudmusic.search(kw, SEARCH_LIMIT);
        const rows = res?.data?.resources || [];
        for (const row of rows) {
          const sid = String(row?.resourceId || '');
          if (!sid || seen.has(sid)) continue;
          seen.add(sid);
          allResults.push(row);
          if (allResults.length >= MAX_RESULTS) break;
        }
      } catch (err) {
        console.debug(`${LOG} 搜索失败:`, kw, err);
      }
      if (allResults.length >= MAX_RESULTS) break;
    }

    if (!allResults.length) {
      console.warn(`${LOG} 未找到候选歌词: ${title} - ${artist}`);
      currentTransMap = new Map();
      lyricsReadyForTrack = trackKey;
      clearTranslations();
      return;
    }

    const scored = allResults
      .map((song) => {
        const name = String(song?.baseInfo?.simpleSongData?.name || '');
        const artists = (song?.baseInfo?.simpleSongData?.ar || []).map((x) => String(x?.name || ''));
        return {
          song,
          score: songScore(name, artists, title, artist),
          name,
          artists,
        };
      })
      .sort((a, b) => b.score - a.score);

    for (const item of scored.slice(0, 8)) {
      try {
        const lyricData = await cloudmusic.lyric(item.song.resourceId);
        const timeline = buildTimeline(lyricData);
        if (timeline.length < 3) continue;

        currentTransMap = buildTranslationMap(timeline);
        lyricsReadyForTrack = trackKey;
        console.log(`${LOG} 已加载歌词:`, item.name, '-', item.artists.join('/'), `(${timeline.length} 行)`);
        return;
      } catch (err) {
        console.debug(`${LOG} 拉取歌词失败:`, item.song.resourceId, err);
      }
    }

    currentTransMap = new Map();
    lyricsReadyForTrack = trackKey;
    clearTranslations();
    console.warn(`${LOG} 找到歌曲但未拿到可用翻译歌词: ${title} - ${artist}`);
  }

  function requestRender(immediate = false) {
    if (!(currentTrackKey && currentTrackKey === lyricsReadyForTrack && currentTransMap.size > 0)) return;
    if (renderScheduled) return;

    renderScheduled = true;
    const run = () => {
      renderScheduled = false;
      lastRenderTs = performance.now();
      renderInlineTranslations(currentTransMap);
    };

    if (immediate) {
      requestAnimationFrame(run);
      return;
    }

    const now = performance.now();
    const wait = Math.max(0, RENDER_THROTTLE_MS - (now - lastRenderTs));
    setTimeout(run, wait);
  }

  function ensureDomObserver() {
    const root = getLyricsRoot();
    if (!root) return;
    if (lyricsObserver && observerRoot === root) return;

    if (lyricsObserver) lyricsObserver.disconnect();

    observerRoot = root;
    lyricsObserver = new MutationObserver((mutationList) => {
      if (isRendering) return;
      for (const m of mutationList) {
        const target = m.target instanceof Element ? m.target : m.target?.parentElement;
        if (!target) continue;
        if (target.closest('.ncm-inline-trans')) continue;
        if (currentTrackKey && currentTrackKey === lyricsReadyForTrack && currentTransMap.size > 0) {
          renderInlineTranslations(currentTransMap);
          lastRenderTs = performance.now();
          renderScheduled = false;
        } else {
          requestRender(true);
        }
        return;
      }
    });
    lyricsObserver.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  async function mainLoop() {
    const nowPlaying = getNowPlaying();
    if (!nowPlaying) return;
    currentPlaybackPaused = getPlaybackPausedState();
    syncGradientPlayState();

    if (nowPlaying.key !== currentTrackKey) {
      currentTrackKey = nowPlaying.key;
      lyricsReadyForTrack = '';
      currentTransMap = new Map();
      clearTranslations();
      await updateLyricsGradient(nowPlaying.key);
      console.log(`${LOG} 当前播放: ${nowPlaying.title} - ${nowPlaying.artist}`);
      await searchAndLoadLyrics(nowPlaying.title, nowPlaying.artist, nowPlaying.key);
    }

    if (currentTrackKey === lyricsReadyForTrack && currentTransMap.size > 0) {
      requestRender();
    }
  }

  async function init() {
    addStyles();
    await ensureRegister();
    ensureDomObserver();

    setInterval(() => {
      mainLoop().catch((err) => console.error(`${LOG} mainLoop error:`, err));
    }, TICK_MS);

    setInterval(() => {
      ensureDomObserver();
      if (currentTrackKey && currentTrackKey === lyricsReadyForTrack && currentTransMap.size > 0) {
        requestRender();
      }
    }, DOM_SWEEP_MS);

    setInterval(() => {
      if (!currentTrackKey) return;
      updateLyricsGradient(currentTrackKey).catch((err) => console.debug(`${LOG} gradient refresh error:`, err));
    }, GRADIENT_REFRESH_MS);

    console.log(`${LOG} 已启动。`);
  }

  init().catch((err) => {
    console.error(`${LOG} 初始化失败:`, err);
  });
})();
