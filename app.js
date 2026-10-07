'use strict';
/* Indusoft ASANA — app móvil (PWA). Sin dependencias ni servidor propio:
   habla directamente con la API de Asana usando tu Personal Access Token. */

const BASE = 'https://app.asana.com/api/1.0';
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const OPT = 'gid,name,completed,completed_at,notes,start_at,due_at,start_on,due_on,permalink_url,parent,parent.name';

/* ------------------------------------------------------------ utilidades */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const key = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const isoAsana = d => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const longDate = d => cap(d.toLocaleDateString('es-PE', { weekday: 'long', day: 'numeric', month: 'long' }));

function fmtH(h) {
  const t = Math.round((h || 0) * 60), hh = Math.floor(t / 60), mm = t % 60;
  if (hh && mm) return `${hh} h ${mm} min`;
  return hh ? `${hh} h` : `${mm} min`;
}
function toast(msg, err) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'on' + (err ? ' err' : '');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.className = '', err ? 4200 : 2200);
}
function descargar(nombre, texto) {
  const blob = new Blob([texto], { type: 'text/markdown;charset=utf-8' });
  const file = new File([blob], nombre, { type: 'text/markdown' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file], title: nombre }).catch(() => {});
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = nombre; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/* ------------------------------------------------- token cifrado (WebCrypto) */
const Vault = {
  db() {
    return new Promise((ok, no) => {
      const r = indexedDB.open('indusoft-asana', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('k');
      r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
    });
  },
  async llave() {
    const db = await this.db();
    const get = () => new Promise(ok => { const q = db.transaction('k').objectStore('k').get('main'); q.onsuccess = () => ok(q.result); });
    let k = await get();
    if (!k) {
      k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await new Promise(ok => { const t = db.transaction('k', 'readwrite'); t.objectStore('k').put(k, 'main'); t.oncomplete = ok; });
    }
    return k;
  },
  async guardar(token) {
    try {
      if (!(window.crypto && crypto.subtle && window.indexedDB)) throw 0;
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await this.llave(), new TextEncoder().encode(token)));
      const all = new Uint8Array(12 + ct.length); all.set(iv); all.set(ct, 12);
      localStorage.setItem('ia_tok', 'e:' + btoa(String.fromCharCode(...all)));
    } catch { localStorage.setItem('ia_tok', 'p:' + btoa(token)); }   // sin cifrado disponible (http)
  },
  async leer() {
    const v = localStorage.getItem('ia_tok'); if (!v) return null;
    try {
      if (v.startsWith('p:')) return atob(v.slice(2));
      const b = Uint8Array.from(atob(v.slice(2)), c => c.charCodeAt(0));
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12) }, await this.llave(), b.slice(12));
      return new TextDecoder().decode(pt);
    } catch { return null; }
  },
  borrar() { localStorage.removeItem('ia_tok'); }
};

const Cfg = {
  get() { try { return JSON.parse(localStorage.getItem('ia_cfg')) || {}; } catch { return {}; } },
  set(o) { localStorage.setItem('ia_cfg', JSON.stringify({ ...this.get(), ...o })); }
};

/* ------------------------------------------------------------- API Asana */
const S = {
  token: null, user: null, ws: null, projects: [], tab: 'hoy', view: 'main',
  dia: new Date(), semana: new Date(), rows: [], pend: [], loading: false,
  parents: {}, tasksCache: {}, error: ''
};

