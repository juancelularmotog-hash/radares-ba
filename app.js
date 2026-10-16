/* Radares BA — app web de avisos de radares para CABA y Provincia de Buenos Aires.
   Todo corre en el navegador: los datos se guardan en el propio celular. */
'use strict';
(function () {
  const VERSION = '1.0.2';
  const $ = (id) => document.getElementById(id);

  // ---------- Almacenamiento local seguro ----------
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* sin espacio o bloqueado */ } }
  };

  const AJUSTES_DEF = {
    aviso1: 500, aviso2: 250, tolerancia: 5,
    voz: true, sonido: true, alarmaExceso: true,
    verVelocidad: true, verCamaras: true, verOtros: true,
    modoMapa: 'auto'
  };
  let ajustes = Object.assign({}, AJUSTES_DEF, LS.get('ajustes', {}));
  let repo = LS.get('datosRepo', null);      // radares.json del repositorio
  let osmVivo = LS.get('datosOSM', null);    // consulta directa a OpenStreetMap
  let cabaVivo = LS.get('datosCABA', null);  // descarga directa del dataset de CABA
  let propios = LS.get('radaresPropios', []);
  let ocultos = new Set(LS.get('radaresOcultos', []));

  const TIPOS = {
    velocidad: { nombre: 'Radar de velocidad', clase: 't-vel' },
    semaforo: { nombre: 'Cámara de semáforo', clase: 't-sem' },
    video: { nombre: 'Cámara de control', clase: 't-cam' },
    otro: { nombre: 'Control vial', clase: 't-otro' }
  };
  const FUENTES = { CABA: 'Gobierno de la Ciudad (oficial)', OSM: 'OpenStreetMap (comunidad)', ANSV: 'ANSV (oficial)', PBA: 'Provincia de Bs. As. (oficial)', manual: 'Revisión manual', usuario: 'Agregado por vos' };
  const PRIORIDAD = { CABA: 3, ANSV: 3, PBA: 3, manual: 2, OSM: 1, usuario: 0 };

  // ---------- Geometría ----------
  const R = 6371000;
  const rad = (d) => d * Math.PI / 180;
  const deg = (r) => r * 180 / Math.PI;
  function dist(a, b, c, d) {
    const dLat = rad(c - a), dLon = rad(d - b);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }
  function rumbo(a, b, c, d) {
    const y = Math.sin(rad(d - b)) * Math.cos(rad(c));
    const x = Math.cos(rad(a)) * Math.sin(rad(c)) - Math.sin(rad(a)) * Math.cos(rad(c)) * Math.cos(rad(d - b));
    return (deg(Math.atan2(y, x)) + 360) % 360;
  }
  function difAng(a, b) { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }
  function destino(lat, lon, brng, m) {
    const dd = m / R, th = rad(brng), p1 = rad(lat), l1 = rad(lon);
    const p2 = Math.asin(Math.sin(p1) * Math.cos(dd) + Math.cos(p1) * Math.sin(dd) * Math.cos(th));
    const l2 = l1 + Math.atan2(Math.sin(th) * Math.sin(dd) * Math.cos(p1), Math.cos(dd) - Math.sin(p1) * Math.sin(p2));
    return [deg(p2), deg(l2)];
  }

  // ---------- Mapa ----------
  const mapa = L.map('mapa', { zoomControl: false, attributionControl: true, tap: false }).setView([-34.6037, -58.3816], 13);
  // Proveedores de mapa en orden de preferencia. Si uno no responde, se pasa al siguiente solo.
  const ATRIB_OSM = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
  const PROVEEDORES = {
    dia: [
      { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', sub: '', atrib: ATRIB_OSM, max: 19 },
      { url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', sub: 'abc', atrib: ATRIB_OSM + ' · HOT', max: 19 }
    ],
    noche: [
      { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', sub: '', atrib: ATRIB_OSM, max: 19, invertir: true },
      { url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', sub: 'abc', atrib: ATRIB_OSM + ' · HOT', max: 19, invertir: true }
    ]
  };
  let capaBase = null, modoAplicado = null, idxProveedor = 0, avisoMapa = false;
  function modoActual() {
    if (ajustes.modoMapa !== 'auto') return ajustes.modoMapa;
    const h = new Date().getHours();
    return (h >= 20 || h < 7) ? 'noche' : 'dia';
  }
  function ponerCapa() {
    const lista = PROVEEDORES[modoAplicado];
    const p = lista[Math.min(idxProveedor, lista.length - 1)];
    if (capaBase) mapa.removeLayer(capaBase);
    document.documentElement.classList.toggle('mapa-invertido', !!p.invertir);
    const opciones = { attribution: p.atrib, maxZoom: 20, maxNativeZoom: p.max };
    if (p.sub) opciones.subdomains = p.sub;
    const capa = L.tileLayer(p.url, opciones);
    let ok = 0, err = 0;
    capa.on('tileload', () => { ok++; });
    capa.on('tileerror', () => {
      err++;
      if (ok === 0 && err >= 4 && capa === capaBase) {
        if (idxProveedor < lista.length - 1) { idxProveedor++; ponerCapa(); }
        else if (!avisoMapa) { avisoMapa = true; toast('No se pudo cargar el mapa de calles. Revisá la conexión a internet; los radares y los avisos funcionan igual.', 7000); }
      }
    });
    capaBase = capa.addTo(mapa);
  }
  function aplicarModoMapa() {
    const m = modoActual();
    if (m === modoAplicado) return;
    modoAplicado = m;
    document.documentElement.dataset.mapa = m;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', m === 'noche' ? '#11161d' : '#f5f7f9');
    ponerCapa();
  }

  // ---------- Radares ----------
  const capaRadares = L.layerGroup().addTo(mapa);
  let radares = [];
  const estadoRadar = new Map();

  function deduplicar(lista) {
    const ordenada = lista.slice().sort((a, b) => (PRIORIDAD[b.fuente] || 0) - (PRIORIDAD[a.fuente] || 0));
    const res = [];
    const grilla = new Map();
    const clave = (la, lo) => Math.round(la * 2000) + ':' + Math.round(lo * 2000);
    for (const r of ordenada) {
      if (typeof r.lat !== 'number' || typeof r.lon !== 'number' || isNaN(r.lat) || isNaN(r.lon)) continue;
      const cla = Math.round(r.lat * 2000), clo = Math.round(r.lon * 2000);
      let dup = null;
      for (let i = -1; i <= 1 && !dup; i++) for (let j = -1; j <= 1 && !dup; j++) {
        const celda = grilla.get((cla + i) + ':' + (clo + j));
        if (!celda) continue;
        dup = celda.find((x) => dist(x.lat, x.lon, r.lat, r.lon) < 30 && (x.tipo === r.tipo || x.tipo === 'otro' || r.tipo === 'otro'));
      }
      if (dup) {
        if (!dup.vmax && r.vmax) dup.vmax = r.vmax;
        if (dup.dir == null && r.dir != null) dup.dir = r.dir;
        if (!dup.nombre && r.nombre) dup.nombre = r.nombre;
        continue;
      }
      const copia = Object.assign({}, r);
      res.push(copia);
      const k = clave(r.lat, r.lon);
      if (!grilla.has(k)) grilla.set(k, []);
      grilla.get(k).push(copia);
    }
    return res;
  }

  function baseCombinada() {
    const lista = []
      .concat((repo && repo.radares) || [])
      .concat((cabaVivo && cabaVivo.radares) || [])
      .concat((osmVivo && osmVivo.radares) || []);
    return deduplicar(lista);
  }
  let base = baseCombinada();

  function visible(r) {
    if (ocultos.has(r.id)) return false;
    if (r.tipo === 'velocidad') return ajustes.verVelocidad;
    if (r.tipo === 'semaforo' || r.tipo === 'video') return ajustes.verCamaras;
    return ajustes.verOtros;
  }
  function iconoRadar(r) {
    const t = TIPOS[r.tipo] || TIPOS.otro;
    const txt = r.tipo === 'semaforo' ? '<i></i><i></i><i></i>' : (r.vmax && r.tipo !== 'video' ? r.vmax : '');
    return L.divIcon({ className: '', html: '<div class="mk ' + t.clase + (r.fuente === 'usuario' ? ' mk-propio' : '') + '">' + txt + '</div>', iconSize: [26, 26], iconAnchor: [13, 13] });
  }
  function dibujarRadares() {
    capaRadares.clearLayers();
    radares = base.concat(propios).filter(visible);
    for (const r of radares) {
      L.marker([r.lat, r.lon], { icon: iconoRadar(r), keyboard: false }).bindPopup(() => popupRadar(r)).addTo(capaRadares);
    }
    actualizarResumen();
  }
  function popupRadar(r) {
    const t = TIPOS[r.tipo] || TIPOS.otro;
    const div = document.createElement('div');
    div.className = 'pop';
    const s = document.createElement('strong'); s.textContent = t.nombre; div.appendChild(s);
    const l = document.createElement('div');
    l.textContent = (r.nombre || 'Sin descripción') + (r.vmax ? ' · Máx. ' + r.vmax + ' km/h' : '');
    div.appendChild(l);
    const f = document.createElement('div'); f.className = 'pop-f';
    f.textContent = 'Fuente: ' + (FUENTES[r.fuente] || r.fuente);
    div.appendChild(f);
    const b = document.createElement('button'); b.className = 'btn-sec';
    if (r.fuente === 'usuario') {
      b.textContent = 'Borrar este radar';
      b.onclick = () => {
        propios = propios.filter((p) => p.id !== r.id); LS.set('radaresPropios', propios);
        mapa.closePopup(); dibujarRadares(); toast('Radar borrado.');
      };
    } else {
      b.textContent = 'Ya no está: ocultarlo';
      b.onclick = () => {
        ocultos.add(r.id); LS.set('radaresOcultos', [...ocultos]);
        mapa.closePopup(); dibujarRadares(); toast('Radar ocultado. Lo podés restaurar desde Ajustes.');
      };
    }
    div.appendChild(b);
    return div;
  }

  // ---------- Descarga de datos ----------
  const URL_REPO = 'data/radares.json';
  const URL_CABA = 'https://cdn.buenosaires.gob.ar/datosabiertos/datasets/transporte-y-obras-publicas/camaras-fijas-control-vehicular/camaras-fijas-de-control-vehicular.csv';
  const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  const CONSULTA_OSM = '[out:json][timeout:90];' +
    '(area["ISO3166-2"="AR-B"];area["ISO3166-2"="AR-C"];)->.a;' +
    '(node["highway"="speed_camera"](area.a);' +
    'node["enforcement"~"maxspeed|traffic_signals|average_speed"](area.a);' +
    'relation["type"="enforcement"]["enforcement"~"maxspeed|traffic_signals|average_speed"](area.a););' +
    'out body;>;out skel qt;';

  function conTiempo(ms) { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; }

  async function bajarRepo() {
    const r = await fetch(URL_REPO + '?t=' + Date.now(), { cache: 'no-store', signal: conTiempo(20000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (!j || !Array.isArray(j.radares)) throw new Error('formato');
    repo = j; LS.set('datosRepo', repo);
    return j.radares.length;
  }

  function parseVmax(v) { const m = /(\d{2,3})/.exec(v || ''); return m ? +m[1] : null; }
  function parseDir(v) {
    if (v == null) return null;
    const n = parseFloat(v);
    if (!isNaN(n) && /^\s*-?\d/.test(String(v))) return ((n % 360) + 360) % 360;
    const p = { N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5, S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5 };
    const k = String(v).toUpperCase().trim();
    return k in p ? p[k] : null;
  }
  function radarOSM(t, lat, lon, id) {
    const enf = String(t.enforcement || '').toLowerCase();
    let tipo = 'velocidad';
    if (enf.includes('traffic_signals')) tipo = 'semaforo';
    else if (enf && !enf.includes('maxspeed') && !enf.includes('average_speed') && t.highway !== 'speed_camera') tipo = 'otro';
    return { id: 'osm-' + id, lat, lon, tipo, vmax: parseVmax(t.maxspeed), dir: parseDir(t.direction), nombre: t.name || t.description || t.ref || '', fuente: 'OSM' };
  }
  function parsearOSM(j) {
    const nodos = new Map(), out = [];
    for (const e of j.elements || []) if (e.type === 'node') nodos.set(e.id, e);
    for (const e of j.elements || []) {
      if (e.type === 'node' && e.tags && (e.tags.highway === 'speed_camera' || e.tags.enforcement)) out.push(radarOSM(e.tags, e.lat, e.lon, 'n' + e.id));
    }
    for (const e of j.elements || []) {
      if (e.type !== 'relation' || !e.tags) continue;
      const m = e.members || [];
      const dev = m.find((x) => x.role === 'device' && x.type === 'node');
      const desde = m.find((x) => x.role === 'from' && x.type === 'node');
      const n = (dev && nodos.get(dev.ref)) || (desde && nodos.get(desde.ref));
      if (!n || n.lat == null) continue;
      out.push(radarOSM(Object.assign({}, n.tags || {}, e.tags), n.lat, n.lon, 'r' + e.id));
    }
    return out;
  }
  async function bajarOSM() {
    let ultimoError = null;
    for (const url of OVERPASS) {
      try {
        const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(CONSULTA_OSM), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: conTiempo(100000) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const lista = parsearOSM(await r.json());
        osmVivo = { fecha: new Date().toISOString(), radares: lista }; LS.set('datosOSM', osmVivo);
        return lista.length;
      } catch (e) { ultimoError = e; }
    }
    throw ultimoError || new Error('sin respuesta');
  }

  function parsearCSVCaba(texto) {
    const lineas = texto.split(/\r?\n/).filter((l) => l.trim());
    if (lineas.length < 2) return [];
    const cab = lineas[0].split(';').map((c) => c.trim().toLowerCase());
    const iTipo = cab.findIndex((c) => c.startsWith('tipo'));
    const iUbi = cab.findIndex((c) => c.startsWith('ubic'));
    const iLat = cab.findIndex((c) => c.startsWith('lat'));
    const iLon = cab.findIndex((c) => c.startsWith('lon'));
    const out = [];
    for (const l of lineas.slice(1)) {
      const c = l.split(';');
      const lat = parseFloat(String(c[iLat] || '').replace(',', '.'));
      const lon = parseFloat(String(c[iLon] || '').replace(',', '.'));
      if (isNaN(lat) || isNaN(lon)) continue;
      const tt = String(c[iTipo] || '').toLowerCase();
      const tipo = tt.includes('cinem') ? 'velocidad' : (tt.includes('anal') || tt.includes('video')) ? 'video' : 'otro';
      out.push({ id: 'caba-' + lat.toFixed(5) + ',' + lon.toFixed(5) + '-' + tipo, lat, lon, tipo, vmax: null, dir: null, nombre: String(c[iUbi] || '').trim(), fuente: 'CABA' });
    }
    return out;
  }
  async function bajarCABA() {
    const r = await fetch(URL_CABA, { signal: conTiempo(20000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const buf = await r.arrayBuffer();
    let texto = new TextDecoder('utf-8').decode(buf);
    if (texto.includes('�')) texto = new TextDecoder('windows-1252').decode(buf);
    const lista = parsearCSVCaba(texto);
    if (!lista.length) throw new Error('vacío');
    cabaVivo = { fecha: new Date().toISOString(), radares: lista }; LS.set('datosCABA', cabaVivo);
    return lista.length;
  }

  let actualizando = false;
  async function actualizarRadares() {
    if (actualizando) return;
    actualizando = true;
    const btn = $('btnActualizar');
    btn.disabled = true; btn.textContent = 'Actualizando…';
    $('estadoAct').textContent = 'Descargando radares. Puede tardar hasta un minuto.';
    const partes = [];
    const tareas = [
      bajarRepo().then((n) => partes.push('lista del proyecto: ' + n), () => partes.push('lista del proyecto: sin conexión')),
      bajarCABA().then((n) => partes.push('CABA oficial: ' + n), () => { /* el sitio de CABA puede bloquear la descarga directa; la lista del proyecto la trae igual */ }),
      bajarOSM().then((n) => partes.push('OpenStreetMap: ' + n), () => partes.push('OpenStreetMap: no respondió'))
    ];
    await Promise.all(tareas);
    base = baseCombinada();
    estadoRadar.clear();
    dibujarRadares();
    LS.set('ultimaActualizacion', new Date().toISOString());
    $('estadoAct').textContent = 'Listo. ' + partes.join(' · ') + '.';
    btn.disabled = false; btn.textContent = 'Actualizar radares';
    actualizando = false;
    toast('Radares actualizados: ' + base.length + ' en total.');
  }

  function actualizarResumen() {
    const cuenta = { CABA: 0, OSM: 0, otros: 0 };
    for (const r of base) {
      if (r.fuente === 'CABA') cuenta.CABA++; else if (r.fuente === 'OSM') cuenta.OSM++; else cuenta.otros++;
    }
    const caja = $('resumen');
    caja.textContent = '';
    const items = [[base.length + propios.length, 'en total'], [cuenta.CABA, 'CABA oficial'], [cuenta.OSM, 'comunidad (OSM)'], [propios.length, 'tuyos']];
    if (cuenta.otros) items.splice(3, 0, [cuenta.otros, 'otras fuentes']);
    for (const [n, t] of items) {
      const d = document.createElement('div');
      const b = document.createElement('b'); b.textContent = n;
      const s = document.createElement('span'); s.textContent = t;
      d.append(b, s); caja.appendChild(d);
    }
    const u = LS.get('ultimaActualizacion', null);
    const fr = repo && repo.generado ? new Date(repo.generado) : null;
    let txt = u ? 'Última actualización en este celular: ' + fechaCorta(new Date(u)) + '.' : 'Todavía no actualizaste los radares en este celular.';
    if (fr && !isNaN(fr)) txt += ' Lista del proyecto generada el ' + fechaCorta(fr) + '.';
    if (ocultos.size) txt += ' Ocultos: ' + ocultos.size + '.';
    if (!$('btnActualizar').disabled) $('estadoAct').textContent = txt;
  }
  function fechaCorta(d) { return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); }

  // ---------- Sonido y voz ----------
  let ctxAudio = null;
  function audio() {
    if (!ctxAudio) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) ctxAudio = new AC(); }
    if (ctxAudio && ctxAudio.state === 'suspended') ctxAudio.resume();
    return ctxAudio;
  }
  function tono(f, ini, dur, vol) {
    const c = audio(); if (!c) return;
    const o = c.createOscillator(), g = c.createGain(), t0 = c.currentTime + ini;
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol || 0.3, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(c.destination);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }
  function pitido(n) {
    if (n === 1) tono(880, 0, 0.2);
    else if (n === 2) { tono(880, 0, 0.16); tono(1175, 0.2, 0.24); }
    else { for (let i = 0; i < 3; i++) tono(1480, i * 0.17, 0.12, 0.4); }
  }
  function vozEs() {
    if (!('speechSynthesis' in window)) return null;
    const vs = speechSynthesis.getVoices();
    return vs.find((v) => /es[-_]AR/i.test(v.lang)) || vs.find((v) => /es[-_](US|MX|419)/i.test(v.lang)) || vs.find((v) => /^es/i.test(v.lang)) || null;
  }
  function hablar(txt) {
    if (!('speechSynthesis' in window)) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(txt);
      u.lang = 'es-AR'; u.rate = 1.05;
      const v = vozEs(); if (v) u.voice = v;
      speechSynthesis.speak(u);
    } catch (e) { /* sin voz */ }
  }
  if ('speechSynthesis' in window) { try { speechSynthesis.getVoices(); speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices(); } catch (e) { /* nada */ } }

  // ---------- Avisos en pantalla ----------
  let tAlerta = null, tToast = null;
  function mostrarAlerta(txt, fuerte) {
    const a = $('alerta');
    $('alertaTxt').textContent = txt;
    a.classList.toggle('fuerte', !!fuerte);
    a.hidden = false;
    clearTimeout(tAlerta);
    tAlerta = setTimeout(() => { a.hidden = true; }, fuerte ? 6000 : 4500);
  }
  function toast(txt, ms) {
    const t = $('toast');
    t.textContent = txt; t.hidden = false;
    clearTimeout(tToast);
    tToast = setTimeout(() => { t.hidden = true; }, ms || 3500);
  }

  // ---------- Posición y viaje ----------
  let viajeActivo = false, watchId = null, wakeLock = null, posAnt = null, rumboActual = null, velActual = 0;
  let siguiendo = true, simulacion = null, ultimaFix = 0, fueAlFondo = false, primeraFix = true;
  const marcadorAuto = L.marker([-34.6, -58.4], {
    icon: L.divIcon({ className: '', html: '<div class="auto sin-rumbo" id="autoIcono"><svg viewBox="0 0 40 40" aria-hidden="true"><path d="M20 3 L33 35 L20 28 L7 35 Z"/></svg></div>', iconSize: [40, 40], iconAnchor: [20, 20] }),
    interactive: false, keyboard: false, zIndexOffset: 1000
  });
  let autoVisible = false;

  function desdeGeo(pos) {
    const c = pos.coords;
    onPos({
      lat: c.latitude, lon: c.longitude,
      vel: (c.speed != null && c.speed >= 0) ? c.speed * 3.6 : null,
      rumbo: (c.heading != null && !isNaN(c.heading) && (c.speed == null || c.speed > 1)) ? c.heading : null,
      precision: c.accuracy, t: pos.timestamp || Date.now()
    });
  }
  function onPos(p) {
    ultimaFix = Date.now();
    if (posAnt) {
      const d = dist(posAnt.lat, posAnt.lon, p.lat, p.lon);
      const dt = (p.t - posAnt.t) / 1000;
      if (p.vel == null && dt > 0) p.vel = d / dt * 3.6;
      if (p.rumbo == null && d > 6) p.rumbo = rumbo(posAnt.lat, posAnt.lon, p.lat, p.lon);
    }
    if (p.rumbo != null) rumboActual = p.rumbo;
    velActual = p.vel != null ? p.vel : 0;
    posAnt = p;

    $('vel').textContent = Math.round(velActual);
    const g = $('gpsEstado');
    const buena = p.precision == null || p.precision <= 30;
    g.className = 'gps ' + (buena ? 'bien' : 'mal');
    g.textContent = simulacion ? 'Simulación' : (buena ? 'GPS bien' : 'GPS débil (±' + Math.round(p.precision) + ' m)');

    marcadorAuto.setLatLng([p.lat, p.lon]);
    if (!autoVisible) { marcadorAuto.addTo(mapa); autoVisible = true; }
    const ic = document.getElementById('autoIcono');
    if (ic && rumboActual != null) { ic.classList.remove('sin-rumbo'); ic.style.transform = 'rotate(' + rumboActual + 'deg)'; }
    if (siguiendo) {
      if (primeraFix) { mapa.setView([p.lat, p.lon], 16); primeraFix = false; }
      else mapa.panTo([p.lat, p.lon], { animate: true, duration: 0.8 });
    }
    evaluarRadares(p);
  }

  function evaluarRadares(p) {
    let mejor = null;
    for (const r of radares) {
      const d = dist(p.lat, p.lon, r.lat, r.lon);
      let e = estadoRadar.get(r.id);
      if (d > 3000) { if (e) estadoRadar.delete(r.id); continue; }
      if (!e) { e = { nivel: 0, dPrev: d }; estadoRadar.set(r.id, e); }
      const acercando = d <= e.dPrev + 3;
      e.dPrev = d;
      if (d > ajustes.aviso1 + 300) e.nivel = 0;
      const delante = rumboActual == null ? d < 120 : difAng(rumbo(p.lat, p.lon, r.lat, r.lon), rumboActual) <= 40;
      const sentido = r.dir == null || rumboActual == null || difAng(r.dir, rumboActual) <= 60;
      if (!delante || !sentido) continue;
      if (!mejor || d < mejor.d) mejor = { r, d };
      if (velActual < 8) continue;
      if (e.nivel < 1 && d <= ajustes.aviso1 && acercando) { e.nivel = 1; aviso(r, d, 1); }
      if (e.nivel < 2 && d <= ajustes.aviso2 && acercando) { e.nivel = 2; aviso(r, d, 2); }
    }
    mostrarProximo(mejor);
    chequearExceso(mejor);
  }
  function redondear(d) { return d >= 100 ? Math.round(d / 50) * 50 : Math.max(10, Math.round(d / 10) * 10); }
  function aviso(r, d, nivel) {
    const t = TIPOS[r.tipo] || TIPOS.otro;
    const txt = t.nombre + ' a ' + redondear(d) + ' metros' + (r.vmax ? '. Máxima ' + r.vmax : '');
    const excede = r.vmax && velActual > r.vmax + ajustes.tolerancia;
    mostrarAlerta(txt, nivel === 2 || excede);
    if (ajustes.sonido) pitido(nivel);
    if (ajustes.voz && (nivel === 2 || !ajustes.sonido)) hablar(txt + (excede ? '. Bajá la velocidad.' : ''));
    if (navigator.vibrate) { try { navigator.vibrate(nivel === 2 ? [200, 100, 200] : 150); } catch (e) { /* nada */ } }
  }
  function mostrarProximo(m) {
    const h = $('hudProx');
    if (!m || m.d > 2000) { h.hidden = true; return; }
    const t = TIPOS[m.r.tipo] || TIPOS.otro;
    h.hidden = false;
    const s = $('proxSenal');
    s.className = 'senal ' + t.clase;
    $('proxVmax').textContent = m.r.vmax || (m.r.tipo === 'velocidad' ? '?' : '●');
    $('proxDist').textContent = m.d >= 1000 ? (m.d / 1000).toFixed(1).replace('.', ',') + ' km' : redondear(m.d) + ' m';
    $('proxTipo').textContent = t.nombre + (m.r.nombre ? ' · ' + m.r.nombre : '');
  }
  let ultimaAlarma = 0;
  function chequearExceso(m) {
    const exceso = !!(m && m.r.vmax && m.d <= ajustes.aviso1 && velActual > m.r.vmax + ajustes.tolerancia);
    $('hudVel').classList.toggle('exceso', exceso);
    if (exceso && ajustes.alarmaExceso && Date.now() - ultimaAlarma > 2500) { ultimaAlarma = Date.now(); pitido(3); }
  }

  async function pedirWakeLock() {
    try { if ('wakeLock' in navigator && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { wakeLock = null; }
  }
  function soltarWakeLock() { try { if (wakeLock) wakeLock.release(); } catch (e) { /* nada */ } wakeLock = null; }

  function marcarViajeActivo(activo) {
    viajeActivo = activo;
    const b = $('btnViaje');
    b.textContent = activo ? 'Terminar viaje' : 'Iniciar viaje';
    b.classList.toggle('activo', activo);
  }
  function iniciarViaje() {
    if (!('geolocation' in navigator)) { toast('Este navegador no permite usar el GPS.'); return; }
    audio(); tono(440, 0, 0.05, 0.001);
    if (ajustes.voz) hablar('Viaje iniciado. Te aviso cuando haya un radar adelante.');
    marcarViajeActivo(true);
    siguiendo = true; primeraFix = true; posAnt = null; rumboActual = null; $('btnCentrar').hidden = true;
    estadoRadar.clear();
    const g = $('gpsEstado'); g.className = 'gps'; g.textContent = 'Buscando GPS…';
    watchId = navigator.geolocation.watchPosition(desdeGeo, errorGeo, { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
    pedirWakeLock();
  }
  function terminarViaje() {
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    if (simulacion) { clearInterval(simulacion); simulacion = null; }
    soltarWakeLock();
    marcarViajeActivo(false);
    $('vel').textContent = '--';
    $('hudProx').hidden = true;
    $('hudVel').classList.remove('exceso');
    const g = $('gpsEstado'); g.className = 'gps'; g.textContent = 'GPS apagado';
  }
  function errorGeo(e) {
    const g = $('gpsEstado'); g.className = 'gps mal';
    if (e.code === 1) {
      g.textContent = 'Sin permiso de ubicación';
      toast('No hay permiso para usar tu ubicación. En el iPhone: Configuración → Privacidad → Localización → Safari → "Al usar la app".', 8000);
      terminarViaje();
    } else if (e.code === 3) {
      g.textContent = 'Esperando señal GPS…';
    } else {
      g.textContent = 'GPS con problemas';
    }
  }
  setInterval(() => {
    if (viajeActivo && !simulacion && ultimaFix && Date.now() - ultimaFix > 12000) {
      const g = $('gpsEstado'); g.className = 'gps mal'; g.textContent = 'Sin señal GPS';
    }
    aplicarModoMapa();
  }, 4000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (viajeActivo) {
        pedirWakeLock();
        if (fueAlFondo) toast('Mientras la app estuvo cerrada o con la pantalla bloqueada no se pudieron dar avisos.', 6000);
      }
      fueAlFondo = false;
    } else if (viajeActivo) fueAlFondo = true;
  });

  // ---------- Simulación ----------
  function simular() {
    const centro = mapa.getCenter();
    const candidatos = radares.filter((r) => r.tipo === 'velocidad');
    const lista = candidatos.length ? candidatos : radares;
    if (!lista.length) { toast('No hay radares cargados. Tocá "Actualizar radares" primero.'); return; }
    let obj = null, mejor = Infinity;
    for (const r of lista) { const d = dist(centro.lat, centro.lng, r.lat, r.lon); if (d < mejor) { mejor = d; obj = r; } }
    cerrarHojas();
    if (viajeActivo) terminarViaje();
    audio(); tono(440, 0, 0.05, 0.001);
    const brng = obj.dir != null ? obj.dir : 45;
    let pos = destino(obj.lat, obj.lon, (brng + 180) % 360, 1300);
    const velSim = obj.vmax ? obj.vmax + 15 : 70;
    const paso = velSim / 3.6;
    marcarViajeActivo(true);
    siguiendo = true; primeraFix = true; posAnt = null; rumboActual = null; $('btnCentrar').hidden = true;
    estadoRadar.clear();
    let n = 0; const total = Math.ceil(1800 / paso);
    toast('Simulación: vas a ' + Math.round(velSim) + ' km/h hacia ' + (obj.nombre || 'un radar') + '.', 5000);
    if (ajustes.voz) hablar('Empieza la simulación.');
    simulacion = setInterval(() => {
      pos = destino(pos[0], pos[1], brng, paso);
      onPos({ lat: pos[0], lon: pos[1], vel: velSim, rumbo: brng, precision: 5, t: Date.now() });
      if (++n > total) { terminarViaje(); toast('Simulación terminada.'); }
    }, 1000);
  }

  // ---------- Agregar radar ----------
  let agregando = false, puntoNuevo = null, marcaTemporal = null;
  function abrirAgregar() {
    cerrarHojas();
    agregando = true; puntoNuevo = null;
    $('btnGuardarRadar').disabled = true;
    $('agForm').hidden = true;
    $('agregarAyuda').textContent = 'Tocá el mapa donde está el radar, o usá tu posición actual.';
    $('hojaAgregar').hidden = false;
  }
  function fijarPunto(lat, lon, texto) {
    puntoNuevo = { lat, lon };
    if (!marcaTemporal) marcaTemporal = L.marker([lat, lon], { icon: L.divIcon({ className: '', html: '<div class="marca-temporal"></div>', iconSize: [26, 26], iconAnchor: [13, 13] }), interactive: false });
    marcaTemporal.setLatLng([lat, lon]).addTo(mapa);
    $('agregarAyuda').textContent = texto;
    $('agForm').hidden = false;
    $('btnGuardarRadar').disabled = false;
    mapa.panTo([lat, lon]);
  }
  function cerrarAgregar() {
    agregando = false; puntoNuevo = null;
    if (marcaTemporal) { mapa.removeLayer(marcaTemporal); }
    $('hojaAgregar').hidden = true;
  }
  mapa.on('click', (e) => { if (agregando) fijarPunto(e.latlng.lat, e.latlng.lng, 'Punto marcado. Si está bien, completá los datos y guardá.'); });
  $('btnAquiEstoy').onclick = () => {
    if (posAnt) { fijarPunto(posAnt.lat, posAnt.lon, 'Usando tu posición actual.'); return; }
    if (!('geolocation' in navigator)) { toast('No hay GPS disponible.'); return; }
    $('agregarAyuda').textContent = 'Buscando tu posición…';
    navigator.geolocation.getCurrentPosition(
      (p) => { fijarPunto(p.coords.latitude, p.coords.longitude, 'Usando tu posición actual.'); mapa.setView([p.coords.latitude, p.coords.longitude], 17); },
      () => { $('agregarAyuda').textContent = 'No se pudo obtener tu posición. Tocá el mapa para marcarlo.'; },
      { enableHighAccuracy: true, timeout: 15000 }
    );
  };
  $('btnGuardarRadar').onclick = () => {
    if (!puntoNuevo) return;
    const vmax = parseInt($('agVmax').value, 10);
    const usaRumbo = posAnt && velActual > 10 && dist(posAnt.lat, posAnt.lon, puntoNuevo.lat, puntoNuevo.lon) < 30;
    propios.push({
      id: 'u' + Date.now(), lat: puntoNuevo.lat, lon: puntoNuevo.lon,
      tipo: $('agTipo').value, vmax: isNaN(vmax) ? null : vmax,
      dir: usaRumbo ? Math.round(rumboActual) : null,
      nombre: $('agNombre').value.trim(), fuente: 'usuario'
    });
    LS.set('radaresPropios', propios);
    $('agNombre').value = '';
    cerrarAgregar(); dibujarRadares();
    toast('Radar guardado en este celular.');
  };

  // ---------- Panel de ajustes ----------
  function cerrarHojas() { $('panel').hidden = true; if (agregando) cerrarAgregar(); }
  function cargarAjustesEnPanel() {
    $('ajAviso1').value = String(ajustes.aviso1);
    $('ajAviso2').value = String(ajustes.aviso2);
    $('ajTol').value = String(ajustes.tolerancia);
    $('ajVoz').checked = ajustes.voz;
    $('ajSonido').checked = ajustes.sonido;
    $('ajExceso').checked = ajustes.alarmaExceso;
    $('ajVerVel').checked = ajustes.verVelocidad;
    $('ajVerCam').checked = ajustes.verCamaras;
    $('ajVerOtros').checked = ajustes.verOtros;
    $('ajModo').value = ajustes.modoMapa;
  }
  function guardarAjustes() {
    ajustes.aviso1 = +$('ajAviso1').value;
    ajustes.aviso2 = Math.min(+$('ajAviso2').value, ajustes.aviso1);
    ajustes.tolerancia = +$('ajTol').value;
    ajustes.voz = $('ajVoz').checked;
    ajustes.sonido = $('ajSonido').checked;
    ajustes.alarmaExceso = $('ajExceso').checked;
    const antes = [ajustes.verVelocidad, ajustes.verCamaras, ajustes.verOtros].join();
    ajustes.verVelocidad = $('ajVerVel').checked;
    ajustes.verCamaras = $('ajVerCam').checked;
    ajustes.verOtros = $('ajVerOtros').checked;
    ajustes.modoMapa = $('ajModo').value;
    LS.set('ajustes', ajustes);
    if (antes !== [ajustes.verVelocidad, ajustes.verCamaras, ajustes.verOtros].join()) dibujarRadares();
    aplicarModoMapa();
  }
  ['ajAviso1', 'ajAviso2', 'ajTol', 'ajVoz', 'ajSonido', 'ajExceso', 'ajVerVel', 'ajVerCam', 'ajVerOtros', 'ajModo']
    .forEach((id) => $(id).addEventListener('change', guardarAjustes));

  $('btnMenu').onclick = () => {
    const abierto = !$('panel').hidden;
    cerrarHojas();
    if (!abierto) { cargarAjustesEnPanel(); actualizarResumen(); $('panel').hidden = false; }
  };
  $('btnAgregar').onclick = () => { if (agregando) cerrarAgregar(); else abrirAgregar(); };
  document.querySelectorAll('[data-cerrar]').forEach((b) => {
    b.onclick = () => { if (b.dataset.cerrar === 'hojaAgregar') cerrarAgregar(); else $(b.dataset.cerrar).hidden = true; };
  });
  $('btnActualizar').onclick = actualizarRadares;
  $('btnSimular').onclick = simular;
  $('btnRestaurar').onclick = () => {
    const n = ocultos.size; ocultos.clear(); LS.set('radaresOcultos', []); dibujarRadares();
    toast(n ? 'Se restauraron ' + n + ' radares.' : 'No había radares ocultos.');
  };
  $('btnProbarSonido').onclick = () => {
    pitido(2);
    setTimeout(() => hablar('Radar de velocidad a 250 metros. Máxima 60.'), 600);
  };
  $('btnViaje').onclick = () => { if (viajeActivo) terminarViaje(); else iniciarViaje(); };
  $('btnCentrar').onclick = () => {
    siguiendo = true; $('btnCentrar').hidden = true;
    if (posAnt) mapa.setView([posAnt.lat, posAnt.lon], Math.max(mapa.getZoom(), 15));
  };
  mapa.on('dragstart', () => { if (viajeActivo) { siguiendo = false; $('btnCentrar').hidden = false; } });

  // ---------- Inicio ----------
  $('version').textContent = VERSION;
  if (!LS.get('introVisto', false)) $('intro').hidden = false;
  $('btnIntroOk').onclick = () => { LS.set('introVisto', true); $('intro').hidden = true; };
  aplicarModoMapa();
  dibujarRadares();
  // Trae la lista del proyecto en segundo plano (no molesta si no hay conexión).
  bajarRepo().then(() => { base = baseCombinada(); dibujarRadares(); }, () => { /* sin conexión: se usan los datos guardados */ });

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* sin modo sin conexión */ });
  }

  // Exponer algunas funciones para pruebas automáticas.
  window.__radares = { onPos, parsearOSM, parsearCSVCaba, deduplicar, estado: () => ({ radares: radares.length, viajeActivo, velActual }) };
})();
