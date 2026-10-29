// Build: concatenates backend parts + inlines the PWA into ONE worker.js file.
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, 'src');
const web = join(here, 'web');
const icons = join(here, 'icons');

const parts = readdirSync(src).filter((f) => f.endsWith('.js')).sort().map((f) => readFileSync(join(src, f), 'utf8'));
const webFiles = ['index.html', 'app.js', 'app.css', 'sw.js'].map((f) => readFileSync(join(web, f), 'utf8'));
const iconFiles = ['icon-192.png', 'icon-512.png', 'apple-touch-icon.png'].map((f) => readFileSync(join(icons, f)));

const h = createHash('sha256');
for (const p of [...parts, ...webFiles]) h.update(p);
for (const b of iconFiles) h.update(b);
const BUILD = h.digest('hex').slice(0, 10);

const sub = (s) => s.replaceAll('__BUILD__', BUILD);
const [html, appjs, css, sw] = webFiles.map(sub);
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const manifest = JSON.stringify({
  name: '周末去哪儿',
  short_name: '周末去哪儿',
  description: '两个人的周末活动清单',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#fff7f0',
  theme_color: '#3730a3',
  lang: 'zh-CN',
  icons: [
    { src: `/icon-192.png?v=${BUILD}`, sizes: '192x192', type: 'image/png' },
    { src: `/icon-512.png?v=${BUILD}`, sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
  ],
});

const IMM = 'public, max-age=31536000, immutable';
const DAYC = 'public, max-age=86400';
const assets = {
  '/': { type: 'text/html; charset=utf-8', body: html, cache: 'no-cache' },
  '/app.js': { type: 'application/javascript; charset=utf-8', body: appjs, cache: IMM },
  '/app.css': { type: 'text/css; charset=utf-8', body: css, cache: IMM },
  '/sw.js': { type: 'application/javascript; charset=utf-8', body: sw, cache: 'no-cache' },
  '/manifest.webmanifest': { type: 'application/manifest+json; charset=utf-8', body: manifest, cache: DAYC },
  '/icon-192.png': { type: 'image/png', body: b64url(iconFiles[0]), b64: true, cache: DAYC },
  '/icon-512.png': { type: 'image/png', body: b64url(iconFiles[1]), b64: true, cache: DAYC },
  '/apple-touch-icon.png': { type: 'image/png', body: b64url(iconFiles[2]), b64: true, cache: DAYC },
  '/favicon.ico': { alias: '/icon-192.png' },
};

const header = `// 周末去哪儿 (weekend-planner) · build ${BUILD}
// 单文件 Cloudflare Worker：可以整段粘贴到 Cloudflare 的代码编辑器，也可以用 \`wrangler deploy\` 部署。
// 需要：D1 数据库绑定（变量名 DB）+ Cron 触发器（*/5 * * * *）。
// 本文件由 build.mjs 从 src/ 和 web/ 自动生成，请修改源文件后重新构建。License: MIT
`;
const body = parts.join('\n\n')
  + `\n\nconst BUILD_ID = ${JSON.stringify(BUILD)};\nconst ASSETS = ${JSON.stringify(assets)};\n`;

mkdirSync(join(here, 'dist'), { recursive: true });
writeFileSync(join(here, 'dist', 'worker.js'), `${header}${body}\nexport default worker;\n`);
// test build exposes internals
writeFileSync(join(here, 'dist', 'worker.test.mjs'), `${header}${body}\nexport default worker;\nexport const __t = { encryptPushPayload, vapidAuthHeader, getVapid, extractJson, stripCites, selectFinal, mergePools, cityResolver, weekendFor, targetWeekend, pushTsFor, bjTs, ymdOf, cronTick, initialState, sanitizeProfile, fallbackPersonal, titleSimilarity, normUrl, b64urlEncode, b64urlDecode, glowIndex, matchActivity, resetSchema: () => { schemaReady = false; knownOrigin = null; } };\n`);
console.log('built', BUILD, 'size', Buffer.byteLength(body) / 1024 | 0, 'KB');