async function api(method, path, { params, data } = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  const init = { method, headers: { Authorization: 'Bearer ' + S.token, Accept: 'application/json' } };
  if (data) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify({ data }); }
  for (let i = 0; ; i++) {
    let r;
    try { r = await fetch(url, init); } catch { throw new Error('Sin conexión con Asana'); }
    if (r.status === 429 && i < 3) { await sleep(Math.min(Math.max(+r.headers.get('Retry-After') || 2, 1), 20) * 1000); continue; }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${j.errors?.[0]?.message || r.statusText}`);
    return j;
  }
}
async function getAll(path, params) {
  const out = []; const p = { ...params, limit: 100 };
  for (;;) {
    const j = await api('GET', path, { params: p });
    out.push(...(j.data || []));
    const off = j.next_page?.offset; if (!off) break; p.offset = off;
  }
  return out;
}

/* --------------------------------------------- consulta de lo trabajado */
function fechaTrabajo(t) {
  for (const [at, on] of [['start_at', 'start_on'], ['due_at', 'due_on']]) {
    if (t[at]) return { d: new Date(t[at]), hora: true };
    if (t[on]) return { d: parseYmd(t[on]), hora: false };
  }
  return t.completed_at ? { d: new Date(t.completed_at), hora: true } : null;
}
const horasPlan = t => (t.start_at && t.due_at && new Date(t.due_at) > new Date(t.start_at))
  ? (new Date(t.due_at) - new Date(t.start_at)) / 36e5 : null;

async function buscarCompletadas(desde) {
  const lim = new Date(Date.now() + 864e5);
  try {
    const vistos = new Map(); let from = desde;
    for (;;) {
      const j = await api('GET', `/workspaces/${S.ws}/tasks/search`, { params: {
        'assignee.any': 'me', is_subtask: true, completed: true,
        'completed_at.after': isoAsana(from), 'completed_at.before': isoAsana(lim),
        sort_by: 'completed_at', sort_ascending: true, limit: 100, opt_fields: OPT } });
      const pag = j.data || []; let nuevos = 0;
      for (const t of pag) if (!vistos.has(t.gid)) { vistos.set(t.gid, t); nuevos++; }
      if (pag.length < 100 || !nuevos || !pag[pag.length - 1].completed_at) break;
      from = new Date(new Date(pag[pag.length - 1].completed_at) - 1000);
    }
    return [...vistos.values()];
  } catch (e) {
    if (!/^HTTP 4/.test(e.message)) throw e;      // plan sin búsqueda: método alterno
    return getAll('/tasks', { assignee: 'me', workspace: S.ws, completed_since: isoAsana(desde), opt_fields: OPT });
  }
}
async function completarPadres(lista) {
  const falta = [...new Set(lista.map(t => t.parent?.gid).filter(g => g && !S.parents[g]))];
  for (let i = 0; i < falta.length; i += 5) {
    await Promise.all(falta.slice(i, i + 5).map(async g => {
      try {
        const d = (await api('GET', `/tasks/${g}`, { params: { opt_fields: 'name,projects.name' } })).data || {};
        S.parents[g] = { tarea: d.name || '', proyecto: (d.projects || []).map(p => p.name).join(', ') };
      } catch { S.parents[g] = { tarea: '', proyecto: '' }; }
    }));
  }
}
async function filasDe(lista, desde, hasta) {
  const ok = [];
  for (const t of lista) {
    if (!t.parent) continue;
    const w = fechaTrabajo(t); if (!w) continue;
    const dia = ymd(w.d); if (dia < ymd(desde) || dia > ymd(hasta)) continue;
    ok.push({ t, w, dia });
  }
  await completarPadres(ok.map(o => o.t));
  return ok.map(({ t, w, dia }) => {
    const p = S.parents[t.parent.gid] || {};
    return {
      gid: t.gid, fecha: dia, hora: hm(w.hora ? w.d : new Date(t.completed_at || w.d)),
      ini_hm: t.start_at ? hm(new Date(t.start_at)) : '', fin_hm: t.due_at ? hm(new Date(t.due_at)) : '',
      proyecto: p.proyecto || '(sin proyecto)', tarea: p.tarea || t.parent.name || '',
      subtarea: t.name || '', horas: horasPlan(t), hecho: !!t.completed, url: t.permalink_url || ''
    };
  }).sort((a, b) => (a.fecha + a.hora).localeCompare(b.fecha + b.hora));
}
async function cargarHoy() {
  const d0 = new Date(S.dia.getFullYear(), S.dia.getMonth(), S.dia.getDate());
  const [hechas, pend] = await Promise.all([
    buscarCompletadas(d0),
    getAll('/tasks', { assignee: 'me', workspace: S.ws, completed_since: 'now', opt_fields: OPT })
  ]);
  S.rows = await filasDe(hechas.filter(t => t.completed), d0, d0);
  const dia = ymd(d0);
  const pp = pend.filter(t => !t.completed && t.parent && fechaTrabajo(t) && ymd(fechaTrabajo(t).d) === dia);
  S.pend = await filasDe(pp, d0, d0);
}
const lunes = d => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
async function cargarSemana() {
  const l = lunes(S.semana), dom = addDays(l, 6);
  const hechas = await buscarCompletadas(l);
  S.rows = await filasDe(hechas.filter(t => t.completed), l, dom);
}

/* ---------------------------------------------------------- proyectos/tareas */
async function cargarProyectos() {
  S.projects = (await getAll('/projects', { workspace: S.ws, archived: false, opt_fields: 'gid,name' }))
    .sort((a, b) => key(a.name).localeCompare(key(b.name)));
}
async function tareasDe(gp) {
  if (!S.tasksCache[gp]) {
    S.tasksCache[gp] = (await getAll(`/projects/${gp}/tasks`, { completed_since: '1970-01-01T00:00:00Z', opt_fields: 'gid,name' }))
      .sort((a, b) => key(a.name).localeCompare(key(b.name)));
  }
  return S.tasksCache[gp];
}

/* --------------------------------------------------------------- Obsidian */
const RE_LINEA = /^\s*[-*]\s*\[([ xX])\]\s*(\d{1,2}):(\d{2})\s*[-–—]\s*(\d{1,2}):(\d{2})\s*\|\s*([^|>]+?)\s*>\s*([^|]+?)\s*\|\s*([^|]*?)\s*(?:<!--\s*asana:(\d+)\s*-->)?\s*$/;
const RE_PARECE = /^\s*[-*]\s*\[[ xX]\].*\|/;
const RE_FECHA = /(\d{4})-(\d{2})-(\d{2})/;

function parsearNota(texto, diaDefecto) {
  let dia = diaDefecto; const out = [];
  texto.split('\n').forEach((raw, idx) => {
    const linea = raw.replace(/\r$/, '');
    const h = linea.match(/^(?:#{1,6}\s.*?|fecha:\s*)(\d{4}-\d{2}-\d{2})/);
    if (h) { dia = h[1]; return; }
    const m = linea.match(RE_LINEA);
    if (!m) { if (RE_PARECE.test(linea)) out.push({ linea: idx, dia, hora: '', proyecto: '', tarea: '', subtarea: linea.trim(), error: 'Formato no reconocido' }); return; }
    const e = { linea: idx, dia, hecho: m[1].toLowerCase() === 'x', proyecto: m[6].trim(), tarea: m[7].trim(), subtarea: m[8].trim(), gid: m[9] || null, error: null };
    const [y, mo, d] = dia.split('-').map(Number);
    const ini = new Date(y, mo - 1, d, +m[2], +m[3]), fin = new Date(y, mo - 1, d, +m[4], +m[5]);
    e.hora = `${pad(m[2])}:${m[3]}-${pad(m[4])}:${m[5]}`;
    if (+m[2] > 23 || +m[4] > 23 || +m[3] > 59 || +m[5] > 59) e.error = 'Hora no válida';
    else if (fin <= ini) e.error = 'El fin debe ser posterior al inicio';
    else if (!e.subtarea) e.error = 'Falta el nombre de la subtarea';
    else e.plan = { start_at: isoAsana(ini), due_at: isoAsana(fin) };
    out.push(e);
  });
  return out;
}
const subEnDia = (s, dia) => s.start_at ? ymd(new Date(s.start_at)) === dia : s.start_on === dia;
const mismoPlan = (s, e) => new Date(s.start_at).getTime() === new Date(e.plan.start_at).getTime()
  && new Date(s.due_at).getTime() === new Date(e.plan.due_at).getTime()
  && key(s.name) === key(e.subtarea) && !!s.completed === e.hecho;

async function resolverEntradas(es) {
  const proy = new Map(); S.projects.forEach(p => { if (!proy.has(key(p.name))) proy.set(key(p.name), p); });
  const tareas = {}, subs = {};
  for (const e of es) {
    e.accion = 'ERROR'; e.detalle = e.error || '';
    if (e.error) continue;
    try {
      const p = proy.get(key(e.proyecto)); if (!p) throw new Error('Proyecto no encontrado: ' + e.proyecto);
      tareas[p.gid] ??= new Map((await tareasDe(p.gid)).map(t => [key(t.name), t]));
      const t = tareas[p.gid].get(key(e.tarea)); if (!t) throw new Error('Tarea no encontrada: ' + e.tarea);
      subs[t.gid] ??= await getAll(`/tasks/${t.gid}/subtasks`, { opt_fields: 'gid,name,completed,start_at,start_on,due_at,due_on' });
      e.gid_tarea = t.gid;
      let ex = e.gid ? subs[t.gid].find(s => s.gid === e.gid) : null; const porGid = !!ex;
      if (!ex) ex = subs[t.gid].find(s => key(s.name) === key(e.subtarea) && subEnDia(s, e.dia));
      if (!ex) { e.gid = null; e.accion = 'CREAR'; e.detalle = 'Se creará'; }
      else {
        e.gid = ex.gid; e.hechaActual = !!ex.completed;
        if (porGid && !mismoPlan(ex, e)) { e.accion = 'ACTUALIZAR'; e.detalle = 'Cambió: se actualizará'; }
        else { e.accion = 'EXISTE'; e.detalle = 'Ya está en Asana'; }
      }
    } catch (x) { e.accion = 'ERROR'; e.detalle = x.message; }
  }
  return es;
}
async function subirEntradas(es) {
  let ok = 0; const errores = [];
  for (const e of es) {
    if (e.accion !== 'CREAR' && e.accion !== 'ACTUALIZAR') continue;
    const datos = { name: e.subtarea, ...e.plan };
    try {
      let r;
      if (e.accion === 'CREAR') r = await api('POST', `/tasks/${e.gid_tarea}/subtasks`, { data: { ...datos, assignee: S.user.gid, completed: e.hecho } });
      else { if (e.hecho !== e.hechaActual) datos.completed = e.hecho; r = await api('PUT', `/tasks/${e.gid}`, { data: datos }); }
      e.gid = r.data?.gid || e.gid; e.subido = true; ok++;
    } catch (x) { e.fallo = true; errores.push(`${e.subtarea}: ${x.message}`); }
  }
  return { ok, errores };
}
function notaConGid(texto, es) {
  const lineas = texto.split('\n');
  for (const e of es) {
    if (!e.gid || e.fallo || !['CREAR', 'ACTUALIZAR', 'EXISTE'].includes(e.accion)) continue;
    const o = lineas[e.linea], cr = o.endsWith('\r') ? '\r' : '';
    lineas[e.linea] = o.replace(/\r$/, '').replace(/\s*<!--\s*asana:\d+\s*-->/, '').trimEnd() + ` <!-- asana:${e.gid} -->` + cr;
  }
  return lineas.join('\n');
}
const limpiarMd = s => String(s ?? '').replace(/\|/g, '¦').replace(/>/g, '›').replace(/\n/g, ' ').trim();
function notaDeFilas(rows) {
  const porDia = {}; rows.forEach(r => (porDia[r.fecha] ??= []).push(r));
  return Object.keys(porDia).sort().map(dia => {
    const l = porDia[dia].sort((a, b) => (a.hora + a.subtarea).localeCompare(b.hora + b.subtarea));
    const tot = l.reduce((s, r) => s + (r.horas || 0), 0), d = parseYmd(dia);
    const con = l.filter(r => r.ini_hm && r.fin_hm), sin = l.filter(r => !(r.ini_hm && r.fin_hm));
    const t = ['---', `fecha: ${dia}`, `horas: ${Math.round(tot * 100) / 100}`, `subtareas: ${l.length}`, 'origen: asana', '---', '',
      `# Trabajo del ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} (${DIAS[d.getDay()]}) ${dia}`, '',
      `**Total planificado:** ${fmtH(tot)} · **Subtareas:** ${l.length}`, ''];
    con.forEach(r => t.push(`- [x] ${r.ini_hm}-${r.fin_hm} | ${limpiarMd(r.proyecto)} > ${limpiarMd(r.tarea)} | ${limpiarMd(r.subtarea)} <!-- asana:${r.gid} -->`));
    if (sin.length) { t.push('', '## Sin horario definido', ''); sin.forEach(r => t.push(`- ${limpiarMd(r.proyecto)} > ${limpiarMd(r.tarea)} | ${limpiarMd(r.subtarea)}${r.url ? ` ([Asana](${r.url}))` : ''}`)); }
    return t.join('\n');
  }).join('\n\n');
}

