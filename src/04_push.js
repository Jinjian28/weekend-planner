// ============================================================
//  Web Push (RFC 8291 aes128gcm + RFC 8292 VAPID) and Bark
// ============================================================

async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8);
  return new Uint8Array(bits);
}

// opts (tests only): { asPrivateJwk, salt }
async function encryptPushPayload(p256dh, auth, plaintextBytes, opts = {}) {
  const uaPublic = b64urlDecode(p256dh);
  const authSecret = b64urlDecode(auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error('无效的推送订阅密钥');
  let asPriv, asPublicRaw;
  if (opts.asPrivateJwk) {
    asPriv = await crypto.subtle.importKey('jwk', opts.asPrivateJwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const x = b64urlDecode(opts.asPrivateJwk.x), y = b64urlDecode(opts.asPrivateJwk.y);
    asPublicRaw = concatBytes(new Uint8Array([4]), x, y);
  } else {
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    asPriv = kp.privateKey;
    asPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  }
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPriv, 256));
  const keyInfo = concatBytes(ENC.encode('WebPush: info\0'), uaPublic, asPublicRaw);
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);
  const salt = opts.salt || crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, ENC.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, ENC.encode('Content-Encoding: nonce\0'), 12);
  const padded = concatBytes(plaintextBytes, new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, padded));
  const header = new Uint8Array(16 + 4 + 1 + asPublicRaw.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublicRaw.length;
  header.set(asPublicRaw, 21);
  return concatBytes(header, ct);
}

async function getVapid(db) {
  let v = await kvGet(db, 'vapid', null);
  if (v && v.publicKey && v.privateJwk) return v;
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const fresh = { publicKey: b64urlEncode(pub), privateJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d } };
  await kvSetIfAbsent(db, 'vapid', fresh);
  v = await kvGet(db, 'vapid', fresh); // whoever won the race
  return v;
}

async function vapidAuthHeader(endpoint, vapid, subject) {
  const aud = new URL(endpoint).origin;
  const header = b64urlEncode(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64urlEncode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const key = await crypto.subtle.importKey('jwk', { ...vapid.privateJwk, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, ENC.encode(`${header}.${payload}`)));
  return `vapid t=${header}.${payload}.${b64urlEncode(sig)}, k=${vapid.publicKey}`;
}

async function sendWebPush(inv, db, sub, payloadObj, origin) {
  const vapid = await getVapid(db);
  const body = await encryptPushPayload(sub.p256dh, sub.auth, ENC.encode(JSON.stringify(payloadObj)));
  const subject = origin && origin.startsWith('https://') ? origin : 'mailto:weekend-planner@users.noreply.github.com';
  const res = await xfetch(inv, sub.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      TTL: '86400',
      Urgency: 'high',
      Authorization: await vapidAuthHeader(sub.endpoint, vapid, subject),
    },
    body,
  }, 20000);
  const text = res.ok ? '' : clampStr(await res.text().catch(() => ''), 200);
  return { status: res.status, ok: res.ok, text };
}

async function sendBark(inv, barkUrl, title, body, link) {
  let base = String(barkUrl || '').trim();
  if (!isHttpUrl(base)) return { ok: false, text: 'Bark 地址无效' };
  base = base.replace(/\/+$/, '');
  const url = `${base}/${encodeURIComponent(title)}/${encodeURIComponent(clampStr(body, 400))}?group=${encodeURIComponent(APP_NAME)}${link ? `&url=${encodeURIComponent(link)}` : ''}`;
  const res = await xfetch(inv, url, {}, 15000);
  return { ok: res.ok, status: res.status, text: res.ok ? '' : clampStr(await res.text().catch(() => ''), 200) };
}

// Notify users. who: 'all' | userId | array of ids. Returns summary.
async function notifyUsers(inv, db, cfg, who, { title, body, url }) {
  const ids = who === 'all' ? cfg.users.map((u) => u.id) : (Array.isArray(who) ? who : [who]);
  const origin = (await kvGet(db, 'origin', '')) || '';
  const link = url ? (url.startsWith('http') ? url : origin + url) : origin;
  const summary = { sent: 0, failed: 0, removed: 0, details: [] };
  const trail = [];
  for (const id of ids) {
    const subs = (await db.prepare('SELECT * FROM push_subs WHERE user_id = ?').bind(id).all()).results || [];
    for (const sub of subs) {
      if (inv.subreq >= SUBREQ_SOFT_LIMIT + 4) break;
      try {
        const r = await sendWebPush(inv, db, sub, { title, body, url: url || '/' }, origin);
        trail.push(`${userName(cfg, id)}…${sub.endpoint.slice(-6)}:${r.status}`);
        if (r.ok) {
          summary.sent++;
          if (sub.fail_count) await db.prepare('UPDATE push_subs SET fail_count = 0 WHERE endpoint = ?').bind(sub.endpoint).run();
        } else if (r.status === 404 || r.status === 410) {
          summary.removed++;
          await db.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(sub.endpoint).run();
        } else {
          summary.failed++;
          summary.details.push(`${userName(cfg, id)}: ${r.status} ${r.text}`);
          await db.prepare('UPDATE push_subs SET fail_count = fail_count + 1 WHERE endpoint = ?').bind(sub.endpoint).run();
        }
      } catch (e) {
        summary.failed++;
        summary.details.push(`${userName(cfg, id)}: ${errMsg(e)}`);
      }
    }
    const bark = cfg.bark && cfg.bark[id];
    if (bark) {
      try {
        const r = await sendBark(inv, bark, title, body, link);
        if (r.ok) summary.sent++; else { summary.failed++; summary.details.push(`${userName(cfg, id)} Bark: ${r.status || ''} ${r.text}`); }
      } catch (e) {
        summary.failed++;
        summary.details.push(`${userName(cfg, id)} Bark: ${errMsg(e)}`);
      }
    }
  }
  if (summary.failed) await logEvent(db, 'warn', `推送部分失败：${summary.details.join('；')}`);
  await logEvent(db, 'info', `推送「${clampStr(title, 24)}」→ ${trail.length ? trail.join('，') : '没有登记的 App 设备'}${summary.removed ? `（清理失效设备 ${summary.removed} 台）` : ''}`);
  return summary;
}
