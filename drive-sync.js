/* Drive-synk för Kvittoappen och Ångra i tid
 * Sparar båda apparnas data i en fil "kvittoappen-data.json" i användarens Google Drive.
 * Apparna ligger på samma domän och delar localStorage, så en fil räcker för båda.
 */
(function () {
  // Klient-ID från Google Cloud Console (OAuth-klient, typ Webbapplikation)
  const CLIENT_ID = '990586145507-ml2njprnn0kpprmjaq6llspp38q2ta06.apps.googleusercontent.com';

  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const FILE_NAME = 'kvittoappen-data.json';
  const KEYS = ['kvitto_receipts', 'angra_items_v1'];
  const LS = {
    token: 'drive_token',
    fileId: 'drive_file_id',
    connected: 'drive_connected',
    localMod: 'drive_local_mod',
    lastSync: 'drive_last_sync',
    deleted: 'drive_deleted'
  };

  const rawSet = Storage.prototype.setItem;
  const rawRemove = Storage.prototype.removeItem;
  let suppress = false;
  let pushTimer = null;
  let tokenClient = null;
  let busy = false;
  let statusText = '';

  function get(k, def) { try { const v = localStorage.getItem(k); return v === null ? def : v; } catch (e) { return def; } }
  function setRaw(k, v) { try { rawSet.call(localStorage, k, v); } catch (e) {} }
  function readJSON(k, def) { try { return JSON.parse(get(k, '') || 'null') ?? def; } catch (e) { return def; } }

  // Upptäck ändringar i apparnas data och schemalägg uppladdning
  Storage.prototype.setItem = function (k, v) {
    let before = null;
    if (this === localStorage && KEYS.includes(k)) {
      try { before = this.getItem(k); } catch (e) {}
    }
    rawSet.call(this, k, v);
    if (this === localStorage && KEYS.includes(k) && !suppress) {
      trackDeletes(k, before, v);
      setRaw(LS.localMod, String(Date.now()));
      schedulePush();
    }
  };
  Storage.prototype.removeItem = function (k) {
    let before = null;
    if (this === localStorage && KEYS.includes(k)) { try { before = this.getItem(k); } catch (e) {} }
    rawRemove.call(this, k);
    if (this === localStorage && KEYS.includes(k) && !suppress) {
      trackDeletes(k, before, '[]');
      setRaw(LS.localMod, String(Date.now()));
      schedulePush();
    }
  };

  // Kom ihåg vilka poster som tagits bort, så att de inte kommer tillbaka från Drive
  function trackDeletes(key, beforeStr, afterStr) {
    let before = [], after = [];
    try { before = JSON.parse(beforeStr || '[]') || []; } catch (e) {}
    try { after = JSON.parse(afterStr || '[]') || []; } catch (e) {}
    const afterIds = new Set(after.map(x => String(x.id)));
    const gone = before.map(x => String(x.id)).filter(id => !afterIds.has(id));
    if (!gone.length) return;
    const del = readJSON(LS.deleted, {});
    del[key] = Array.from(new Set([...(del[key] || []), ...gone]));
    setRaw(LS.deleted, JSON.stringify(del));
  }

  // ---------- Inloggning ----------
  function savedToken() {
    const t = readJSON(LS.token, null);
    if (t && t.access_token && t.expires_at > Date.now() + 60000) return t.access_token;
    return null;
  }

  function loadGis() {
    return new Promise((resolve, reject) => {
      if (window.google && google.accounts && google.accounts.oauth2) return resolve();
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Kunde inte ladda Google-inloggningen'));
      document.head.appendChild(s);
    });
  }

  async function getToken(interactive) {
    const t = savedToken();
    if (t) return t;
    if (!interactive) return null;
    await loadGis();
    return new Promise((resolve, reject) => {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPE,
        callback: (resp) => {
          if (resp.error) return reject(new Error(resp.error));
          setRaw(LS.token, JSON.stringify({
            access_token: resp.access_token,
            expires_at: Date.now() + (Number(resp.expires_in) || 3600) * 1000
          }));
          setRaw(LS.connected, '1');
          resolve(resp.access_token);
        },
        error_callback: (err) => reject(new Error(err && err.type === 'popup_closed' ? 'Inloggningen avbröts' : 'Inloggningen misslyckades'))
      });
      tokenClient.requestAccessToken({ prompt: get(LS.connected, '') ? '' : 'consent' });
    });
  }

  // ---------- Drive-anrop ----------
  async function api(token, url, opts = {}) {
    const resp = await fetch(url, { ...opts, headers: { Authorization: 'Bearer ' + token, ...(opts.headers || {}) } });
    if (resp.status === 401) { rawRemove.call(localStorage, LS.token); throw new Error('AUTH'); }
    if (!resp.ok) throw new Error('Drive svarade ' + resp.status);
    return resp;
  }

  async function findFile(token) {
    const known = get(LS.fileId, '');
    if (known) {
      try {
        const r = await api(token, 'https://www.googleapis.com/drive/v3/files/' + known + '?fields=id,trashed');
        const f = await r.json();
        if (!f.trashed) return known;
      } catch (e) { if (e.message === 'AUTH') throw e; }
    }
    const q = encodeURIComponent("name='" + FILE_NAME + "' and trashed=false");
    const r = await api(token, 'https://www.googleapis.com/drive/v3/files?q=' + q + '&spaces=drive&fields=files(id,modifiedTime)&orderBy=modifiedTime desc');
    const files = (await r.json()).files || [];
    if (files.length) { setRaw(LS.fileId, files[0].id); return files[0].id; }
    return null;
  }

  async function download(token, id) {
    const r = await api(token, 'https://www.googleapis.com/drive/v3/files/' + id + '?alt=media');
    try { return await r.json(); } catch (e) { return null; }
  }

  async function upload(token, id, data) {
    const body = JSON.stringify(data);
    if (id) {
      await api(token, 'https://www.googleapis.com/upload/drive/v3/files/' + id + '?uploadType=media', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body
      });
      return id;
    }
    const boundary = 'kvitto' + Date.now();
    const multipart =
      '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify({ name: FILE_NAME, mimeType: 'application/json' }) + '\r\n' +
      '--' + boundary + '\r\nContent-Type: application/json\r\n\r\n' + body + '\r\n--' + boundary + '--';
    const r = await api(token, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
      method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body: multipart
    });
    const f = await r.json();
    setRaw(LS.fileId, f.id);
    return f.id;
  }

  // ---------- Sammanslagning ----------
  function merge(remote) {
    const localMod = Number(get(LS.localMod, '0'));
    const remoteMod = Number((remote && remote.updatedAt) || 0);
    const localWins = localMod >= remoteMod;
    const localDel = readJSON(LS.deleted, {});
    const remoteDel = (remote && remote.deleted) || {};
    const out = { version: 1, updatedAt: Math.max(localMod, remoteMod, Date.now()), deleted: {} };

    KEYS.forEach(key => {
      const del = new Set([...(localDel[key] || []), ...(remoteDel[key] || [])].map(String));
      out.deleted[key] = Array.from(del);
      const local = readJSON(key, []);
      const rem = (remote && Array.isArray(remote[key])) ? remote[key] : [];
      const map = new Map();
      const first = localWins ? rem : local;
      const second = localWins ? local : rem;
      first.forEach(x => map.set(String(x.id), x));
      second.forEach(x => map.set(String(x.id), x));
      out[key] = Array.from(map.values())
        .filter(x => !del.has(String(x.id)))
        .sort((a, b) => Number(b.id) - Number(a.id) || 0);
    });
    return out;
  }

  function applyLocal(data) {
    suppress = true;
    try {
      KEYS.forEach(key => setRaw(key, JSON.stringify(data[key] || [])));
      setRaw(LS.deleted, JSON.stringify(data.deleted || {}));
      setRaw(LS.localMod, String(data.updatedAt));
    } finally { suppress = false; }
    if (typeof window.onDriveSyncUpdate === 'function') {
      try { window.onDriveSyncUpdate(); } catch (e) {}
    }
  }

  // ---------- Synk ----------
  async function sync(interactive) {
    if (!CLIENT_ID) { setStatus('Drive är inte konfigurerat än.'); return; }
    if (busy) return;
    if (!interactive && !get(LS.connected, '')) return;
    busy = true;
    setStatus('Synkar…');
    try {
      let token = await getToken(interactive);
      if (!token) { setStatus('Tryck på "Synka nu" för att logga in igen.'); return; }
      let id;
      try { id = await findFile(token); }
      catch (e) {
        if (e.message !== 'AUTH' || !interactive) throw e;
        token = await getToken(true); id = await findFile(token);
      }
      const remote = id ? await download(token, id) : null;
      const merged = merge(remote);
      applyLocal(merged);
      await upload(token, id, merged);
      setRaw(LS.lastSync, String(Date.now()));
      setStatus('Synkat ' + new Date().toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' }));
    } catch (e) {
      setStatus(e.message === 'AUTH' ? 'Tryck på "Synka nu" för att logga in igen.' : 'Synk misslyckades: ' + e.message);
    } finally {
      busy = false;
      render();
    }
  }

  function schedulePush() {
    if (!get(LS.connected, '') || !CLIENT_ID) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => sync(false), 2500);
  }

  function disconnect() {
    if (!confirm('Koppla från Google Drive? Dina kvitton finns kvar både i telefonen och i Drive.')) return;
    const t = readJSON(LS.token, null);
    if (t && window.google && google.accounts && google.accounts.oauth2) {
      try { google.accounts.oauth2.revoke(t.access_token, () => {}); } catch (e) {}
    }
    [LS.token, LS.connected, LS.fileId].forEach(k => rawRemove.call(localStorage, k));
    setStatus('Frånkopplad.');
    render();
  }

  // ---------- Gränssnitt ----------
  function setStatus(s) { statusText = s; const el = document.getElementById('drive-sync-status'); if (el) el.textContent = s; }

  function render() {
    const box = document.getElementById('drive-sync-box');
    if (!box) return;
    const connected = !!get(LS.connected, '');
    const last = Number(get(LS.lastSync, '0'));
    const lastTxt = last ? 'Senast synkat ' + new Date(last).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' }) : '';
    const btn = 'padding:9px 14px;border-radius:8px;font-size:14px;cursor:pointer;border:1px solid #d1d5db;background:#fff;color:#111;';
    box.innerHTML =
      '<div style="font-size:14px;line-height:1.45;color:inherit;">' +
      (CLIENT_ID
        ? (connected
          ? '<div>✅ Kopplad till Google Drive. Alla köp sparas automatiskt i filen <b>' + FILE_NAME + '</b>.</div>'
          : '<div>Spara dina kvitton och köp i din Google Drive, så att de finns kvar om du byter telefon.</div>')
        : '<div>Drive-kopplingen är inte färdig än.</div>') +
      '<div id="drive-sync-status" style="margin:6px 0 10px;color:#6b7280;font-size:13px;">' + (statusText || lastTxt) + '</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
      (CLIENT_ID
        ? (connected
          ? '<button type="button" style="' + btn + 'background:#1a56db;color:#fff;border-color:#1a56db;" onclick="DriveSync.sync(true)">🔄 Synka nu</button>' +
            '<button type="button" style="' + btn + '" onclick="DriveSync.disconnect()">Koppla från</button>'
          : '<button type="button" style="' + btn + 'background:#1a56db;color:#fff;border-color:#1a56db;" onclick="DriveSync.sync(true)">☁️ Koppla Google Drive</button>')
        : '') +
      '</div></div>';
  }

  window.DriveSync = { sync, disconnect, render };

  function start() {
    render();
    if (get(LS.connected, '') && CLIENT_ID) sync(false);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && get(LS.connected, '') && CLIENT_ID) sync(false);
  });
})();