/* ------------------------------------------------------------------ vistas */
const IC = {
  hoy: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>',
  semana: '<rect x="4" y="5" width="16" height="15" rx="3"/><path d="M4 10h16M9 3v4M15 3v4"/>',
  notas: '<path d="M6 3h9l4 4v14H6z"/><path d="M9 12h7M9 16h5"/>',
  perfil: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>'
};
const tabbar = () => `<nav class="tabs">${[['hoy', 'Hoy'], ['semana', 'Semana'], ['notas', 'Notas'], ['perfil', 'Perfil']].map(([k, l]) =>
  `<button data-tab="${k}" class="${S.tab === k ? 'on' : ''}"><span class="ic"><svg viewBox="0 0 24 24">${IC[k]}</svg></span>${l}</button>`).join('')}</nav>`;

function vLogin() {
  return `<div class="login"><div class="marca"><div class="logo">IS</div><h1>Indusoft ASANA</h1><p>Registra tus horas desde el celular</p></div>
  <form class="form" id="f-login"><h2>Conecta tu cuenta de Asana</h2>
  <p style="margin:0;font-size:14px">Pega tu Personal Access Token para ver tus proyectos y registrar subtareas.</p>
  <input class="inp" id="tok" type="password" autocomplete="off" placeholder="Pega aquí tu token…">
  <label class="ck"><input type="checkbox" id="ck-guardar" checked> Guardar el token cifrado en este dispositivo</label>
  ${window.crypto && crypto.subtle ? '' : '<div class="nota">⚠ Esta página no usa HTTPS: el token no se podrá cifrar. Desmarca «Guardar» o abre la app desde una dirección https.</div>'}
  <div class="err" id="login-err">${esc(S.error)}</div>
  <button class="btn" id="b-login" type="submit">Conectar con Asana</button>
  <a class="link" href="https://app.asana.com/0/my-apps" target="_blank" rel="noopener">¿Cómo obtengo mi token?</a></form></div>`;
}
function vCabeceraDia() {
  const hechas = S.rows.reduce((s, r) => s + (r.horas || 0), 0), meta = Cfg.get().meta || 8;
  const pct = Math.min(100, Math.round(hechas / meta * 100));
  return `<header class="hdr"><div class="nav"><button data-dia="-1" aria-label="Día anterior">‹</button><span>${esc(longDate(S.dia))}</span><button data-dia="1" aria-label="Día siguiente">›</button></div>
  <div class="big"><h1>${ymd(S.dia) === ymd(new Date()) ? 'Hoy' : 'Día'}</h1><div class="tot">${fmtH(hechas)}</div></div>
  <div class="prog"><i style="width:${pct}%"></i></div><small>${S.rows.length} ${S.rows.length === 1 ? 'completada' : 'completadas'} · ${S.pend.length} ${S.pend.length === 1 ? 'pendiente' : 'pendientes'} · meta ${fmtH(meta)}</small></header>`;
}
const fila = (r, pend) => `<a class="fila" ${r.url ? `href="${esc(r.url)}" target="_blank" rel="noopener"` : ''} style="text-decoration:none;color:inherit">
  <span class="t">${esc(r.ini_hm || r.hora)}</span><span class="m"><b>${esc(r.subtarea)}</b><span>${esc(r.proyecto)} · ${esc(r.tarea)}</span></span>
  <span class="r">${r.horas ? fmtH(r.horas) : ''}<i class="dot ${pend ? 'pend' : ''}"></i></span></a>`;
