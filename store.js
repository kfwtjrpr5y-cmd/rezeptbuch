/* Rezeptbuch – Speicher in einem privaten GitHub-Repository.
   recipes.json  = alle Rezepte (ein Objekt pro Rezept-ID)
   photos/*.jpg  = Fotos
   Stellt window.claude.use("db" | "assets" | "user") bereit, damit die Oberfläche unverändert bleibt. */
(function () {
  "use strict";
  const CFG_KEY = "rb-config", CACHE_KEY = "rb-recipes-cache", PHOTO_CACHE = "rb-photos-v1";
  const API = (() => { try { return localStorage.getItem("rb-api-base") || "https://api.github.com"; } catch (e) { return "https://api.github.com"; } })();
  let cfg = null;
  try { cfg = JSON.parse(localStorage.getItem(CFG_KEY) || "null"); } catch (e) {}

  /* ---------- helpers ---------- */
  const enc = new TextEncoder(), dec = new TextDecoder();
  function b64FromBytes(u8) { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
  function bytesFromB64(b64) { const s = atob(b64.replace(/\s/g, "")); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
  function headers(raw) {
    return { Authorization: "Bearer " + cfg.token, Accept: raw ? "application/vnd.github.raw" : "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  }
  const contentsURL = (path) => `${API}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
  let upInfo = null; // {loaded,total,path} beim Hochladen grosser Dateien
  function xhrPut(url, hdrs, bodyText, path) {
    return new Promise((res, rej) => {
      const x = new XMLHttpRequest(); x.open("PUT", url);
      for (const k in hdrs) x.setRequestHeader(k, hdrs[k]);
      upInfo = { loaded: 0, total: bodyText.length, path };
      x.upload.onprogress = (e) => { upInfo = { loaded: e.loaded, total: e.total || bodyText.length, path }; };
      x.onload = () => { upInfo = null; const h = new Headers(); for (const line of x.getAllResponseHeaders().trim().split(/[\r\n]+/)) { const i = line.indexOf(":"); if (i > 0) try { h.append(line.slice(0, i).trim(), line.slice(i + 1).trim()); } catch (e) {} }
        res(new Response(x.responseText, { status: x.status < 200 ? 599 : x.status, headers: h })); };
      x.onerror = () => { upInfo = null; rej(new TypeError("Failed to fetch")); };
      x.timeout = Math.max(180e3, bodyText.length / 30e3 * 1000); // min. 30 KB/s, sonst neu versuchen
      x.ontimeout = x.onerror; x.send(bodyText);
    });
  }
  async function gh(path, opts = {}) {
    if (opts.method === "PUT" && opts.body && typeof XMLHttpRequest !== "undefined") return xhrPut(contentsURL(path), { ...headers(false), "Content-Type": "application/json" }, JSON.stringify(opts.body), path);
    const ac = !opts.raw && !opts.method && typeof AbortController !== "undefined" ? new AbortController() : null; const to = ac ? setTimeout(() => ac.abort(), 90e3) : 0;
    try { return await fetch(contentsURL(path), { method: opts.method || "GET", headers: { ...headers(opts.raw), ...(opts.body ? { "Content-Type": "application/json" } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined, cache: "no-store", signal: ac ? ac.signal : undefined }); }
    finally { clearTimeout(to); }
  }
  const err = (code, message) => ({ code, message });

  /* GitHub erlaubt höchstens ca. 80 schreibende Anfragen pro Minute und 500 pro Stunde.
     Dieser Zähler bremst rechtzeitig, damit grosse Importe nicht abbrechen. */
  const RL_KEY = "rb-write-log";
  function writeLog() { try { return JSON.parse(localStorage.getItem(RL_KEY) || "[]").filter((t) => t > Date.now() - 3600e3); } catch (e) { return []; } }
  let waitInfo = null; // {until, reason} für Fortschrittsanzeige
  async function throttle() {
    for (;;) {
      const now = Date.now(), log = writeLog();
      const lastMin = log.filter((t) => t > now - 60e3);
      let wait = 0;
      if (log.length >= 470) wait = log[log.length - 470] + 3600e3 - now + 1000;
      else if (lastMin.length >= 60) wait = lastMin[0] + 60e3 - now + 500;
      if (wait <= 0) { log.push(now); try { localStorage.setItem(RL_KEY, JSON.stringify(log)); } catch (e) {} waitInfo = null; return; }
      waitInfo = { until: now + wait };
      await new Promise((r) => setTimeout(r, Math.min(wait, 15000)));
    }
  }
  async function ghWrite(path, body) {
    for (let attempt = 0; attempt < 6; attempt++) {
      await throttle();
      let r;
      try { r = await gh(path, { method: "PUT", body }); }
      catch (e) { if (attempt < 3) { waitInfo = { until: Date.now() + 5e3 }; await new Promise((res) => setTimeout(res, 5e3)); waitInfo = null; continue; } throw err("unavailable", "Verbindung zu GitHub unterbrochen. Bitte nochmals versuchen."); }
      if ((r.status === 403 || r.status === 429) && attempt < 5) {
        const txt = await r.clone().text().catch(() => "");
        if (/rate limit|secondary/i.test(txt) || r.status === 429) {
          const ra = +(r.headers.get("retry-after") || 0), rs = +(r.headers.get("x-ratelimit-reset") || 0);
          const wait = ra ? ra * 1000 : (rs && /^0$/.test(r.headers.get("x-ratelimit-remaining") || "") ? Math.max(5e3, rs * 1000 - Date.now() + 1000) : 60e3 * (attempt + 1));
          waitInfo = { until: Date.now() + wait };
          await new Promise((res) => setTimeout(res, wait));
          continue;
        }
      }
      return r;
    }
    return gh(path, { method: "PUT", body });
  }

  /* ---------- recipes.json ---------- */
  let map = {}; let sha = null; const subs = [];
  const DATA_CACHE = "rb-data-v1", DATA_KEY = "https://rezeptbuch.local/recipes-cache.json";
  const cacheReady = (async () => {
    try { localStorage.removeItem(CACHE_KEY); } catch (e) {}
    try { const c = await caches.open(DATA_CACHE); const hit = await c.match(DATA_KEY); if (hit) { const j = await hit.json(); if (j && j.map && !Object.keys(map).length) { map = j.map; sha = j.sha || null; emit(); } } } catch (e) {}
  })();
  const snap = () => ({ docs: Object.keys(map).map((id) => ({ id, data: () => map[id] })) });
  function emit() { const s = snap(); subs.forEach((cb) => { try { cb(s); } catch (e) { console.error(e); } }); }
  function cacheLocal() { caches.open(DATA_CACHE).then((c) => c.put(DATA_KEY, new Response(JSON.stringify({ map, sha }), { headers: { "Content-Type": "application/json" } }))).catch(() => {}); }

  async function fetchRemote() {
    const r = await gh("recipes.json");
    if (r.status === 404) return { map: {}, sha: null };
    if (r.status === 401 || r.status === 403) throw err("auth", "Der Zugangsschlüssel (Token) stimmt nicht oder ist abgelaufen.");
    if (!r.ok) throw err("unavailable", "GitHub antwortet nicht (" + r.status + ").");
    const j = await r.json();
    let text;
    if (j.content && j.encoding === "base64") text = dec.decode(bytesFromB64(j.content));
    else {
      const rr = await gh("recipes.json", { raw: true });
      if (!rr.ok) throw err("unavailable", "Rezepte konnten nicht geladen werden (" + rr.status + ").");
      const total = +(rr.headers.get("content-length") || 0) || (j.size || 0);
      if (rr.body && rr.body.getReader && total > 2e6) {
        const rd = rr.body.getReader(); const parts = []; let got = 0, last = 0;
        for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value); got += value.length;
          if (Date.now() - last > 400) { last = Date.now(); setStatus(`Rezepte werden geladen … ${(got / 1048576).toFixed(1)} von ${(total / 1048576).toFixed(1)} MB`); } }
        const all = new Uint8Array(got); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; } text = dec.decode(all);
      } else text = await rr.text();
    }
    const parsed = JSON.parse(text || "{}");
    return { map: parsed.recipes || parsed, sha: j.sha };
  }
  let syncing = null;
  async function sync() {
    if (!cfg) return;
    if (syncing) return syncing;
    syncing = (async () => {
      try { const res = await fetchRemote(); map = res.map; sha = res.sha; for (const m of pendingMuts) { try { m(map); } catch (e) {} } cacheLocal(); emit(); setStatus(""); }
      catch (e) { setStatus(e && e.code === "auth" ? e.message : (Object.keys(map).length ? "Offline – du siehst die zuletzt geladene Version." : "Rezepte konnten nicht geladen werden: " + ((e && e.message) || e) + " – Seite neu laden.")); }
      finally { syncing = null; }
    })();
    return syncing;
  }
  /* Schreiben: Änderungen erscheinen sofort (optimistisch), das Hochladen läuft im Hintergrund,
     eine Änderung nach der anderen. Zuerst wird mit dem lokalen Stand geschrieben (spart den
     grossen Download); nur wenn ein anderes Gerät dazwischen gespeichert hat, wird neu geladen. */
  let wchain = Promise.resolve(); const pendingMuts = []; let pendingN = 0;
  function busy(d) { pendingN += d; window.RB && (window.RB.saving = pendingN > 0); window.dispatchEvent(new CustomEvent("rb-saving", { detail: pendingN })); }
  window.addEventListener("beforeunload", (e) => { if (pendingN > 0) { e.preventDefault(); e.returnValue = ""; } });
  async function remoteWrite(mutate, message, optimistic) {
    let local = !!(sha && Object.keys(map).length);
    for (let attempt = 0; attempt < 4; attempt++) {
      let baseMap, baseSha;
      if (local) { baseMap = map; baseSha = sha; } else { const cur = await fetchRemote(); baseMap = cur.map; baseSha = cur.sha; }
      const next = JSON.parse(JSON.stringify(baseMap));
      if (!(local && optimistic)) mutate(next);
      const body = { message, content: b64FromBytes(enc.encode(JSON.stringify({ format: "rezeptbuch", version: 1, recipes: next }))) };
      if (baseSha) body.sha = baseSha;
      const r = await ghWrite("recipes.json", body);
      if (r.ok) {
        const j = await r.json(); sha = j.content && j.content.sha;
        if (!local) { map = next; for (const m of pendingMuts) { try { m(map); } catch (e) {} } emit(); }
        else if (!optimistic) { map = next; for (const m of pendingMuts) { try { m(map); } catch (e) {} } emit(); }
        cacheLocal(); return;
      }
      if (r.status === 401 || r.status === 403) throw err("auth", "Der Zugangsschlüssel (Token) darf nicht schreiben oder ist abgelaufen.");
      if (r.status !== 409 && r.status !== 422) throw err("unavailable", "Speichern fehlgeschlagen (" + r.status + ").");
      local = false;
    }
    throw err("resource_exhausted", "Gleichzeitig auf einem anderen Gerät geändert. Bitte nochmals speichern.");
  }
  function writeAll(mutate, message, optimistic) {
    if (!navigator.onLine) return Promise.reject(err("offline", "Keine Internetverbindung. Speichern geht nur online."));
    if (optimistic) { mutate(map); pendingMuts.push(mutate); cacheLocal(); emit(); }
    busy(1);
    const job = wchain.then(() => remoteWrite(mutate, message, optimistic));
    wchain = job.catch(() => {});
    const done = job.finally(() => { busy(-1); if (optimistic) { const i = pendingMuts.indexOf(mutate); if (i >= 0) pendingMuts.splice(i, 1); } });
    if (optimistic) {
      done.catch((e) => { window.dispatchEvent(new CustomEvent("rb-save-error", { detail: (e && e.message) || "Speichern hat nicht geklappt." })); sync(); });
      return Promise.resolve();
    }
    return done;
  }

  const db = {
    collection: () => ({
      onSnapshot(cb) { subs.push(cb); cacheReady.then(() => { cb(snap()); sync(); }); return () => {}; },
      doc: (id) => ({
        set: (d) => writeAll((m) => { m[id] = d; }, "Rezept gespeichert: " + (d.title || id), true),
        delete: () => writeAll((m) => { delete m[id]; }, "Rezept gelöscht: " + id, true),
      }),
    }),
  };
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") sync(); });
  window.addEventListener("online", () => sync());

  /* ---------- Fotos ---------- */
  const urls = {}, pending = new Set(), queue = [], missing = new Set();
  let active = 0, notifyT = null;
  const cacheKey = (p) => "https://rezeptbuch.local/" + p;
  function notify() { clearTimeout(notifyT); notifyT = setTimeout(() => window.dispatchEvent(new Event("rb-photo")), 120); }
  async function loadPhoto(path) {
    try {
      let blob = null, cache = null;
      try { cache = await caches.open(PHOTO_CACHE); const hit = await cache.match(cacheKey(path)); if (hit) blob = await hit.blob(); } catch (e) {}
      if (!blob && String(path).startsWith("photos/mat-")) { const mm = await matMap(); if (mm) { for (const k in mm) if (!urls[k] && k !== path) { try { urls[k] = URL.createObjectURL(new Blob([bytesFromB64(mm[k])], { type: "image/jpeg" })); } catch (e) {} } if (mm[path]) blob = new Blob([bytesFromB64(mm[path])], { type: "image/jpeg" }); } }
      if (!blob && cfg && !String(path).startsWith("photos/mat-")) {
        const r = await gh(path, { raw: true });
        if (r.ok) { blob = await r.blob(); if (cache) cache.put(cacheKey(path), new Response(blob, { headers: { "Content-Type": "image/jpeg" } })).catch(() => {}); }
      }
      if (!blob && String(path).startsWith("photos/anl-")) { const wf = await wfMap(); if (wf && wf[path]) blob = new Blob([bytesFromB64(wf[path])], { type: "image/jpeg" }); }
      if (blob) { urls[path] = URL.createObjectURL(blob); notify(); } else { missing.add(path); notify(); }
    } catch (e) {} finally { pending.delete(path); active--; pump(); }
  }
  let wfP = null, mfP = null;
  function matMap() { if (!mfP) mfP = (async () => { try { return await readJSON("material-fotos.json"); } catch (e) { mfP = null; return null; } })(); return mfP; }
  const loadMaterialPhotos = async () => { const mm = await matMap(); if (!mm) return 0; let n = 0; for (const k in mm) if (!urls[k]) { try { urls[k] = URL.createObjectURL(new Blob([bytesFromB64(mm[k])], { type: "image/jpeg" })); n++; } catch (e) {} } notify(); return Object.keys(mm).length; };
  function wfMap() { if (!wfP) wfP = (async () => { try { return await readJSON("wissen-fotos.json"); } catch (e) { return null; } })(); return wfP; }
  function pump() { while (active < 6 && queue.length) { active++; loadPhoto(queue.shift()); } }
  function photoURL(path) {
    if (!path) return "";
    if (String(path).startsWith("data:") || String(path).startsWith("blob:")) return path;
    if (urls[path]) return urls[path];
    if (!pending.has(path)) { pending.add(path); queue.push(path); pump(); }
    return "";
  }
  async function putFile(path, bytes, message) {
    const r = await ghWrite(path, { message, content: b64FromBytes(bytes) });
    if (r.ok || r.status === 422) return true; // 422 = existiert schon
    if (r.status === 401 || r.status === 403) throw err("auth", "Der Zugangsschlüssel (Token) darf nicht schreiben.");
    throw err("upstream_error", "Upload fehlgeschlagen (" + r.status + ").");
  }
  function eta(left) {
    const free = Math.max(0, 470 - writeLog().length);
    const fast = Math.min(left, free), rest = left - fast;
    const min = Math.ceil(fast * 1.1 / 60) + Math.ceil(rest / 470) * 60;
    return min >= 90 ? `${Math.round(min / 60 * 10) / 10} Std.` : `${Math.max(1, min)} Min.`;
  }
  async function existingPaths() {
    try {
      const r = await fetch(`${API}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/git/trees/HEAD?recursive=1`, { headers: headers(false), cache: "no-store" });
      if (!r.ok) return new Set();
      const j = await r.json(); return new Set((j.tree || []).map((t) => t.path));
    } catch (e) { return new Set(); }
  }
  const assets = {
    upload: async (blob) => {
      if (!navigator.onLine) throw err("offline", "Keine Internetverbindung.");
      const path = "photos/" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7) + ".jpg";
      await putFile(path, new Uint8Array(await blob.arrayBuffer()), "Foto hinzugefügt");
      try { const c = await caches.open(PHOTO_CACHE); await c.put(cacheKey(path), new Response(blob, { headers: { "Content-Type": "image/jpeg" } })); } catch (e) {}
      urls[path] = URL.createObjectURL(blob);
      try { missing.delete(path); if (window.RB && window.RB.tree) window.RB.tree.add(path); } catch (e) {}
      return { id: path, url: urls[path] };
    },
  };

  async function photoBlob(path) {
    if (!path) return null;
    try { const c = await caches.open(PHOTO_CACHE); const hit = await c.match(cacheKey(path)); if (hit) return await hit.blob(); } catch (e) {}
    if (!cfg) return null;
    const r = await gh(path, { raw: true }); if (r.ok) return await r.blob();
    if (String(path).startsWith("photos/anl-")) { const wf = await wfMap(); if (wf && wf[path]) return new Blob([bytesFromB64(wf[path])], { type: "image/jpeg" }); }
    return null;
  }
  const bulkDelete = (ids, message) => writeAll((m) => { for (const id of ids) delete m[id]; }, message || ("Rezepte gelöscht: " + ids.length));
  const bulkSet = (objs, message) => writeAll((m) => { for (const id in objs) m[id] = objs[id]; }, message || "Rezepte importiert");
  /* ---------- weitere JSON-Dateien (z. B. Übersetzungen i18n/fr.json) ---------- */
  const FILE_CACHE = "rb-files-v1", fileKey = (p) => "https://rezeptbuch.local/file/" + p;
  async function readJSONRemote(path) {
    const r = await gh(path);
    if (r.status === 404) return { data: null, sha: null };
    if (!r.ok) throw err("unavailable", "GitHub antwortet nicht (" + r.status + ").");
    const j = await r.json(); let text;
    if (j.content && j.encoding === "base64") text = dec.decode(bytesFromB64(j.content));
    else { const rr = await gh(path, { raw: true }); text = await rr.text(); }
    return { data: JSON.parse(text || "null"), sha: j.sha };
  }
  function cacheFile(path, res) { caches.open(FILE_CACHE).then((c) => c.put(fileKey(path), new Response(JSON.stringify(res), { headers: { "Content-Type": "application/json" } }))).catch(() => {}); }
  async function readJSON(path, onUpdate) {
    let cached = null;
    try { const c = await caches.open(FILE_CACHE); const hit = await c.match(fileKey(path)); if (hit) cached = await hit.json(); } catch (e) {}
    if (!cfg) return cached ? cached.data : null;
    const remote = readJSONRemote(path).then((res) => { cacheFile(path, res); if (cached && res.sha !== cached.sha && onUpdate) onUpdate(res.data); return res.data; });
    if (cached) { remote.catch(() => {}); return cached.data; }
    return remote;
  }
  async function writeJSON(path, mutate, message) {
    if (!cfg) throw err("unavailable", "Nicht verbunden.");
    for (let attempt = 0; attempt < 3; attempt++) {
      const cur = await readJSONRemote(path);
      const next = cur.data || {};
      mutate(next);
      const body = { message, content: b64FromBytes(enc.encode(JSON.stringify(next))) };
      if (cur.sha) body.sha = cur.sha;
      const r = await ghWrite(path, body);
      if (r.ok) { const j = await r.json(); cacheFile(path, { data: next, sha: j.content && j.content.sha }); return next; }
      if (r.status === 401 || r.status === 403) throw err("auth", "Der Zugangsschlüssel (Token) darf nicht schreiben oder ist abgelaufen.");
      if (r.status !== 409 && r.status !== 422) throw err("unavailable", "Speichern fehlgeschlagen (" + r.status + ").");
    }
    throw err("resource_exhausted", "Gleichzeitig auf einem anderen Gerät geändert. Bitte nochmals speichern.");
  }
  window.RB = { readJSON, writeJSON, photoURL, peekURL: (p) => (p && (String(p).startsWith("data:") || String(p).startsWith("blob:")) ? p : urls[p] || ""), photoBlob, bulkSet, bulkDelete, sync, get configured() { return !!cfg; }, get recipes() { return map; } };
  window.RB.download = download;
  window.RB.loadMaterialPhotos = loadMaterialPhotos;
  window.RB.existingPaths = () => existingPaths();
  window.RB.missing = missing;
  // Einmal beim Start: welche Fotos liegen wirklich im Repo? (für die Sortierung «ohne Foto zuhinterst»)
  setTimeout(async () => { try { if (!cfg) return; const have = await existingPaths(); if (have.size) { window.RB.tree = have; notify(); } } catch (e) {} }, 1500);
  window.RB.saveSettings = (o) => writeAll((mm) => { mm._settings = { ...(mm._settings || {}), type: "settings", ...o }; }, "Einstellungen", true);
  function regionOptions() { const W = window.SEASON_WORLD; if (!W) return '<option value="ch">Schweiz</option>'; const cur = (() => { try { return localStorage.getItem("rb-region") || "ch"; } catch (e) { return "ch"; } })(); const groups = {}; for (const r of W.regions) (groups[r[4]] = groups[r[4]] || []).push(r); return Object.entries(groups).map(([g, rs]) => `<optgroup label="${g}">${rs.map((r) => `<option value="${r[0]}" ${r[0] === cur ? "selected" : ""}>${r[1]}</option>`).join("")}</optgroup>`).join(""); }
  window.RB.putPhoto = (path, b64) => putFile(path, bytesFromB64(b64), "Foto: " + path.split("/").pop());
  window.RB.waitInfo = () => waitInfo;
  window.claude = { use: async (n) => (cfg ? ({ db, assets, user: { can: async () => true } })[n] || null : null) };

  /* ---------- Status, Einstellungen, Startpaket ---------- */
  let statusEl = null;
  function setStatus(t) { if (statusEl) { statusEl.textContent = t; statusEl.hidden = !t; } }

  function download(name, text) {
    const a = document.createElement("a"); a.href = URL.createObjectURL(text instanceof Blob ? text : new Blob([text], { type: "application/json" })); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }

  function settingsHTML(first) {
    const c = cfg || { owner: "", repo: "rezepte", token: "" };
    return `<div class="vbar"><div class="wrap">${first ? "" : '<button class="btn" type="button" id="setClose">← Zurück</button>'}<span class="sp"></span></div></div>
    <div class="wrap"><form class="ed" id="setForm" style="max-width:640px">
      <h2 style="font-size:1.6rem">${first ? "Willkommen! Einmal verbinden" : "Einstellungen"}</h2>
      <p class="ro" style="margin:0">Deine Rezepte liegen in deinem privaten GitHub-Repository. Diese Angaben bleiben nur auf diesem Gerät gespeichert.</p>
      <label>GitHub-Benutzername<input id="s-owner" autocomplete="username" autocapitalize="off" spellcheck="false" required value="${esc(c.owner)}"></label>
      <label>Name des privaten Repositorys<input id="s-repo" autocapitalize="off" spellcheck="false" required value="${esc(c.repo)}"></label>
      <label>Zugangsschlüssel (Token) <small>beginnt mit «github_pat_»</small><input id="s-token" type="password" autocomplete="off" required value="${esc(c.token)}"></label>
      ${first ? `<label>Dein Name <small>erscheint oben im Titel, z. B. «Leas Rezeptbuch». Leer lassen = «Mein Rezeptbuch»</small><input id="s-myname" autocomplete="given-name" value="${esc(localStorage.getItem("rb-owner") || "")}"></label>` : ""}
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><button class="btn primary" type="submit">Verbinden</button><span class="ro" id="s-msg"></span></div>
      ${first ? "" : `
      <hr style="border:0;border-top:1px solid var(--line);width:100%">
      <h3 style="font-size:1.15rem">Name im Titel</h3>
      <p class="ro" style="margin:0">Erscheint oben als «…s Rezeptbuch», z. B. «Leas Rezeptbuch». Gilt auf allen Geräten.</p>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><input id="s-name" style="max-width:260px" value="${esc((map._settings && map._settings.owner) || (localStorage.getItem("rb-owner") || ""))}" placeholder="z. B. Lea"><button class="btn" type="button" id="s-nameSave">Name speichern</button><span class="ro" id="s-namemsg"></span></div>
      <hr style="border:0;border-top:1px solid var(--line);width:100%">
      <h3 style="font-size:1.15rem">Land für die Saisontabelle</h3>
      <p class="ro" style="margin:0">Bestimmt, was in der Saisontabelle und bei «in Saison» angezeigt wird. Gilt auf allen Geräten.</p>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><select id="s-region" style="max-width:340px">${regionOptions()}</select><span class="ro" id="s-regmsg"></span></div>
      <hr style="border:0;border-top:1px solid var(--line);width:100%">
      <h3 style="font-size:1.15rem">Startpaket hochladen</h3>
      <p class="ro" style="margin:0">Lädt Rezepte mit Fotos aus einer «Startpaket-…json»-Datei in dein Repository. Wissen-Dateien (z. B. «wissen-garmethoden.json») und Übersetzungen («uebersetzung-fr.json», «uebersetzung-en.json») gehen hier auch. Du kannst mehrere Dateien auf einmal wählen. Bestehende Rezepte bleiben erhalten. GitHub erlaubt etwa 470 Fotos pro Stunde, grosse Pakete brauchen deshalb Geduld.</p>
      <label class="btn" style="flex-direction:row;align-self:flex-start">Startpaket wählen<input id="s-pack" type="file" accept=".json,application/json" multiple hidden></label>
      <span class="ro" id="s-packmsg"></span>
      <hr style="border:0;border-top:1px solid var(--line);width:100%">
      <h3 style="font-size:1.15rem">Mela</h3>
      <p class="ro" style="margin:0">Rezepte aus der App Mela übernehmen (.melarecipes oder .melarecipe) oder alle Rezepte als Mela-Datei speichern. Rezepte mit gleichem Titel werden nicht doppelt importiert.</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap"><label class="btn" style="flex-direction:row">Mela-Datei importieren<input id="s-mela" type="file" accept=".melarecipes,.melarecipe,.zip,application/zip,application/json" hidden></label>
      <button class="btn" type="button" id="s-melaout">Als Mela-Datei exportieren</button></div>
      <span class="ro" id="s-melamsg"></span>
      <hr style="border:0;border-top:1px solid var(--line);width:100%">
      <h3 style="font-size:1.15rem">Sicherung</h3>
      <p class="ro" style="margin:0">Alle Rezepte (ohne Fotos) als Datei speichern. Die Fotos liegen sicher im Ordner «photos» deines Repositorys.</p>
      <button class="btn" type="button" id="s-backup" style="align-self:flex-start">Rezepte als Datei sichern</button>
      <hr style="border:0;border-top:1px solid var(--line);width:100%">
      <button class="btn danger" type="button" id="s-logout" style="align-self:flex-start">Dieses Gerät abmelden</button>`}
    </form></div>`;
  }
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function openSettings(first) {
    const v = document.getElementById("view");
    v.hidden = false; document.body.style.overflow = "hidden"; v.innerHTML = settingsHTML(first); v.scrollTop = 0;
    const close = document.getElementById("setClose");
    if (close) close.onclick = () => { v.hidden = true; document.body.style.overflow = ""; };
    document.getElementById("setForm").onsubmit = async (e) => {
      e.preventDefault();
      const msg = document.getElementById("s-msg");
      const next = { owner: document.getElementById("s-owner").value.trim(), repo: document.getElementById("s-repo").value.trim(), token: document.getElementById("s-token").value.trim() };
      msg.textContent = "Verbindung wird geprüft …";
      try {
        const r = await fetch(`${API}/repos/${encodeURIComponent(next.owner)}/${encodeURIComponent(next.repo)}`, { headers: { Authorization: "Bearer " + next.token, Accept: "application/vnd.github+json" }, cache: "no-store" });
        if (r.status === 401) { msg.textContent = "Der Token ist ungültig. Bitte nochmals kopieren."; return; }
        if (r.status === 404) { msg.textContent = "Repository nicht gefunden. Stimmen Benutzername und Name? Hat der Token Zugriff darauf?"; return; }
        if (!r.ok) { msg.textContent = "GitHub antwortet nicht (" + r.status + "). Bitte später nochmals."; return; }
        const j = await r.json();
        if (j.permissions && !j.permissions.push) { msg.textContent = "Der Token darf nur lesen. Gib ihm bei «Contents» Lese- und Schreibrechte."; return; }
        localStorage.setItem(CFG_KEY, JSON.stringify(next));
        const myn = document.getElementById("s-myname"); const nm = myn ? myn.value.trim() : "";
        if (nm) { msg.textContent = "Verbunden. Name wird gespeichert …"; try { localStorage.setItem("rb-owner", nm); cfg = next; await writeAll((mm) => { mm._settings = { ...(mm._settings || {}), type: "settings", owner: nm }; }, "Name im Titel: " + nm); } catch (x) {} }
        msg.textContent = "Verbunden. Lädt neu …";
        setTimeout(() => location.reload(), 400);
      } catch (x) { msg.textContent = "Keine Verbindung zu GitHub. Bist du online?"; }
    };
    const ns = document.getElementById("s-nameSave");
    if (ns) ns.onclick = async () => { const v = document.getElementById("s-name").value.trim(); const nm = document.getElementById("s-namemsg"); if (!v) { nm.textContent = "Bitte einen Namen eingeben."; return; }
      ns.disabled = true; nm.textContent = "Wird gespeichert …";
      try { await writeAll((mm) => { mm._settings = { ...(mm._settings || {}), type: "settings", owner: v }; }, "Name im Titel: " + v); try { localStorage.setItem("rb-owner", v); } catch (e) {} nm.textContent = "Gespeichert. Lädt neu …"; setTimeout(() => location.reload(), 700); }
      catch (x) { nm.textContent = (x && x.message) || "Speichern fehlgeschlagen."; ns.disabled = false; } };
    const sr = document.getElementById("s-region");
    if (sr) sr.onchange = () => { try { localStorage.setItem("rb-region", sr.value); } catch (e) {} window.RB.saveSettings({ region: sr.value }).catch(() => {}); window.dispatchEvent(new Event("rb-region")); document.getElementById("s-regmsg").textContent = "Gespeichert."; };
    const pack = document.getElementById("s-pack");
    if (pack) pack.onchange = async () => {
      const files = [...pack.files]; if (!files.length) return; const m0 = document.getElementById("s-packmsg");
      // Übersetzungen und Wissen zuletzt, Rezepte zuerst
      files.sort((a, b) => (/uebersetzung|wissen/i.test(a.name) ? 1 : 0) - (/uebersetzung|wissen/i.test(b.name) ? 1 : 0));
      let reload = false, k = 0;
      for (const f of files) { k++;
        const m = { set textContent(t) { m0.textContent = (files.length > 1 ? `Datei ${k} von ${files.length} («${f.name}»): ` : "") + t; } };
        const r = await importPack(f, m); if (r === "reload") reload = true; if (r === "error") { pack.value = ""; return; } }
      pack.value = "";
      if (reload || files.length > 1) { m0.textContent = `Fertig: ${files.length} Dateien importiert. Lädt neu …`; setTimeout(() => location.reload(), 1200); }
    };
    const mi = document.getElementById("s-mela");
    if (mi) mi.onchange = async () => { const f = mi.files[0]; if (!f) return; const m = document.getElementById("s-melamsg"); try { await window.RBMela.importFile(f, m); } catch (x) { m.textContent = (x && x.message) || "Import fehlgeschlagen."; } mi.value = ""; };
    const mo = document.getElementById("s-melaout");
    if (mo) mo.onclick = async () => { const m = document.getElementById("s-melamsg"); mo.disabled = true; try { await window.RBMela.exportAll(m); } catch (x) { m.textContent = (x && x.message) || "Export fehlgeschlagen."; } mo.disabled = false; };
    const bk = document.getElementById("s-backup");
    if (bk) bk.onclick = () => download((localStorage.getItem("rb-owner")||"Mein")+"-Rezeptbuch-Sicherung-" + new Date().toISOString().slice(0, 10) + ".json", JSON.stringify({ format: "rezeptbuch", version: 1, recipes: map }, null, 1));
    const lo = document.getElementById("s-logout");
    if (lo) lo.onclick = () => { localStorage.removeItem(CFG_KEY); localStorage.removeItem(CACHE_KEY); location.reload(); };
  }

  function saveTicker(m, label) {
    const t0 = Date.now();
    const show = () => {
      const s = Math.round((Date.now() - t0) / 1000), el = s < 60 ? s + " Sek." : Math.floor(s / 60) + " Min. " + (s % 60) + " Sek.";
      let x = "";
      if (waitInfo && waitInfo.until > Date.now()) x = ` GitHub-Pause (zu viele Speicherungen kurz hintereinander), weiter in ca. ${Math.max(1, Math.ceil((waitInfo.until - Date.now()) / 60000))} Min.`;
      else if (upInfo && upInfo.total) x = upInfo.loaded >= upInfo.total ? " Hochgeladen, GitHub verarbeitet die Datei …" : ` ${(upInfo.loaded / 1048576).toFixed(1)} von ${(upInfo.total / 1048576).toFixed(1)} MB hochgeladen.`;
      else x = " Lade aktuellen Stand …";
      m.textContent = `${label} (${el})${x} Fenster offen lassen.`;
    };
    show(); const id = setInterval(show, 1000); return () => clearInterval(id);
  }
  async function importPack(f, m) {
    try {
      m.textContent = "Datei wird gelesen …";
      const j = JSON.parse(await f.text());
      if (j.format === "rezeptbuch-uebersetzung" && j.lang && j.items) {
        m.textContent = "Übersetzung wird gespeichert … (grosse Datei, bitte warten)";
        let n = 0;
        await writeJSON("i18n/" + j.lang + ".json", (mm) => { for (const id in j.items) { if (mm[id] && mm[id].edited) continue; mm[id] = { ...(mm[id] || {}), ...j.items[id] }; n++; } }, "Übersetzung " + j.lang.toUpperCase() + " importiert");
        m.textContent = `Fertig: ${n} Rezepte auf ${j.lang === "fr" ? "Französisch" : "Englisch"} gespeichert.`;
        return "reload";
      }
      if (j.format === "rezeptbuch-patch" && j.patch) {
        let n = 0; const stop = saveTicker(m, "Ergänzungen werden gespeichert");
        try { await writeAll((mm) => { for (const id in j.patch) { if (mm[id]) { Object.assign(mm[id], j.patch[id]); n++; } } }, "Ergänzungen: " + (j.title || "Patch")); } finally { stop(); }
        m.textContent = `Fertig: ${n} Rezepte ergänzt.`;
        return "reload";
      }
      if (j.format === "rezeptbuch-material" && Array.isArray(j.entries)) {
        let n = 0; let stop = saveTicker(m, "Material wird gespeichert");
        try { await writeAll((mm) => { for (const x of j.entries) { if (!x || !x.id) continue; const old = mm[x.id] || {}; mm[x.id] = { ...x, type: "material", fav: old.fav, mynote: old.mynote, updatedAt: Date.now() }; n++; } }, "Material importiert: " + j.entries.length); } finally { stop(); }
        if (j.photos && Object.keys(j.photos).length) {
          stop = saveTicker(m, `${n} Gegenstände gespeichert. Fotos werden gespeichert (eine Datei)`);
          try { await writeJSON("material-fotos.json", (mm) => { Object.assign(mm, j.photos); }, "Material: Fotos (" + Object.keys(j.photos).length + ")"); } finally { stop(); }
          mfP = null;
        }
        m.textContent = `Fertig: ${n} Gegenstände gespeichert.`;
        return "reload";
      }
      if (j.format === "rezeptbuch-wissen" || (Array.isArray(j.entries) && !j.recipes)) {
        let n = 0; const stopW = saveTicker(m, "Wissen wird gespeichert");
        try { await writeAll((mm) => { for (const x of j.entries || []) { if (!x || !x.id || !x.title) continue; const old = mm[x.id]; mm[x.id] = { ...x, type: "wissen", links: old && old.links ? old.links : (x.links || []), updatedAt: Date.now() }; n++; } }, "Wissen importiert: " + (j.entries || []).length); } finally { stopW(); }
        if (j.photos) {
          m.textContent = `${n} Wissen-Einträge gespeichert. Fotos werden gespeichert (eine Datei, bitte warten) …`;
          await writeJSON("wissen-fotos.json", (mm) => { Object.assign(mm, j.photos); }, "Wissen: Fotos (" + Object.keys(j.photos).length + ")");
          wfP = null;
        }
        m.textContent = `Fertig: ${n} Wissen-Einträge gespeichert.`;
        return "reload";
      }
      if (!j.recipes || !j.photos) throw 0;
      let added = 0;
      let stop = saveTicker(m, "Rezepte werden gespeichert");
      try { await writeAll((mm) => { const KEEP = ["favorite", "cooked", "cookedAt", "comment", "comments", "photo", "links"]; for (const id in j.recipes) { if (!mm[id]) { mm[id] = j.recipes[id]; added++; } else if (j.update) { const keep = {}; for (const k of KEEP) if (mm[id][k] !== undefined) keep[k] = mm[id][k]; mm[id] = { ...j.recipes[id], ...keep }; added++; } } }, "Startpaket: Rezepte"); } finally { stop(); }
      if (j.i18n) for (const L of Object.keys(j.i18n)) {
        stop = saveTicker(m, "Übersetzungen (" + L.toUpperCase() + ") werden gespeichert");
        try { await writeJSON("i18n/" + L + ".json", (mm) => { for (const id in j.i18n[L]) { if (mm[id] && mm[id].edited) continue; mm[id] = { ...(mm[id] || {}), ...j.i18n[L][id] }; } }, "Startpaket: Übersetzung " + L.toUpperCase()); } finally { stop(); }
      }
      m.textContent = "Prüfe, welche Fotos schon hochgeladen sind …";
      const have = await existingPaths();
      const todo = Object.keys(j.photos).filter((p) => !have.has(p));
      let i = 0; const t0 = Date.now();
      const tick = setInterval(() => {
        const left = todo.length - i;
        const w = waitInfo && waitInfo.until > Date.now() ? ` GitHub-Pause, weiter in ${Math.ceil((waitInfo.until - Date.now()) / 60000)} Min.` : "";
        m.textContent = `${added} Rezepte gespeichert. Fotos: ${i} von ${todo.length} hochgeladen (noch ca. ${eta(left)}).${w} Fenster offen lassen. Du kannst jederzeit abbrechen und später dieselbe Datei nochmals wählen, es geht dort weiter.`;
      }, 1000);
      try { for (const p of todo) { await putFile(p, bytesFromB64(j.photos[p]), "Startpaket: Foto"); i++; } }
      finally { clearInterval(tick); }
      m.textContent = `Fertig: ${added} neue Rezepte, ${todo.length} Fotos hochgeladen` + (Object.keys(j.photos).length > todo.length ? `, ${Object.keys(j.photos).length - todo.length} Fotos waren schon da.` : ".");
      Object.keys(urls).length; notify();
      return "ok";
    } catch (x) { m.textContent = x && x.message ? x.message + " Wähle dieselbe Datei nochmals, um fortzufahren." : "Das ist keine gültige Startpaket-Datei."; return "error"; }
  }
  window.RB.importFiles = async (files, m0) => {
    files = [...files].sort((a, b) => (/uebersetzung|wissen/i.test(a.name) ? 1 : 0) - (/uebersetzung|wissen/i.test(b.name) ? 1 : 0));
    let k = 0;
    for (const f of files) { k++;
      const m = { set textContent(t) { m0.textContent = (files.length > 1 ? `Datei ${k} von ${files.length} («${f.name}»): ` : "") + t; } };
      const r = await importPack(f, m); if (r === "error") return; }
    m0.textContent = `Fertig: ${files.length} ${files.length > 1 ? "Dateien" : "Datei"} importiert. Lädt neu …`; setTimeout(() => location.reload(), 1200);
  };

  document.addEventListener("DOMContentLoaded", () => {
    const w = document.querySelector(".top .wrap");
    const b = document.createElement("button"); b.className = "btn"; b.type = "button"; b.textContent = "⚙︎"; b.title = "Einstellungen"; b.setAttribute("aria-label", "Einstellungen");
    b.onclick = () => openSettings(false); w.appendChild(b);
    statusEl = document.createElement("div"); statusEl.className = "ro"; statusEl.hidden = true;
    statusEl.style.cssText = "background:var(--plum-soft);color:var(--plum);padding:6px 16px;text-align:center";
    document.querySelector("header.top").appendChild(statusEl);
    if (!cfg) openSettings(true);
  });

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    // Nur neu laden, wenn eine ALTE Version die Seite steuerte und eine neue übernimmt – und höchstens einmal pro Sitzung (Safari-Schleife verhindern)
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then((reg) => { reg.update().catch(() => {}); }).catch(() => {});
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      let done = false; try { done = sessionStorage.getItem("rb-swreload") === "1"; } catch (e) { done = true; }
      if (!hadController || done || document.querySelector(".ed")) return;
      try { sessionStorage.setItem("rb-swreload", "1"); } catch (e) {}
      location.reload();
    });
  }
})();