function vHoy() {
  const lista = [...S.rows.map(r => fila(r, false)), ...S.pend.map(r => fila(r, true))];
  return `${vCabeceraDia()}<main class="main">
  <div class="lbl">Subtareas del día</div>
  ${S.loading ? '<div class="vacio">Cargando…</div>' : lista.length ? lista.join('') : '<div class="vacio">No hay subtareas para este día.<br>Toca + para registrar una.</div>'}
  </main><button class="fab" data-act="nueva" aria-label="Nueva subtarea">+</button>${tabbar()}`;
}
function vSemana() {
  const l = lunes(S.semana), dom = addDays(l, 6);
  const por = Array(7).fill(0); S.rows.forEach(r => { const i = Math.round((parseYmd(r.fecha) - l) / 864e5); if (i >= 0 && i < 7) por[i] += r.horas || 0; });
  const tot = por.reduce((a, b) => a + b, 0), max = Math.max(...por, 1);
  const pp = {}; S.rows.forEach(r => pp[r.proyecto] = (pp[r.proyecto] || 0) + (r.horas || 0));
  const proy = Object.entries(pp).sort((a, b) => b[1] - a[1]);
  const rango = `${l.getDate()} ${l.toLocaleDateString('es-PE', { month: 'short' })} – ${dom.getDate()} ${dom.toLocaleDateString('es-PE', { month: 'short' })}`;
  return `<header class="hdr"><div class="nav"><button data-sem="-1" aria-label="Semana anterior">‹</button><span>Semana · ${esc(rango)}</span><button data-sem="1" aria-label="Semana siguiente">›</button></div>
  <div class="big"><h1>Total</h1><div class="tot">${fmtH(tot)}</div></div></header>
  <main class="main">${S.loading ? '<div class="vacio">Cargando…</div>' : `
  <div class="card"><b style="font-size:14px">Horas por día</b><div class="bars">${por.map((h, i) =>
    `<div><i class="${i > 4 ? 'fin' : ''}" style="height:${Math.round(h / max * 110)}px"></i><span>${'LMMJVSD'[i]}</span></div>`).join('')}</div></div>
  <div class="lbl">Por proyecto</div>
  ${proy.length ? proy.map(([n, h]) => `<div class="card proy"><div class="top"><b style="font-weight:500">${esc(n)}</b><span>${fmtH(h)} · ${tot ? Math.round(h / tot * 100) : 0}%</span></div><div class="prog"><i style="width:${tot ? Math.round(h / tot * 100) : 0}%"></i></div></div>`).join('') : '<div class="vacio">Sin horas registradas esta semana.</div>'}
  <div class="dos"><button class="btn sec" data-act="exp-sem">⬇ Exportar a Obsidian</button></div>`}</main>${tabbar()}`;
}
/* Nueva subtarea: estado propio para no perder lo escrito */
let N = null;
const nuevoForm = () => { const c = Cfg.get(), a = new Date(); a.setMinutes(Math.ceil(a.getMinutes() / 5) * 5, 0, 0);
  const b = new Date(a.getTime() + 36e5); return { p: null, t: null, nombre: '', fecha: ymd(S.dia), ini: hm(a), fin: hm(b), hecho: true, notas: '', recientes: c.recientes || [] }; };
function durMin() { const [a, b] = [N.ini, N.fin].map(s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; }); return b - a; }
function vNueva() {
  const d = durMin();
  return `<header class="hdr row"><button class="back" data-act="atras" aria-label="Volver">‹</button><h2>Nueva subtarea</h2></header>
  <main class="main">
  ${N.recientes.length ? `<div class="campo"><span class="l">Recientes</span><div class="chips">${N.recientes.map((r, i) => `<button class="chip" data-rec="${i}">${esc(r.pn)} › ${esc(r.tn)}</button>`).join('')}</div></div>` : ''}
  <div class="campo"><span class="l">Proyecto</span><button class="inp ${N.p ? '' : 'ph'}" data-act="pick-p">${esc(N.p ? N.p.name : 'Elegir proyecto')}<span>⌄</span></button></div>
  <div class="campo"><span class="l">Tarea</span><button class="inp ${N.t ? '' : 'ph'}" data-act="pick-t">${esc(N.t ? N.t.name : 'Elegir tarea')}<span>⌄</span></button></div>
  <div class="campo"><label for="n-nombre">Subtarea</label><input class="inp" id="n-nombre" value="${esc(N.nombre)}" placeholder="¿Qué hiciste?"></div>
  <div class="campo"><label for="n-fecha">Fecha</label><input class="inp" id="n-fecha" type="date" value="${N.fecha}"></div>
  <div class="campo"><span class="l">Horario</span><div class="horas">
    <label class="tb"><small>Inicio</small><input id="n-ini" type="time" step="300" value="${N.ini}"></label><span>→</span>
    <label class="tb"><small>Fin</small><input id="n-fin" type="time" step="300" value="${N.fin}"></label></div>
    <div class="chips"><button class="chip" data-add="30">+30 min</button><button class="chip" data-add="60">+1 h</button><button class="chip" data-act="ahora">Ahora</button>
    <span class="dur" id="n-dur">${d > 0 ? 'Duración: ' + fmtH(d / 60) : 'El fin debe ser posterior'}</span></div></div>
  <div class="campo"><span class="l">Estado</span><div class="seg"><button data-est="1" class="${N.hecho ? 'on' : ''}">Completada</button><button data-est="0" class="${N.hecho ? '' : 'on'}">Pendiente</button></div></div>
  <div class="campo"><label for="n-notas">Notas (opcional)</label><textarea class="inp" id="n-notas" placeholder="Detalles de lo realizado…">${esc(N.notas)}</textarea></div>
  </main><div class="pie"><button class="btn" id="b-guardar" data-act="guardar">Guardar en Asana</button></div>`;
}
let O = { texto: '', nombre: '', dia: ymd(new Date()), es: null, estado: '', sube: false, final: '' };
function vNotas() {
  const es = O.es;
  const cuenta = es ? ['CREAR', 'ACTUALIZAR', 'EXISTE', 'ERROR'].map(a => `${es.filter(e => e.accion === a).length} ${a.toLowerCase()}`).join(' · ') : '';
  const pend = es ? es.filter(e => e.accion === 'CREAR' || e.accion === 'ACTUALIZAR').length : 0;
  return `<header class="hdr"><div class="big"><h1>Notas</h1></div><small>Importa tu día desde Obsidian o exporta lo trabajado</small></header>
  <main class="main">
  <div class="card" style="display:flex;flex-direction:column;gap:10px"><b>Importar una nota</b>
    <label class="btn sec" style="cursor:pointer">📄 Elegir archivo .md<input type="file" id="o-file" accept=".md,.txt,text/markdown,text/plain" hidden></label>
    <textarea class="inp" id="o-texto" placeholder="…o pega aquí el texto de tu nota">${esc(O.texto)}</textarea>
    <div class="campo"><label for="o-dia">Fecha de la nota (si no trae encabezado de fecha)</label><input class="inp" type="date" id="o-dia" value="${O.dia}"></div>
    <button class="btn" data-act="o-analizar" ${O.sube ? 'disabled' : ''}>Analizar nota</button>
    <details><summary>Formato de cada línea</summary><pre class="fmt">- [x] 09:00-10:30 | Proyecto &gt; Tarea | Subtarea
- [ ] 11:00-12:00 | Proyecto &gt; Tarea | Pendiente

([x] completada, [ ] pendiente)
Varios días: usa encabezados con AAAA-MM-DD</pre></details></div>
  ${es ? `<div class="card"><b>Vista previa</b><div class="nota" style="margin:4px 0 8px">${cuenta}</div>
    <table class="tabla">${es.map(e => `<tr><td><span class="est ${e.accion}">${e.accion}</span></td><td>${esc(e.hora)}</td><td><b style="font-weight:500">${esc(e.subtarea)}</b><div class="nota">${esc(e.proyecto)} › ${esc(e.tarea)}<br>${esc(e.detalle)}</div></td></tr>`).join('')}</table>
    <button class="btn" style="margin-top:12px" data-act="o-subir" ${pend && !O.sube ? '' : 'disabled'}>${O.sube ? 'Subiendo…' : `Subir ${pend} a Asana`}</button>
    ${O.final ? `<button class="btn sec" style="margin-top:8px" data-act="o-bajar">⬇ Descargar nota actualizada (con GID)</button>` : ''}</div>` : ''}
  <div class="card" style="display:flex;flex-direction:column;gap:10px"><b>Exportar a Obsidian</b>
    <button class="btn sec" data-act="exp-dia">⬇ Exportar el día (${esc(ymd(S.dia))})</button>
    <button class="btn sec" data-act="exp-sem">⬇ Exportar la semana</button>
    <div class="nota">Se comparte/descarga un archivo .md; ábrelo o guárdalo en tu vault de Obsidian.</div></div>
  </main>${tabbar()}`;
}
function vPerfil() {
  const c = Cfg.get();
  return `<header class="hdr"><div class="big"><h1>Perfil</h1></div></header><main class="main">
  <div class="card"><b>${esc(S.user.name)}</b><div class="nota">${esc(S.user.email || '')}</div></div>
  <div class="campo"><span class="l">Workspace</span><button class="inp" data-act="pick-ws">${esc((S.user.workspaces.find(w => w.gid === S.ws) || {}).name || '—')}<span>⌄</span></button></div>
  <div class="campo"><label for="p-meta">Meta diaria (horas)</label><input class="inp" id="p-meta" type="number" min="1" max="24" step="0.5" value="${c.meta || 8}"></div>
  <button class="btn sec" data-act="recargar">↻ Recargar proyectos</button>
  <button class="btn peligro" data-act="salir">Cerrar sesión y olvidar token</button>
  <div class="nota" style="text-align:center">Indusoft Solutions S.A.C.</div></main>${tabbar()}`;
}

function sheet(titulo, items, onPick, buscar = true) {
  const bg = document.createElement('div'); bg.className = 'sheet-bg';
  bg.innerHTML = `<div class="sheet" role="dialog" aria-label="${esc(titulo)}"><h3>${esc(titulo)}</h3>${buscar ? '<input class="inp q" placeholder="Buscar…" autocomplete="off">' : ''}<div class="lista"></div></div>`;
  const lista = $('.lista', bg);
  const pintar = q => {
    const f = items.filter(i => key(i.name).includes(key(q))).slice(0, 200);
    lista.innerHTML = f.length ? f.map((i, n) => `<button class="op" data-n="${n}">${esc(i.name)}${i.sub ? `<small>${esc(i.sub)}</small>` : ''}</button>`).join('') : '<div class="vacio">Sin resultados</div>';
    lista._f = f;
  };
  pintar('');
  bg.addEventListener('click', e => {
    if (e.target === bg) return bg.remove();
    const b = e.target.closest('.op'); if (b) { bg.remove(); onPick(lista._f[+b.dataset.n]); }
  });
  const q = $('.q', bg); if (q) q.addEventListener('input', () => pintar(q.value));
  document.body.appendChild(bg); if (q) q.focus();
}

/* ---------------------------------------------------------------- render */
function render() {
  const app = $('#app'); const sc = $('.main', app)?.scrollTop || 0;
  if (!S.token) app.innerHTML = vLogin();
  else if (S.view === 'nueva') app.innerHTML = vNueva();
  else app.innerHTML = { hoy: vHoy, semana: vSemana, notas: vNotas, perfil: vPerfil }[S.tab]();
  const m = $('.main', app); if (m) m.scrollTop = sc;
}
async function recargar() {
  if (S.tab !== 'hoy' && S.tab !== 'semana') return render();
  S.loading = true; render();
  try { await (S.tab === 'hoy' ? cargarHoy() : cargarSemana()); }
  catch (e) { toast(e.message, true); S.rows = []; S.pend = []; }
  S.loading = false; render();
}
async function entrar(token, guardar) {
  S.token = token;
  const j = await api('GET', '/users/me', { params: { opt_fields: 'gid,name,email,workspaces,workspaces.name' } });
  S.user = j.data;
  const c = Cfg.get(); S.ws = (S.user.workspaces.find(w => w.gid === c.ws) || S.user.workspaces[0] || {}).gid;
  if (!S.ws) throw new Error('La cuenta no tiene workspaces');
  if (guardar) await Vault.guardar(token); else Vault.borrar();
  Cfg.set({ ws: S.ws });
  S.view = 'main'; S.tab = 'hoy'; S.loading = true; render();
  cargarProyectos().catch(e => toast('No se cargaron los proyectos: ' + e.message, true));
  recargar();
}
function salir() { S.token = null; S.user = null; S.rows = []; S.projects = []; S.tasksCache = {}; S.parents = {}; Vault.borrar(); S.error = ''; render(); }

async function guardarNueva() {
  const b = $('#b-guardar');
  if (!N.p || !N.t) return toast('Elige proyecto y tarea', true);
  if (!N.nombre.trim()) return toast('Escribe el nombre de la subtarea', true);
  if (durMin() <= 0) return toast('El fin debe ser posterior al inicio', true);
  const [y, mo, d] = N.fecha.split('-').map(Number), [h1, m1] = N.ini.split(':').map(Number), [h2, m2] = N.fin.split(':').map(Number);
  const data = { name: N.nombre.trim(), notes: N.notas.trim(), assignee: S.user.gid, completed: N.hecho,
    start_at: isoAsana(new Date(y, mo - 1, d, h1, m1)), due_at: isoAsana(new Date(y, mo - 1, d, h2, m2)) };
  b.disabled = true; b.textContent = 'Guardando…';
  try {
    await api('POST', `/tasks/${N.t.gid}/subtasks`, { data });
    const rec = [{ pg: N.p.gid, pn: N.p.name, tg: N.t.gid, tn: N.t.name }, ...(Cfg.get().recientes || []).filter(r => r.tg !== N.t.gid)].slice(0, 4);
    Cfg.set({ recientes: rec });
    toast('Subtarea creada en Asana');
    S.dia = parseYmd(N.fecha); S.view = 'main'; S.tab = 'hoy'; N = null; recargar();
  } catch (e) { toast(e.message, true); b.disabled = false; b.textContent = 'Guardar en Asana'; }
}

/* ---------------------------------------------------------------- eventos */
document.addEventListener('submit', async e => {
  if (e.target.id !== 'f-login') return;
  e.preventDefault();
  const t = $('#tok').value.trim(); if (!t) { S.error = 'Debes ingresar tu token.'; return render(); }
  const b = $('#b-login'); b.disabled = true; b.textContent = 'Validando…';
  try { await entrar(t, $('#ck-guardar').checked); }
  catch (x) { S.token = null; S.error = /HTTP 401/.test(x.message) ? 'El token no es válido o ha expirado.' : x.message; render(); }
});
document.addEventListener('input', e => {
  const id = e.target.id;
  if (N && id === 'n-nombre') N.nombre = e.target.value;
  else if (N && id === 'n-notas') N.notas = e.target.value;
  else if (N && (id === 'n-fecha' || id === 'n-ini' || id === 'n-fin')) {
    N[{ 'n-fecha': 'fecha', 'n-ini': 'ini', 'n-fin': 'fin' }[id]] = e.target.value; const d = durMin();
    $('#n-dur').textContent = d > 0 ? 'Duración: ' + fmtH(d / 60) : 'El fin debe ser posterior';
  } else if (id === 'o-texto') O.texto = e.target.value;
  else if (id === 'o-dia') O.dia = e.target.value;
  else if (id === 'p-meta') Cfg.set({ meta: Math.max(1, +e.target.value || 8) });
});
document.addEventListener('change', async e => {
  if (e.target.id !== 'o-file' || !e.target.files[0]) return;
  const f = e.target.files[0]; O.texto = await f.text(); O.nombre = f.name; O.es = null; O.final = '';
  const m = f.name.match(RE_FECHA); if (m) O.dia = m[0]; render();
});
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-tab],[data-dia],[data-sem],[data-act],[data-add],[data-est],[data-rec]'); if (!t) return;
  const D = t.dataset;
  if (D.tab) { S.tab = D.tab; S.view = 'main'; return D.tab === 'hoy' || D.tab === 'semana' ? recargar() : render(); }
  if (D.dia) { S.dia = addDays(S.dia, +D.dia); return recargar(); }
  if (D.sem) { S.semana = addDays(S.semana, 7 * +D.sem); return recargar(); }
  if (D.add) { const [h, m] = N.fin.split(':').map(Number), x = new Date(2000, 0, 1, h, m + +D.add); N.fin = hm(x); return render(); }
  if (D.est !== undefined) { N.hecho = D.est === '1'; return render(); }
  if (D.rec !== undefined) {
    const r = N.recientes[+D.rec]; N.p = { gid: r.pg, name: r.pn }; N.t = { gid: r.tg, name: r.tn }; return render();
  }
  switch (D.act) {
    case 'nueva': N = nuevoForm(); S.view = 'nueva'; return render();
    case 'atras': S.view = 'main'; N = null; return render();
    case 'ahora': { const a = new Date(); a.setMinutes(Math.round(a.getMinutes() / 5) * 5, 0, 0); N.ini = hm(a); N.fin = hm(new Date(a.getTime() + 36e5)); N.fecha = ymd(a); return render(); }
    case 'pick-p': return sheet('Proyecto', S.projects, p => { N.p = p; N.t = null; render(); });
    case 'pick-t': {
      if (!N.p) return toast('Primero elige el proyecto', true);
      toast('Cargando tareas…');
      try { const ts = await tareasDe(N.p.gid); sheet('Tarea', ts, x => { N.t = x; render(); }); }
      catch (x) { toast(x.message, true); } return;
    }
    case 'guardar': return guardarNueva();
    case 'pick-ws': return sheet('Workspace', S.user.workspaces, async w => {
      S.ws = w.gid; Cfg.set({ ws: w.gid }); S.tasksCache = {}; S.projects = []; render();
      cargarProyectos().catch(x => toast(x.message, true)); });
    case 'recargar': S.tasksCache = {}; try { await cargarProyectos(); toast('Proyectos actualizados'); } catch (x) { toast(x.message, true); } return;
    case 'salir': if (confirm('¿Cerrar sesión y borrar el token de este dispositivo?')) salir(); return;
    case 'o-analizar': {
      if (!O.texto.trim()) return toast('Elige un archivo o pega el texto', true);
      if (!S.projects.length) return toast('Aún se cargan los proyectos; reintenta en unos segundos', true);
      O.es = parsearNota(O.texto, O.dia); O.final = '';
      if (!O.es.length) { O.es = null; return toast('No hay líneas con el formato esperado', true); }
      O.sube = true; toast('Buscando en Asana…'); render();
      try { await resolverEntradas(O.es); } catch (x) { toast(x.message, true); }
      O.sube = false; return render();
    }
    case 'o-subir': {
      const n = O.es.filter(x => x.accion === 'CREAR' || x.accion === 'ACTUALIZAR').length;
      if (!n || !confirm(`Se crearán o actualizarán ${n} subtarea(s) en Asana, asignadas a tu cuenta. ¿Continuar?`)) return;
      O.sube = true; render();
      const r = await subirEntradas(O.es); O.sube = false;
      O.final = notaConGid(O.texto, O.es);
      toast(r.errores.length ? `Subidas ${r.ok}. Con error: ${r.errores[0]}` : `Se subieron ${r.ok} subtarea(s)`, !!r.errores.length);
      return render();
    }
    case 'o-bajar': return descargar(O.nombre || `Nota ${O.dia}.md`, O.final);
    case 'exp-dia': {
      toast('Preparando…'); const d = S.dia;
      try { const h = await buscarCompletadas(d), r = await filasDe(h.filter(x => x.completed), d, d);
        if (!r.length) return toast('No hay subtareas completadas ese día', true);
        return descargar(`Resumen ${ymd(d)}.md`, notaDeFilas(r)); } catch (x) { return toast(x.message, true); }
    }
    case 'exp-sem': {
      toast('Preparando…'); const l = lunes(S.semana), dom = addDays(l, 6);
      try { const h = await buscarCompletadas(l), r = await filasDe(h.filter(x => x.completed), l, dom);
        if (!r.length) return toast('No hay subtareas esa semana', true);
        return descargar(`Resumen semana ${ymd(l)}.md`, notaDeFilas(r)); } catch (x) { return toast(x.message, true); }
    }
  }
});

/* ------------------------------------------------------------------ inicio */
(async function init() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  render();
  const tk = await Vault.leer();
  if (tk) { try { await entrar(tk, true); } catch (x) { S.token = null; S.error = /HTTP 401/.test(x.message) ? 'Tu token guardado ya no es válido.' : ''; render(); } }
})();
window.IA = { S, parsearNota, notaDeFilas, notaConGid, resolverEntradas, fmtH };
