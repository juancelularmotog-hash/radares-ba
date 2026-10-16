/* Radares BA — app web de avisos de radares para CABA y Provincia de Buenos Aires.
   Todo corre en el celular: los datos y ajustes se guardan en el propio dispositivo.
   Dentro de la app de Android, los avisos con sonido los da el servicio nativo (funciona con la pantalla bloqueada). */
'use strict';
(function () {
  const VERSION = '2.0.8';
  // Lo que cambió en la app (se muestra en Novedades). La primera es la versión actual.
  const CAMBIOS_APP = [
    ['2.0.8', ['Peajes: te avisa solo los que vas a pagar. Los que cobran en tu mano y, si la cabina está en una subida o bajada, solo cuando entrás por ahí.',
      'En la ficha de cada peaje dice en qué mano cobra; si uno no cobra, lo podés ocultar.']],
    ['2.0.7', ['Las novedades tienen su propia pantalla: Menú › Novedades. Ahí también quedan las actualizaciones anteriores y los cambios de la app.']],
    ['2.0.6', ['Fotomultas de Berisso y tótems de AUBASA que multan en la Autopista Buenos Aires-La Plata.',
      'Radares de Provincia mal cargados, puestos en su lugar (la ficha lo aclara).',
      'Los lugares con un aparato por mano avisan en los dos sentidos.']],
    ['2.0.5', ['Fotomultas publicadas en diarios (en verde) y radares de la comunidad (en violeta), sin los que nadie revisa desde 2018.',
      'Botón para volver a tu ubicación cuando mirás otra parte del mapa.']],
    ['2.0.4', ['Radares autorizados por la ANSV en rutas nacionales.']],
    ['2.0.3', ['Listado oficial de radares de Provincia (Infracciones BA).']]
  ];
  const $ = (id) => document.getElementById(id);

  // ---------- Almacenamiento local seguro ----------
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* sin espacio o bloqueado */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* nada */ } }
  };

  const AJUSTES_DEF = {
    aviso1: 500, aviso2: 250, tolerancia: 5,
    voz: true, sonido: true, alarmaExceso: true, avisarPeajes: true,
    mostrarLimite: true, limiteAlarma: 'reales',
    verVelocidad: true, verCamaras: true, verOtros: true, verPeajes: true,
    rotarMapa: false, modoMapa: 'auto'
  };
  let ajustes = Object.assign({}, AJUSTES_DEF, LS.get('ajustes', {}));
  let repo = LS.get('datosRepo', null);      // radares.json del proyecto (se actualiza solo cada semana)
  let osmVivo = LS.get('datosOSM', null);    // consulta directa a OpenStreetMap desde el celular
  let cabaVivo = LS.get('datosCABA', null);  // descarga directa del dataset de CABA
  let propios = LS.get('radaresPropios', []);
  let ocultos = new Set(LS.get('radaresOcultos', []));
  let novedades = LS.get('novedades', null);
  let novedadesAnteriores = LS.get('novedadesAnteriores', []);

  const TIPOS = {
    velocidad: { nombre: 'Radar de velocidad', clase: 't-vel' },
    semaforo: { nombre: 'Cámara de semáforo', clase: 't-sem' },
    video: { nombre: 'Cámara de control', clase: 't-cam' },
    otro: { nombre: 'Control vial', clase: 't-otro' }
  };
  const FUENTES = { CABA: 'Gobierno de la Ciudad (oficial)', OSM: 'OpenStreetMap (comunidad)', ANSV: 'ANSV, rutas nacionales (oficial)', PBA: 'Provincia de Bs. As. (oficial)', prensa: 'Publicado en diarios (no oficial)', manual: 'Revisión manual', usuario: 'Agregado por vos' };
  const PRIORIDAD = { CABA: 3, ANSV: 3, PBA: 3, manual: 2, prensa: 2, OSM: 1, usuario: 0 };
  // Radares de OSM que nadie revisa desde este año o antes, o que los mapeadores marcaron como dudosos: no se usan.
  const OSM_VIEJO_HASTA = 2018;
  const OSM_DUDOSO = /exist|no hay|parece no|parecer[ií]a no|no se ve|no est[aá]|duda/i;
  const activo = (r) => r.estado !== 'en instalación';   // los que todavía no multan se muestran pero no avisan
  const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

  // ---------- App de Android (si existe el puente nativo) ----------
  const NATIVO = (window.RadaresAndroid && typeof window.RadaresAndroid === 'object') ? window.RadaresAndroid : null;
  function nat(metodo) {
    const args = Array.prototype.slice.call(arguments, 1);
    try { if (NATIVO && typeof NATIVO[metodo] === 'function') return NATIVO[metodo].apply(NATIVO, args); } catch (e) { /* nada */ }
    return undefined;
  }
  // En Android el sonido lo da el servicio nativo; en la simulación lo da la página.
  function audioWeb() { return !NATIVO || !!simulacion; }

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
  // Distancia (m) de un punto a un segmento y posición t (0..1) sobre él; aproximación plana para tramos cortos.
  function distSeg(lat, lon, a, b) {
    const k = Math.cos(rad(lat));
    const ax = (a[1] - lon) * 111320 * k, ay = (a[0] - lat) * 110540;
    const bx = (b[1] - lon) * 111320 * k, by = (b[0] - lat) * 110540;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2));
    return { d: Math.hypot(ax + t * dx, ay + t * dy), t };
  }
  const CARDINALES = ['norte', 'noreste', 'este', 'sureste', 'sur', 'suroeste', 'oeste', 'noroeste'];
  function cardinal(g) { return CARDINALES[Math.round(((g % 360) + 360) % 360 / 45) % 8]; }
  function redondear(d) { return d >= 100 ? Math.round(d / 50) * 50 : Math.max(10, Math.round(d / 10) * 10); }
  function formatoDist(d) { return d >= 1000 ? (d / 1000).toFixed(1).replace('.', ',') + ' km' : redondear(d) + ' m'; }
  function formatoKm(m) { const km = m / 1000; return km >= 100 ? Math.round(km) + ' km' : km.toFixed(1).replace('.', ',') + ' km'; }
  function formatoDuracion(s) { const min = Math.max(1, Math.round(s / 60)); if (min < 60) return min + ' min'; const h = Math.floor(min / 60), r = min % 60; return h + ' h' + (r ? ' ' + r + ' min' : ''); }
  function fechaCorta(d) { return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); }
  function conTiempo(ms) { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; }

  // ---------- Mapa ----------
  const mapa = L.map('mapa', { zoomControl: false, attributionControl: false, tap: false }).setView([-34.6037, -58.3816], 13);
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
    $('atrib').innerHTML = p.atrib + ' · <a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>';
    const opciones = { maxZoom: 20, maxNativeZoom: p.max, keepBuffer: 3 };
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

  // ---------- Mapa que gira con el auto ----------
  // El contenedor del mapa se agranda hasta la diagonal de la pantalla para que, al girar, no queden esquinas vacías.
  let rotGrados = 0, modoRot = false;
  function prepararRotacion() {
    const quiere = ajustes.rotarMapa && viajeActivo && !hudActivo;
    $('btnBrujula').classList.toggle('girando', ajustes.rotarMapa);
    if (quiere === modoRot) return;
    const c = mapa.getCenter(), z = mapa.getZoom();
    modoRot = quiere;
    const marco = $('mapaMarco');
    if (quiere) {
      marco.style.setProperty('--diag', (Math.ceil(Math.hypot(window.innerWidth, window.innerHeight)) + 8) + 'px');
      marco.classList.add('rotando');
    } else {
      marco.classList.remove('rotando');
      girarA(0, false);
    }
    mapa.invalidateSize({ pan: false, animate: false });
    mapa.setView(c, z, { animate: false });
  }
  function girarA(objetivo, suave) {
    const delta = (((objetivo - rotGrados) % 360) + 540) % 360 - 180;
    if (suave && Math.abs(delta) < 0.5) return;
    rotGrados += delta;
    const el = $('mapa');
    el.classList.toggle('suave', !!suave);
    el.style.transform = rotGrados ? 'rotate(' + rotGrados + 'deg)' : '';
    el.style.setProperty('--contra', (-rotGrados) + 'deg');
    $('brujulaAguja').style.transform = 'rotate(' + rotGrados + 'deg)';
  }
  window.addEventListener('resize', () => {
    if (modoRot) {
      $('mapaMarco').style.setProperty('--diag', (Math.ceil(Math.hypot(window.innerWidth, window.innerHeight)) + 8) + 'px');
      mapa.invalidateSize({ pan: false, animate: false });
    }
  });

  // ---------- Radares y peajes ----------
  const capaPeajes = L.layerGroup().addTo(mapa);
  const capaRadares = L.layerGroup().addTo(mapa);
  let radares = [];   // los visibles, con los que se dan los avisos
  let peajes = [];
  const estadoRadar = new Map();
  const estadoPeaje = new Map();

  // Un radar de OSM a menos de esto de uno oficial de Provincia o de la ANSV, y del mismo tipo, es el mismo
  // (igual que en el script).
  const RADIO_OFICIAL_PBA = 100;
  const conUbicacionOficial = (r) => r.fuente === 'PBA' || r.fuente === 'ANSV';
  const oficial = (r) => r.fuente === 'CABA' || conUbicacionOficial(r);
  function tiposCompatibles(a, b, flexible) {
    if (a === b || a === 'otro' || b === 'otro') return true;
    // Las cámaras de esquina figuran como "video" en CABA y como "semáforo" en OSM o en los diarios.
    return flexible && ((a === 'semaforo' && b === 'video') || (a === 'video' && b === 'semaforo'));
  }
  function mismoRadar(x, r) {
    if (!tiposCompatibles(x.tipo, r.tipo, oficial(x) || x.fuente === 'prensa')) return false;
    const d = dist(x.lat, x.lon, r.lat, r.lon);
    return d < 30 || (d < RADIO_OFICIAL_PBA && oficial(x) && (r.fuente === 'OSM' || r.fuente === 'prensa')) ||
      (d < 80 && x.fuente === 'prensa' && r.fuente === 'OSM') ||
      (d < 60 && x.fuente === 'ANSV' && r.fuente === 'PBA');
  }
  function deduplicar(lista) {
    const ordenada = lista.slice().sort((a, b) => (PRIORIDAD[b.fuente] || 0) - (PRIORIDAD[a.fuente] || 0));
    const res = [];
    const grilla = new Map();
    for (const r of ordenada) {
      if (typeof r.lat !== 'number' || typeof r.lon !== 'number' || isNaN(r.lat) || isNaN(r.lon)) continue;
      const cla = Math.round(r.lat * 2000), clo = Math.round(r.lon * 2000);
      let dup = null;
      for (let i = -3; i <= 3 && !dup; i++) for (let j = -3; j <= 3 && !dup; j++) {
        const celda = grilla.get((cla + i) + ':' + (clo + j));
        if (!celda) continue;
        dup = celda.find((x) => mismoRadar(x, r));
      }
      if (dup) {
        if (!dup.vmax && r.vmax) { dup.vmax = r.vmax; dup.vmaxFuente = r.vmaxFuente; }
        const mismoPunto = dist(dup.lat, dup.lon, r.lat, r.lon) < 30;
        if (mismoPunto && dup.dir != null && r.dir != null && difAng(dup.dir, r.dir) > 90) {
          // Un aparato por mano en el mismo lugar: queda uno que controla los dos sentidos (igual que en el script).
          dup.dir = null; delete dup.dirInferida; dup.sentido = 'ambos';
        } else if (dup.dir == null && r.dir != null && dup.sentido !== 'ambos' && !conUbicacionOficial(dup) &&
            dup.fuente !== 'prensa' && mismoPunto) {
          // El sentido solo se copia si es el mismo punto; Provincia y la ANSV informan el suyo y en los diarios no se sabe.
          dup.dir = r.dir; dup.dirInferida = r.dirInferida;
        }
        if (!dup.nombre && r.nombre) dup.nombre = r.nombre;
        continue;
      }
      const copia = Object.assign({}, r);
      res.push(copia);
      const k = cla + ':' + clo;
      if (!grilla.has(k)) grilla.set(k, []);
      grilla.get(k).push(copia);
    }
    return res;
  }
  function baseCombinada() {
    // Lo bajado de OSM con versiones anteriores de la app no trae la fecha de revisión: no se usa hasta volver a bajarlo.
    const osm = (osmVivo && (osmVivo.radares || []).some((r) => r.osmFecha)) ? osmVivo.radares : [];
    return deduplicar([].concat((repo && repo.radares) || [], (cabaVivo && cabaVivo.radares) || [], osm));
  }
  function peajesCombinados() {
    // Los de la lista del proyecto traen la mano en la que cobra cada uno (puede haber dos juntos, uno por mano).
    // Los bajados en vivo de OSM solo suman los que la lista todavía no tiene.
    const valido = (p) => typeof p.lat === 'number' && typeof p.lon === 'number' && !ocultos.has(p.id);
    const res = ((repo && repo.peajes) || []).filter(valido).map((p) => Object.assign({}, p));
    for (const p of (osmVivo && osmVivo.peajes) || []) {
      if (!valido(p)) continue;
      const igual = res.find((x) => dist(x.lat, x.lon, p.lat, p.lon) < 400);
      if (igual) { if (!igual.nombre && p.nombre) igual.nombre = p.nombre; continue; }
      res.push(Object.assign({}, p));
    }
    return res;
  }
  function popupPeaje(q) {
    const d = document.createElement('div'); d.className = 'pop';
    const s = document.createElement('strong'); s.textContent = q.ramal ? 'Peaje en un acceso' : 'Peaje';
    const n = document.createElement('div'); n.textContent = q.nombre || 'Estación de peaje';
    d.append(s, n);
    const linea = (txt, clase) => { const x = document.createElement('div'); if (clase) x.className = clase; x.textContent = txt; d.appendChild(x); };
    if (q.ramal) linea('Está en una subida o bajada: te avisa solo si entrás por ahí' + (q.destino ? ' (hacia ' + q.destino + ')' : '') + '.');
    if (q.dir != null) linea('Cobra a quienes van hacia el ' + cardinal(q.dir) + '.');
    else if (repo && Array.isArray(repo.peajes) && repo.peajes.some((x) => x.id === q.id)) linea('No se sabe en qué mano cobra: avisa en las dos.');
    linea('Fuente: OpenStreetMap (comunidad)', 'pop-f');
    const b = document.createElement('button'); b.className = 'btn-sec'; b.textContent = 'No cobra acá: ocultarlo';
    b.onclick = () => {
      ocultos.add(q.id); LS.set('radaresOcultos', [...ocultos]);
      mapa.closePopup(); dibujarRadares(); toast('Peaje ocultado. Lo podés restaurar desde el menú.');
    };
    d.appendChild(b);
    return d;
  }
  let base = baseCombinada();

  function idsNovedad() {
    if (!novedades || novedades.visto) return new Set();
    const edad = Date.now() - new Date(novedades.fecha).getTime();
    if (!(edad < 14 * 86400000)) return new Set();
    return new Set((novedades.nuevos || []).map((r) => r.id));
  }
  function visible(r) {
    if (ocultos.has(r.id)) return false;
    if (r.tipo === 'velocidad') return ajustes.verVelocidad;
    if (r.tipo === 'semaforo' || r.tipo === 'video') return ajustes.verCamaras;
    return ajustes.verOtros;
  }
  const tieneLimite = (r) => !!r.vmax && (r.tipo === 'velocidad' || r.tipo === 'otro');
  // Color según la fuente: oficiales como siempre, diarios en verde y comunidad (OSM) en violeta.
  const claseFuente = (r) => (r.fuente === 'prensa' ? ' f-prensa' : r.fuente === 'OSM' ? ' f-osm' : '') + (activo(r) ? '' : ' mk-inst');
  function iconoRadar(r, nuevo) {
    const t = TIPOS[r.tipo] || TIPOS.otro;
    const txt = r.tipo === 'semaforo' ? '<i></i><i></i><i></i>' : (tieneLimite(r) ? r.vmax : '');
    const clases = 'mk ' + t.clase + claseFuente(r) + (r.fuente === 'usuario' ? ' mk-propio' : '') + (r.vmaxFuente === 'estimado' && tieneLimite(r) ? ' estimado' : '') + (nuevo ? ' mk-nuevo' : '');
    return L.divIcon({ className: '', html: '<div class="' + clases + '">' + txt + '</div>', iconSize: [26, 26], iconAnchor: [13, 13] });
  }
  function dibujarRadares() {
    capaRadares.clearLayers();
    radares = base.concat(propios).filter(visible);
    const nuevos = idsNovedad();
    for (const r of radares) {
      L.marker([r.lat, r.lon], { icon: iconoRadar(r, nuevos.has(r.id)), keyboard: false }).bindPopup(() => popupRadar(r)).addTo(capaRadares);
    }
    capaPeajes.clearLayers();
    peajes = peajesCombinados();
    if (ajustes.verPeajes) {
      // Los de las subidas y bajadas, más chicos: solo importan si entrás por ahí.
      const icono = L.divIcon({ className: '', html: '<div class="peaje-mk"></div>', iconSize: [30, 14], iconAnchor: [15, 7] });
      const iconoRamal = L.divIcon({ className: '', html: '<div class="peaje-mk ramal"></div>', iconSize: [20, 10], iconAnchor: [10, 5] });
      for (const q of peajes) {
        L.marker([q.lat, q.lon], { icon: q.ramal ? iconoRamal : icono, keyboard: false }).bindPopup(() => popupPeaje(q)).addTo(capaPeajes);
      }
    }
    actualizarResumen();
    if (ruta) mostrarRuta(false);
    sincronizarNativo();
  }
  function textoLimite(r) {
    if (!tieneLimite(r)) return r.tipo === 'velocidad' ? 'Límite no informado' : '';
    if (r.vmaxFuente === 'estimado') return 'Máx. ' + r.vmax + ' km/h (estimado por tipo de calle)';
    if (r.vmaxFuente === 'calle') return 'Máx. ' + r.vmax + ' km/h (límite de la calle)';
    return 'Máx. ' + r.vmax + ' km/h';
  }
  function popupRadar(r) {
    const t = TIPOS[r.tipo] || TIPOS.otro;
    const div = document.createElement('div');
    div.className = 'pop';
    const s = document.createElement('strong'); s.textContent = t.nombre; div.appendChild(s);
    const n = document.createElement('div'); n.textContent = r.nombre || 'Sin descripción'; div.appendChild(n);
    if (r.detalle && r.detalle !== r.nombre) { const de = document.createElement('div'); de.className = 'pop-f'; de.textContent = r.detalle; div.appendChild(de); }
    const lim = textoLimite(r);
    if (lim) { const l = document.createElement('div'); l.textContent = lim; div.appendChild(l); }
    if (r.dir != null) {
      const o = document.createElement('div');
      o.textContent = 'Controla a quienes van hacia el ' + cardinal(r.dir) + (r.dirInferida ? ' (deducido por la mano de la calle)' : '');
      div.appendChild(o);
    } else if (r.sentido === 'ambos' && !/sentidos/.test(r.detalle || '')) {
      const o = document.createElement('div'); o.textContent = 'Controla los dos sentidos'; div.appendChild(o);
    }
    if (r.corregido) { const c = document.createElement('div'); c.className = 'pop-f'; c.textContent = 'Ubicación corregida: ' + r.corregido; div.appendChild(c); }
    if (!activo(r)) { const ins = document.createElement('div'); ins.className = 'pop-aviso'; ins.textContent = 'Todavía no multa: no te da aviso.'; div.appendChild(ins); }
    const f = document.createElement('div'); f.className = 'pop-f';
    f.textContent = 'Fuente: ' + (FUENTES[r.fuente] || r.fuente);
    if (r.fuente === 'OSM' && r.osmFecha) f.textContent += ' · revisado en ' + r.osmFecha.slice(0, 4);
    div.appendChild(f);
    if (r.fuente === 'prensa' && /^https:\/\//.test(r.url || '')) {
      const a = document.createElement('a'); a.className = 'pop-link'; a.href = r.url; a.target = '_blank'; a.rel = 'noopener';
      a.textContent = 'Ver la nota' + (r.fecha ? ' (' + r.fecha.split('-').reverse().join('/') + ')' : '');
      div.appendChild(a);
    }
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
        mapa.closePopup(); dibujarRadares(); toast('Radar ocultado. Lo podés restaurar desde el menú.');
      };
    }
    div.appendChild(b);
    return div;
  }

  // ---------- Descarga de datos ----------
  const URL_REPO = 'data/radares.json';
  const URL_CABA = 'https://cdn.buenosaires.gob.ar/datosabiertos/datasets/transporte-y-obras-publicas/camaras-fijas-control-vehicular/camaras-fijas-de-control-vehicular.csv';
  const CONSULTA_OSM = '[out:json][timeout:90];' +
    '(area["ISO3166-2"="AR-B"];area["ISO3166-2"="AR-C"];)->.a;' +
    '(node["highway"="speed_camera"](area.a);' +
    'node["enforcement"~"maxspeed|traffic_signals|average_speed"](area.a);' +
    'relation["type"="enforcement"]["enforcement"~"maxspeed|traffic_signals|average_speed"](area.a);' +
    'node["barrier"="toll_booth"](area.a););' +
    'out meta;>;out skel qt;';   // "meta" trae la fecha de la última edición de cada radar

  async function consultarOverpass(q, ms) {
    let ultimo = null;
    for (const url of OVERPASS) {
      try {
        const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: conTiempo(ms) });
        if (!r.ok) { const err = new Error('HTTP ' + r.status); err.status = r.status; throw err; }
        return await r.json();
      } catch (e) { ultimo = e; }
    }
    throw ultimo || new Error('sin respuesta');
  }

  function calcularNovedades(antes, despues) {
    const indice = (lista) => {
      const m = new Map();
      for (const r of lista) { const k = Math.round(r.lat * 1000) + ':' + Math.round(r.lon * 1000); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
      return m;
    };
    const mismoTipo = (x, r) => tiposCompatibles(x.tipo, r.tipo, true);
    // Un radar de OSM que pasó a ser uno oficial o de un diario, un poco corrido, es el mismo radar.
    const oficialODiario = (r) => oficial(r) || r.fuente === 'prensa';
    const oficialYOsm = (x, r) => (oficialODiario(x) && r.fuente === 'OSM') || (x.fuente === 'OSM' && oficialODiario(r));
    // El más cercano a menos de 40 m (si "tipo" es true, solo de un tipo compatible).
    const vecino = (m, r, tipo) => {
      const a = Math.round(r.lat * 1000), b = Math.round(r.lon * 1000);
      let mejor = null, dMejor = Infinity;
      for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
        for (const x of m.get((a + i) + ':' + (b + j)) || []) {
          if (tipo && !mismoTipo(x, r)) continue;
          const d = dist(x.lat, x.lon, r.lat, r.lon);
          const tope = tipo && oficialYOsm(x, r) ? RADIO_OFICIAL_PBA : 40;
          if (d < tope && d < dMejor) { dMejor = d; mejor = x; }
        }
      }
      return mejor;
    };
    const iA = indice(antes), iD = indice(despues);
    // Un radar nuevo en una esquina que ya tenía una cámara de otro tipo cuenta como nuevo;
    // si en el mismo lugar ahora hay otro tipo de control (por ejemplo, era una cámara de semáforo
    // mal cargada como radar), cuenta como "cambió de tipo" y no como quitado más uno nuevo.
    const sinIgual = antes.filter((r) => !vecino(iD, r, true));
    const cambiados = [], quitados = [];
    for (const r of sinIgual) {
      const ahora = vecino(iD, r, false);
      if (ahora) cambiados.push(Object.assign({}, r, { tipoNuevo: ahora.tipo })); else quitados.push(r);
    }
    const iC = indice(cambiados);
    const nuevos = despues.filter((r) => !vecino(iA, r, true) && !vecino(iC, r, false));
    return { nuevos, quitados, cambiados };
  }

  let avisarNovedades = false;
  async function bajarRepo() {
    const r = await fetch(URL_REPO + '?t=' + Date.now(), { cache: 'no-store', signal: conTiempo(20000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (!j || !Array.isArray(j.radares)) throw new Error('formato');
    const anterior = repo;
    repo = j; LS.set('datosRepo', repo);
    if (anterior && anterior.generado && j.generado && anterior.generado !== j.generado && Array.isArray(anterior.radares) && anterior.radares.length > 20) {
      const { nuevos, quitados, cambiados } = calcularNovedades(anterior.radares, j.radares);
      if (nuevos.length || quitados.length || cambiados.length) {
        // La anterior pasa a "Actualizaciones anteriores" (las últimas 5, con menos detalle para no llenar el celular).
        if (hayCambios(novedades)) {
          const recorte = (l) => (l || []).slice(0, 60);
          novedadesAnteriores = [Object.assign({}, novedades, { nuevos: recorte(novedades.nuevos), quitados: recorte(novedades.quitados), cambiados: recorte(novedades.cambiados) })]
            .concat(novedadesAnteriores).slice(0, 5);
          LS.set('novedadesAnteriores', novedadesAnteriores);
        }
        const corto = (x) => ({ id: x.id, lat: x.lat, lon: x.lon, tipo: x.tipo, tipoNuevo: x.tipoNuevo, vmax: x.vmax || null, nombre: x.nombre || '', fuente: x.fuente || '' });
        novedades = {
          fecha: j.generado, nuevos: nuevos.slice(0, 300).map(corto), quitados: quitados.slice(0, 300).map(corto), cambiados: cambiados.slice(0, 300).map(corto),
          totalNuevos: nuevos.length, totalQuitados: quitados.length, totalCambiados: cambiados.length, visto: false, abierto: false
        };
        LS.set('novedades', novedades);
        avisarNovedades = true;
      }
    }
    return j.radares.length;
  }

  function parseVmax(v) { const m = /^\s*(\d{1,3})\s*(mph)?/i.exec(v || ''); if (!m) return null; let n = +m[1]; if (m[2]) n = Math.round(n * 1.609); return n >= 5 && n <= 150 ? n : null; }
  function parseDir(v) {
    if (v == null) return null;
    const n = parseFloat(v);
    if (!isNaN(n) && /^\s*-?\d/.test(String(v))) return ((n % 360) + 360) % 360;
    const p = { N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5, S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5 };
    const k = String(v).toUpperCase().trim();
    return k in p ? p[k] : null;
  }
  function osmDescartado(t, fecha) {
    const anio = parseInt(String(fecha || '').slice(0, 4), 10);
    return (anio && anio <= OSM_VIEJO_HASTA) || OSM_DUDOSO.test(String(t.fixme || t.FIXME || ''));
  }
  function radarOSM(t, lat, lon, id, fecha) {
    const enf = String(t.enforcement || '').toLowerCase();
    let tipo = 'velocidad';
    if (enf.includes('traffic_signals')) tipo = 'semaforo';
    else if (enf && !enf.includes('maxspeed') && !enf.includes('average_speed') && t.highway !== 'speed_camera') tipo = 'otro';
    // Hay cámaras de semáforo o de carril cargadas como radar de velocidad; la descripción lo aclara.
    const texto = [t.name, t.description, t.note].filter(Boolean).join(' ');
    if (tipo === 'velocidad' && !/velocidad|cinem[oó]metro|radar/i.test(texto)) {
      if (/luz roja|sem[aá]foro|senda peatonal/i.test(texto)) tipo = 'semaforo';
      else if (/carril/i.test(texto)) tipo = 'otro';
    }
    const r = { id: 'osm-' + id, lat, lon, tipo, vmax: parseVmax(t.maxspeed), dir: parseDir(t.direction), nombre: t.name || t.ref || t.description || '', fuente: 'OSM' };
    if (t.description) r.detalle = String(t.description).slice(0, 120);
    if (fecha) r.osmFecha = String(fecha).slice(0, 10);
    return r;
  }
  function agruparPeajes(puntos) {
    const grupos = [];
    for (const p of puntos) {
      const g = grupos.find((x) => x.some((q) => dist(q.lat, q.lon, p.lat, p.lon) < 300));
      if (g) g.push(p); else grupos.push([p]);
    }
    return grupos.map((g) => ({
      id: 'peaje-' + g[0].id,
      lat: g.reduce((s, p) => s + p.lat, 0) / g.length,
      lon: g.reduce((s, p) => s + p.lon, 0) / g.length,
      nombre: (g.find((p) => p.nombre) || {}).nombre || ''
    }));
  }
  function parsearOSM(j) {
    const nodos = new Map(), out = [], puntosPeaje = [];
    for (const e of j.elements || []) if (e.type === 'node') nodos.set(e.id, e);
    for (const e of j.elements || []) {
      if (e.type !== 'node' || !e.tags) continue;
      if (e.tags.barrier === 'toll_booth') puntosPeaje.push({ id: 'n' + e.id, lat: e.lat, lon: e.lon, nombre: e.tags.name || e.tags.operator || '' });
      else if ((e.tags.highway === 'speed_camera' || e.tags.enforcement) && !osmDescartado(e.tags, e.timestamp)) out.push(radarOSM(e.tags, e.lat, e.lon, 'n' + e.id, e.timestamp));
    }
    for (const e of j.elements || []) {
      if (e.type !== 'relation' || !e.tags) continue;
      const m = e.members || [];
      const dev = m.find((x) => x.role === 'device' && x.type === 'node');
      const desde = m.find((x) => x.role === 'from' && x.type === 'node');
      const n = (dev && nodos.get(dev.ref)) || (desde && nodos.get(desde.ref));
      if (!n || n.lat == null) continue;
      const fecha = [e.timestamp, n.timestamp].filter(Boolean).sort().pop();
      const t = Object.assign({}, n.tags || {}, e.tags);
      if (!osmDescartado(t, fecha)) out.push(radarOSM(t, n.lat, n.lon, 'r' + e.id, fecha));
    }
    return { radares: out, peajes: agruparPeajes(puntosPeaje) };
  }
  async function bajarOSM() {
    const res = parsearOSM(await consultarOverpass(CONSULTA_OSM, 100000));
    osmVivo = { fecha: new Date().toISOString(), radares: res.radares, peajes: res.peajes };
    LS.set('datosOSM', osmVivo);
    return res.radares.length;
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

  function recalcularBase() {
    base = baseCombinada();
    estadoRadar.clear();
    dibujarRadares();
    mostrarNovedades();
    if (avisarNovedades) {
      avisarNovedades = false;
      if (!$('panel').hidden || !$('hojaNovedades').hidden) return; // ya se ven en el menú o en Novedades
      const n = novedades.totalNuevos || 0;
      toast('Novedades en los radares: ' + textoNovedades(novedades) + '.' + (n ? ' Los nuevos se marcan en el mapa.' : '') + ' Las ves en Menú › Novedades.', 9000);
    }
  }
  const hayCambios = (nv) => !!(nv && (nv.totalNuevos || nv.totalQuitados || nv.totalCambiados));
  // "3 radares nuevos, 2 que ya no están y 5 que cambiaron de tipo"
  function textoNovedades(nv) {
    const n = nv.totalNuevos || 0, q = nv.totalQuitados || 0, c = nv.totalCambiados || 0;
    const partes = [];
    // La primera parte lleva el sustantivo ("2 radares que ya no están"); las siguientes no hace falta.
    const sust = (k) => (partes.length ? '' : (k === 1 ? ' radar' : ' radares'));
    if (n) partes.push(n + (n === 1 ? ' radar nuevo' : ' radares nuevos'));
    if (q) partes.push(q + sust(q) + (q === 1 ? ' que ya no está' : ' que ya no están'));
    if (c) partes.push(c + sust(c) + (c === 1 ? ' que cambió de tipo' : ' que cambiaron de tipo'));
    return partes.length > 1 ? partes.slice(0, -1).join(', ') + ' y ' + partes[partes.length - 1] : (partes[0] || 'sin cambios');
  }

  let actualizando = false;
  async function actualizarRadares() {
    if (actualizando) return;
    actualizando = true;
    const btn = $('btnActualizar');
    btn.disabled = true; btn.textContent = 'Actualizando…';
    $('estadoAct').textContent = 'Descargando radares y peajes. Puede tardar hasta un minuto.';
    const partes = [];
    await Promise.all([
      bajarRepo().then((n) => partes.push('lista del proyecto: ' + n), () => partes.push('lista del proyecto: sin conexión')),
      bajarCABA().then((n) => partes.push('CABA oficial: ' + n), () => { /* el sitio de CABA puede bloquear la descarga directa; la lista del proyecto la trae igual */ }),
      bajarOSM().then((n) => partes.push('OpenStreetMap: ' + n), () => partes.push('OpenStreetMap: no respondió'))
    ]);
    LS.set('ultimaActualizacion', new Date().toISOString());
    btn.disabled = false; btn.textContent = 'Actualizar radares';
    actualizando = false;
    const hayNovedades = avisarNovedades;
    recalcularBase();
    $('estadoAct').textContent = 'Listo. ' + partes.join(' · ') + '.' + (hayNovedades ? ' Hay novedades: tocá «Novedades», arriba de todo.' : '');
    if (!hayNovedades) toast('Radares actualizados: ' + base.length + ' radares y ' + peajes.length + ' peajes.');
  }

  function actualizarResumen() {
    const cuenta = { CABA: 0, PBA: 0, ANSV: 0, prensa: 0, OSM: 0, otros: 0 };
    for (const r of base) {
      if (r.fuente in cuenta && r.fuente !== 'otros') cuenta[r.fuente]++; else cuenta.otros++;
    }
    const caja = $('resumen');
    caja.textContent = '';
    const items = [[base.length + propios.length, 'radares'], [cuenta.CABA, 'CABA oficial'], [cuenta.PBA, 'Provincia oficial'],
      [cuenta.ANSV, 'ANSV oficial'], [cuenta.prensa, 'diarios'], [cuenta.OSM, 'comunidad'], [peajes.length, 'peajes']];
    if (propios.length) items.push([propios.length, 'tuyos']);
    for (const [n, t] of items) {
      const d = document.createElement('div');
      const b = document.createElement('b'); b.textContent = n;
      const s = document.createElement('span'); s.textContent = t;
      d.append(b, s); caja.appendChild(d);
    }
    const u = LS.get('ultimaActualizacion', null);
    const fr = repo && repo.generado ? new Date(repo.generado) : null;
    let txt = u ? 'Última actualización en este celular: ' + fechaCorta(new Date(u)) + '.' : 'Los radares se actualizan solos. Con este botón forzás una actualización.';
    if (fr && !isNaN(fr)) txt += ' Lista del proyecto generada el ' + fechaCorta(fr) + '.';
    if (ocultos.size) txt += ' Ocultos por vos: ' + ocultos.size + '.';
    if (!$('btnActualizar').disabled) $('estadoAct').textContent = txt;
  }

  // ---------- Novedades: pantalla propia (Menú › Novedades); en el menú queda solo la entrada ----------
  const fechaNov = (nv) => { const f = new Date(nv.fecha); return isNaN(f) ? '' : f.toLocaleDateString('es-AR'); };
  const versionSinVer = () => LS.get('versionVista', null) !== VERSION;
  const novedadSinVer = () => hayCambios(novedades) && !novedades.abierto;
  // Entrada del menú y puntito amarillo cuando hay algo que todavía no miraste.
  function mostrarNovedades() {
    const sinVer = novedadSinVer() || versionSinVer();
    $('puntoMenu').hidden = !sinVer;
    $('puntoNovedades').hidden = !sinVer;
    let txt = 'Lo último que cambió en los radares y en la app';
    if (novedadSinVer()) txt = 'Actualización del ' + fechaNov(novedades) + ': ' + textoNovedades(novedades);
    else if (versionSinVer()) txt = 'Nueva versión ' + VERSION + ': mirá qué cambió';
    else if (hayCambios(novedades)) txt = 'Última actualización (' + fechaNov(novedades) + '): ' + textoNovedades(novedades);
    $('novedadesResumen').textContent = txt;
    if (!$('hojaNovedades').hidden) llenarNovedades();
  }
  function marcadorMini(x) {
    const t = TIPOS[x.tipo] || TIPOS.otro;
    const m = document.createElement('span');
    m.className = 'mk mini ' + t.clase + (x.fuente === 'prensa' ? ' f-prensa' : x.fuente === 'OSM' ? ' f-osm' : '');
    if (x.tipo === 'semaforo') m.innerHTML = '<i></i><i></i><i></i>';
    return m;
  }
  // Listas de una actualización: nuevos, los que ya no están y los que cambiaron de tipo.
  function listasNovedad(nv, caja, max) {
    const nombreTipo = (t) => (TIPOS[t] || TIPOS.otro).nombre;
    const grupos = [['nuevos', 'totalNuevos', 'Nuevos', 'nuevo'], ['quitados', 'totalQuitados', 'Ya no están', 'quitado'], ['cambiados', 'totalCambiados', 'Cambiaron de tipo', 'cambio']];
    for (const [k, kt, titulo, clase] of grupos) {
      const lista = nv[k] || [];
      if (!lista.length) continue;
      const h = document.createElement('h4'); h.className = 'nov-grupo'; h.textContent = titulo + ' (' + (nv[kt] || lista.length) + ')';
      const ol = document.createElement('ol'); ol.className = 'lista-ruta lista-nov';
      for (const x of lista.slice(0, max)) {
        const li = document.createElement('li');
        const b = document.createElement('button'); b.type = 'button';
        const icono = marcadorMini(clase === 'cambio' ? Object.assign({}, x, { tipo: x.tipoNuevo }) : x);
        if (clase === 'quitado') icono.classList.add('mk-inst');
        const ico = document.createElement('span'); ico.className = 'ico'; ico.appendChild(icono);
        const d = document.createElement('span'); d.className = 'det';
        d.textContent = clase === 'cambio' ? nombreTipo(x.tipo) + ' → ' + nombreTipo(x.tipoNuevo) : nombreTipo(x.tipo) + (x.vmax ? ' · máx. ' + x.vmax : '');
        const sm = document.createElement('small'); sm.textContent = x.nombre || 'Sin descripción'; d.appendChild(sm);
        b.append(ico, d);
        b.onclick = () => { cerrarHojas(); irA(x.lat, x.lon, 17); if (clase === 'quitado') marcaQuitado(x); };
        li.appendChild(b); ol.appendChild(li);
      }
      const resto = (nv[kt] || lista.length) - Math.min(lista.length, max);
      caja.append(h, ol);
      if (resto > 0) { const p = document.createElement('p'); p.className = 'nota'; p.textContent = 'Y ' + resto + ' más.'; caja.appendChild(p); }
    }
  }
  function llenarNovedades() {
    const caja = $('novedadesListas');
    caja.textContent = '';
    if (hayCambios(novedades)) {
      $('novedadesTxt').textContent = 'Actualización del ' + fechaNov(novedades) + ': ' + textoNovedades(novedades) + '.' +
        (novedades.totalNuevos && !novedades.visto ? ' Los nuevos se resaltan en amarillo en el mapa durante dos semanas.' : '') +
        ' Tocá uno para verlo en el mapa.';
      listasNovedad(novedades, caja, 150);
    } else {
      const fr = repo && repo.generado ? new Date(repo.generado) : null;
      $('novedadesTxt').textContent = 'Todavía no hubo cambios desde que usás la app.' +
        (fr && !isNaN(fr) ? ' La lista se revisa todas las semanas; la última es del ' + fr.toLocaleDateString('es-AR') + '.' : ' La lista se revisa todas las semanas.');
    }
    $('btnNovedadesVistas').hidden = !(hayCambios(novedades) && novedades.totalNuevos && !novedades.visto);
    // Actualizaciones anteriores, plegadas.
    const ant = $('novedadesAnteriores');
    ant.textContent = '';
    for (const nv of novedadesAnteriores.filter(hayCambios)) {
      const det = document.createElement('details'); det.className = 'nov-ant';
      const s = document.createElement('summary'); s.textContent = fechaNov(nv) + ': ' + textoNovedades(nv);
      det.appendChild(s);
      listasNovedad(nv, det, 60);
      ant.appendChild(det);
    }
    $('bloqueNovAnteriores').hidden = !ant.children.length;
    // Cambios en la app: las últimas tres versiones a la vista y las demás plegadas.
    const cam = $('cambiosApp');
    cam.textContent = '';
    const version = ([v, items], caja) => {
      const div = document.createElement('div'); div.className = 'cambio-app';
      const t = document.createElement('b'); t.textContent = 'Versión ' + v + (v === VERSION ? ' (la que tenés)' : '');
      const ul = document.createElement('ul');
      for (const it of items) { const li = document.createElement('li'); li.textContent = it; ul.appendChild(li); }
      div.append(t, ul); caja.appendChild(div);
    };
    // En la app de Android vieja, los avisos con la pantalla bloqueada no saben de manos ni de ramales.
    $('bloqueActualizarApk').hidden = !(NATIVO && !peajesConSentido());
    if (NATIVO) $('linkApkNueva').href = urlApk();
    CAMBIOS_APP.slice(0, 3).forEach((c) => version(c, cam));
    if (CAMBIOS_APP.length > 3) {
      const det = document.createElement('details'); det.className = 'nov-ant';
      const s = document.createElement('summary'); s.textContent = 'Versiones anteriores';
      det.appendChild(s);
      CAMBIOS_APP.slice(3).forEach((c) => version(c, det));
      cam.appendChild(det);
    }
  }
  function abrirNovedades() {
    cerrarHojas();
    llenarNovedades();
    $('hojaNovedades').hidden = false;
    $('hojaNovedades').scrollTop = 0;
    // Abrir la pantalla cuenta como visto (el resaltado del mapa sigue hasta que lo saques o pasen dos semanas).
    if (novedades && hayCambios(novedades) && !novedades.abierto) { novedades.abierto = true; LS.set('novedades', novedades); }
    LS.set('versionVista', VERSION);
    mostrarNovedades();
  }
  let capaQuitado = null;
  function marcaQuitado(x) {
    if (capaQuitado) mapa.removeLayer(capaQuitado);
    capaQuitado = L.marker([x.lat, x.lon], { icon: L.divIcon({ className: '', html: '<div class="marca-temporal"></div>', iconSize: [26, 26], iconAnchor: [13, 13] }), interactive: false }).addTo(mapa);
    setTimeout(() => { if (capaQuitado) { mapa.removeLayer(capaQuitado); capaQuitado = null; } }, 15000);
  }

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
    else if (n === 3) { for (let i = 0; i < 3; i++) tono(1480, i * 0.17, 0.12, 0.4); }
    else { tono(520, 0, 0.18, 0.35); tono(520, 0.26, 0.18, 0.35); }
  }
  function vozEs() {
    if (!('speechSynthesis' in window)) return null;
    const vs = speechSynthesis.getVoices();
    return vs.find((v) => /es[-_]AR/i.test(v.lang)) || vs.find((v) => /es[-_](US|MX|419)/i.test(v.lang)) || vs.find((v) => /^es/i.test(v.lang)) || null;
  }
  function hablar(txt) {
    if (NATIVO) { nat('hablar', txt); return; }
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
  let tAlerta = null, tToast = null, tHudAviso = null;
  function mostrarAlerta(txt, tipo, corto) {
    const a = $('alerta');
    $('alertaTxt').textContent = txt;
    a.classList.toggle('fuerte', tipo === 'fuerte');
    a.classList.toggle('peaje', tipo === 'peaje');
    a.hidden = false;
    clearTimeout(tAlerta);
    tAlerta = setTimeout(() => { a.hidden = true; }, tipo === 'fuerte' ? 6000 : 4500);
    if (hudActivo) {
      $('hudAviso').textContent = corto || txt;
      clearTimeout(tHudAviso);
      tHudAviso = setTimeout(() => { $('hudAviso').textContent = ''; }, 6000);
    }
  }
  function ocultarToast() { clearTimeout(tToast); $('toast').hidden = true; }
  $('toast').addEventListener('click', ocultarToast);
  function toast(txt, ms) {
    const t = $('toast');
    t.textContent = txt; t.hidden = false;
    clearTimeout(tToast);
    tToast = setTimeout(() => { t.hidden = true; }, ms || 3500);
  }

  // ---------- Límite de la calle ----------
  // Se descargan de OpenStreetMap las calles de cuadrados de ~1 km a medida que avanzás.
  const CLASES_RE = '^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|road)(_link)?$';
  const TAM_CELDA = 0.01;
  const celdas = new Map();
  let pidiendoCelda = false, pausaCeldasHasta = 0;
  let calleActual = null, calleCandidata = null, cuentaCandidata = 0, sinCalle = 0, limiteActual = null;
  let excesoCalleDesde = 0, ultimaAlarmaCalle = 0;

  function estimarLimite(highway, urbano) {
    const h = String(highway || '').replace('_link', '');
    if (urbano) {
      if (h === 'living_street') return 20;
      if (h === 'residential' || h === 'unclassified' || h === 'road') return 40;
      if (h === 'primary' || h === 'secondary' || h === 'tertiary') return 60;
      return null;
    }
    if (h === 'motorway') return 130;
    if (h === 'trunk' || h === 'primary' || h === 'secondary') return 110;
    return null;
  }
  async function pedirCelda(cy, cx) {
    const k = cy + ':' + cx;
    if (celdas.has(k) || pidiendoCelda || Date.now() < pausaCeldasHasta) return;
    pidiendoCelda = true;
    const s = (cy * TAM_CELDA).toFixed(4), w = (cx * TAM_CELDA).toFixed(4), n = ((cy + 1) * TAM_CELDA).toFixed(4), e = ((cx + 1) * TAM_CELDA).toFixed(4);
    const q = '[out:json][timeout:25];way["highway"~"' + CLASES_RE + '"](' + s + ',' + w + ',' + n + ',' + e + ');out tags geom;';
    try {
      const j = await consultarOverpass(q, 30000);
      const calles = [];
      let resid = 0;
      for (const el of j.elements || []) {
        if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
        const t = el.tags || {};
        if (t.highway === 'residential') resid++;
        const g = el.geometry.map((p) => [p.lat, p.lon]);
        let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
        for (const pt of g) { if (pt[0] < a) a = pt[0]; if (pt[1] < b) b = pt[1]; if (pt[0] > c) c = pt[0]; if (pt[1] > d) d = pt[1]; }
        calles.push({
          id: el.id, g, caja: [a, b, c, d],
          t: { highway: t.highway, name: t.name, ref: t.ref, maxspeed: t.maxspeed, fw: t['maxspeed:forward'], bw: t['maxspeed:backward'], oneway: t.oneway, junction: t.junction }
        });
      }
      celdas.set(k, { calles, urbano: resid >= 15 });
      if (celdas.size > 48) celdas.delete(celdas.keys().next().value);
    } catch (e) {
      pausaCeldasHasta = Date.now() + (e && e.status === 429 ? 60000 : 15000);
    } finally {
      pidiendoCelda = false;
    }
  }
  function buscarCalle(p) {
    const cy = Math.floor(p.lat / TAM_CELDA), cx = Math.floor(p.lon / TAM_CELDA);
    pedirCelda(cy, cx);
    if (rumboActual != null && celdas.has(cy + ':' + cx)) {
      const adelante = destino(p.lat, p.lon, rumboActual, 700);
      pedirCelda(Math.floor(adelante[0] / TAM_CELDA), Math.floor(adelante[1] / TAM_CELDA));
    }
    const umbral = Math.min(40, Math.max(18, (p.precision || 15) + 8));
    const margen = umbral / 111000 * 1.5;
    const usarRumbo = rumboActual != null && velActual > 6;
    let mejor = null;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const cel = celdas.get((cy + i) + ':' + (cx + j));
      if (!cel) continue;
      for (const c of cel.calles) {
        const caja = c.caja;
        if (p.lat < caja[0] - margen || p.lat > caja[2] + margen || p.lon < caja[1] - margen * 1.3 || p.lon > caja[3] + margen * 1.3) continue;
        for (let s = 0; s < c.g.length - 1; s++) {
          const dd = distSeg(p.lat, p.lon, c.g[s], c.g[s + 1]).d;
          if (dd > umbral) continue;
          let ang = 0, ida = true;
          if (usarRumbo) {
            const sb = rumbo(c.g[s][0], c.g[s][1], c.g[s + 1][0], c.g[s + 1][1]);
            const aIda = difAng(sb, rumboActual), aVuelta = difAng((sb + 180) % 360, rumboActual);
            const unica = c.t.oneway === 'yes' || c.t.oneway === '1' || c.t.oneway === 'true' || c.t.junction === 'roundabout';
            if (unica) ang = aIda;
            else if (c.t.oneway === '-1') { ang = aVuelta; ida = false; }
            else { ida = aIda <= aVuelta; ang = Math.min(aIda, aVuelta); }
            if (ang > 50) continue;
          }
          const puntaje = dd + ang * 0.4;
          if (!mejor || puntaje < mejor.puntaje) mejor = { calle: c, urbano: cel.urbano, puntaje, ida };
        }
      }
    }
    return mejor;
  }
  function limiteDe(m) {
    const t = m.calle.t;
    const real = parseVmax(m.ida ? t.fw : t.bw) || parseVmax(t.maxspeed);
    if (real) return { v: real, estimado: false };
    const est = estimarLimite(t.highway, m.urbano);
    return est ? { v: est, estimado: true } : null;
  }
  function actualizarCalle(p) {
    if (!ajustes.mostrarLimite && ajustes.limiteAlarma === 'no') { calleActual = null; limiteActual = null; mostrarCalle(); return; }
    const m = buscarCalle(p);
    if (m) {
      sinCalle = 0;
      if (calleActual && m.calle.id !== calleActual.calle.id) {
        if (calleCandidata && calleCandidata.calle.id === m.calle.id) cuentaCandidata++;
        else { calleCandidata = m; cuentaCandidata = 1; }
        if (cuentaCandidata >= 2) { calleActual = m; calleCandidata = null; }
      } else {
        calleActual = m; calleCandidata = null;
      }
    } else if (++sinCalle >= 3) {
      calleActual = null;
    }
    limiteActual = calleActual ? limiteDe(calleActual) : null;
    mostrarCalle();
    chequearLimiteCalle();
  }
  function mostrarCalle() {
    const s = $('senalCalle');
    if (viajeActivo && ajustes.mostrarLimite && limiteActual) {
      s.hidden = false;
      $('limCalle').textContent = limiteActual.v;
      s.classList.toggle('estimado', limiteActual.estimado);
      s.title = limiteActual.estimado ? 'Límite estimado por tipo de calle' : 'Límite de la calle';
    } else s.hidden = true;
    const n = $('calleNombre');
    const nombre = calleActual && (calleActual.calle.t.name || calleActual.calle.t.ref);
    if (viajeActivo && nombre) { n.hidden = false; n.textContent = nombre; } else n.hidden = true;
  }
  function chequearLimiteCalle() {
    const hud = $('hudVel');
    const lim = limiteActual;
    const excede = !!(viajeActivo && lim && velActual > lim.v + ajustes.tolerancia);
    hud.classList.toggle('exceso-calle', excede && !lim.estimado);
    hud.classList.toggle('exceso-est', excede && lim.estimado);
    const alarma = ajustes.limiteAlarma === 'todos' || (ajustes.limiteAlarma === 'reales' && lim && !lim.estimado);
    if (excede && alarma) {
      if (!excesoCalleDesde) excesoCalleDesde = Date.now();
      if (Date.now() - excesoCalleDesde > 3000 && Date.now() - ultimaAlarmaCalle > 10000) {
        ultimaAlarmaCalle = Date.now();
        if (ajustes.sonido) pitido(4);
      }
    } else excesoCalleDesde = 0;
  }

  // ---------- Posición y viaje ----------
  let viajeActivo = false, watchId = null, wakeLock = null, posAnt = null, rumboActual = null, velActual = 0;
  let siguiendo = true, simulacion = null, ultimaFix = 0, fueAlFondo = false, primeraFix = true, proximo = null;
  const marcadorAuto = L.marker([-34.6, -58.4], {
    icon: L.divIcon({ className: '', html: '<div class="auto sin-rumbo" id="autoIcono"><svg viewBox="0 0 40 40" aria-hidden="true"><path d="M20 3 L33 35 L20 28 L7 35 Z"/></svg></div>', iconSize: [40, 40], iconAnchor: [20, 20] }),
    interactive: false, keyboard: false, zIndexOffset: 1000
  });
  let autoVisible = false, autoGrados = 0;

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
    if (ic && rumboActual != null) {
      autoGrados += (((rumboActual - autoGrados) % 360) + 540) % 360 - 180;
      ic.classList.remove('sin-rumbo'); ic.style.transform = 'rotate(' + autoGrados + 'deg)';
    }
    if (modoRot) girarA(siguiendo && rumboActual != null && !agregando ? -rumboActual : 0, true);
    centrar(p);
    evaluarRadares(p);
    evaluarPeajes(p);
    actualizarCalle(p);
    actualizarHud();
  }
  function centrar(p) {
    if (!siguiendo || hudActivo) return;
    let lat = p.lat, lon = p.lon;
    if (modoRot && rumboActual != null) {
      // Con el mapa girando, el auto queda más abajo para ver más camino adelante.
      const z = primeraFix ? 16 : mapa.getZoom();
      const mpp = 156543.03392 * Math.cos(rad(p.lat)) / Math.pow(2, z);
      const ad = destino(p.lat, p.lon, rumboActual, window.innerHeight * 0.2 * mpp);
      lat = ad[0]; lon = ad[1];
    }
    if (primeraFix) { mapa.setView([lat, lon], 16, { animate: false }); primeraFix = false; }
    else mapa.panTo([lat, lon], { animate: true, duration: 0.8 });
  }

  function evaluarRadares(p) {
    let mejor = null;
    for (const r of radares) {
      if (!activo(r)) continue;
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
    proximo = mejor;
    mostrarProximo(mejor);
    chequearExceso(mejor);
  }
  function aviso(r, d, nivel) {
    const t = TIPOS[r.tipo] || TIPOS.otro;
    const lim = tieneLimite(r) ? (r.vmaxFuente === 'estimado' ? '. Máxima probable ' : '. Máxima ') + r.vmax : '';
    const txt = t.nombre + ' a ' + redondear(d) + ' metros' + lim;
    const excede = tieneLimite(r) && velActual > r.vmax + ajustes.tolerancia;
    const corto = (r.tipo === 'semaforo' ? 'SEMÁFORO' : r.tipo === 'video' ? 'CÁMARA' : 'RADAR') + ' A ' + redondear(d) + ' M';
    mostrarAlerta(txt, (nivel === 2 || excede) ? 'fuerte' : '', corto);
    if (!audioWeb()) return;
    if (ajustes.sonido) pitido(nivel);
    if (ajustes.voz && (nivel === 2 || !ajustes.sonido)) hablar(txt + (excede ? '. Bajá la velocidad.' : ''));
    if (navigator.vibrate) { try { navigator.vibrate(nivel === 2 ? [200, 100, 200] : 150); } catch (e) { /* nada */ } }
  }
  // Distancia a la línea más cercana que va en tu mismo sentido.
  function distLineas(p, lineas, rb) {
    let mejor = Infinity;
    for (const t of lineas || []) {
      for (let i = 0; i + 1 < t.length; i++) {
        if (difAng(rumbo(t[i][0], t[i][1], t[i + 1][0], t[i + 1][1]), rb) > 50) continue;
        const d = distSeg(p.lat, p.lon, t[i], t[i + 1]).d;
        if (d < mejor) mejor = d;
      }
    }
    return mejor;
  }
  // Si vas por el ramal que lleva a la cabina: cerca de uno de sus tramos, en su mismo sentido, y más cerca de
  // él que de los otros caminos que salen de donde se abre (si no, todavía podés irte por el otro lado).
  function enTramoPeaje(p, q, rb) {
    if (rb == null || !Array.isArray(q.tramo)) return false;
    const d = distLineas(p, q.tramo, rb);
    return d <= 25 && d + 3 < distLineas(p, q.otros, rb);
  }
  // Solo avisa los peajes por los que vas a pasar: los que cobran en tu mano y, si la cabina está en una
  // subida o bajada (ramal), solo cuando ya estás en ese ramal.
  function vasAPasarPorPeaje(p, q, d) {
    if (rumboActual == null) return false;
    // En los ramales el camino puede dar la vuelta (rulos): cuenta el sentido de cada tramo, no el de la cabina.
    if (q.ramal) return enTramoPeaje(p, q, rumboActual) && d <= 700;
    if (q.dir != null && difAng(q.dir, rumboActual) > 50) return false;
    return difAng(rumbo(p.lat, p.lon, q.lat, q.lon), rumboActual) <= 35 && d <= 1000;
  }
  function evaluarPeajes(p) {
    if (!ajustes.avisarPeajes || !ajustes.verPeajes) return;
    for (const q of peajes) {
      const d = dist(p.lat, p.lon, q.lat, q.lon);
      let e = estadoPeaje.get(q.id);
      if (d > 3000) { if (e) estadoPeaje.delete(q.id); continue; }
      if (!e) { e = { nivel: 0, dPrev: d }; estadoPeaje.set(q.id, e); }
      const acercando = d <= e.dPrev + 3;
      e.dPrev = d;
      if (d > 1600) e.nivel = 0;
      if (acercando && velActual >= (q.ramal ? 8 : 15) && e.nivel < 1 && vasAPasarPorPeaje(p, q, d)) {
        e.nivel = 1;
        const txt = 'Peaje a ' + (d >= 900 ? '1 kilómetro' : redondear(d) + ' metros') + (q.nombre ? ': ' + q.nombre : '');
        mostrarAlerta(txt, 'peaje', 'PEAJE A ' + (d >= 900 ? '1 KM' : redondear(d) + ' M'));
        if (audioWeb()) { if (ajustes.sonido) pitido(1); if (ajustes.voz) hablar(txt); }
      }
    }
  }
  function mostrarProximo(m) {
    const h = $('hudProx');
    actualizarChipRuta();
    if (!m || m.d > 2000) { h.hidden = true; return; }
    const t = TIPOS[m.r.tipo] || TIPOS.otro;
    h.hidden = false;
    const s = $('proxSenal');
    s.className = 'senal ' + t.clase + (m.r.vmaxFuente === 'estimado' && tieneLimite(m.r) ? ' estimado' : '');
    $('proxVmax').textContent = tieneLimite(m.r) ? m.r.vmax : (m.r.tipo === 'velocidad' ? '?' : '●');
    $('proxDist').textContent = formatoDist(m.d);
    $('proxTipo').textContent = t.nombre + (m.r.nombre ? ' · ' + m.r.nombre : '');
  }
  let ultimaAlarma = 0;
  function chequearExceso(m) {
    const exceso = !!(m && tieneLimite(m.r) && m.d <= ajustes.aviso1 && velActual > m.r.vmax + ajustes.tolerancia);
    $('hudVel').classList.toggle('exceso', exceso);
    if (exceso && ajustes.alarmaExceso && audioWeb() && Date.now() - ultimaAlarma > 2500) { ultimaAlarma = Date.now(); pitido(3); }
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
    marcarSeguimiento();
    prepararRotacion();
    actualizarChipRuta();
  }
  // El botón de ubicación se ve "encendido" mientras el mapa sigue al auto durante un viaje.
  function marcarSeguimiento() { $('btnCentrar').classList.toggle('siguiendo', viajeActivo && siguiendo); }
  function mostrarMiPosicion(lat, lon) {
    marcadorAuto.setLatLng([lat, lon]);
    if (!autoVisible) { marcadorAuto.addTo(mapa); autoVisible = true; }
    mapa.setView([lat, lon], Math.max(mapa.getZoom(), 16));
  }
  function irAMiUbicacion() {
    if (posAnt && !simulacion && Date.now() - ultimaFix < 60000) { mostrarMiPosicion(posAnt.lat, posAnt.lon); return; }
    if (!('geolocation' in navigator)) { toast('Este dispositivo no tiene GPS disponible.'); return; }
    const b = $('btnCentrar');
    b.classList.add('buscando');
    navigator.geolocation.getCurrentPosition(
      (p) => { b.classList.remove('buscando'); mostrarMiPosicion(p.coords.latitude, p.coords.longitude); },
      (err) => {
        b.classList.remove('buscando');
        toast(err && err.code === 1 ? 'Para ver dónde estás, permití el acceso a la ubicación.' : 'No se pudo obtener tu ubicación. Probá de nuevo.');
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 }
    );
  }
  function reiniciarSeguimiento() {
    siguiendo = true; primeraFix = true; posAnt = null; rumboActual = null; marcarSeguimiento();
    estadoRadar.clear(); estadoPeaje.clear();
    calleActual = null; calleCandidata = null; limiteActual = null; sinCalle = 0;
  }
  function iniciarViaje() {
    if (!('geolocation' in navigator)) { toast('Este navegador no permite usar el GPS.'); return; }
    if (simulacion) terminarViaje();
    audio(); tono(440, 0, 0.05, 0.001);
    if (ajustes.voz && audioWeb()) hablar('Viaje iniciado. Te aviso cuando haya un radar adelante.');
    reiniciarSeguimiento();
    marcarViajeActivo(true);
    const g = $('gpsEstado'); g.className = 'gps'; g.textContent = 'Buscando GPS…';
    watchId = navigator.geolocation.watchPosition(desdeGeo, errorGeo, { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
    pedirWakeLock();
    nat('pantalla', true);
    nat('iniciar');
    if (NATIVO && nat('bateriaLibre') === false && !LS.get('avisoBateria', false)) {
      LS.set('avisoBateria', true);
      toast('Para que los avisos no se corten con la pantalla bloqueada, en el menú tocá "Permitir avisos en segundo plano".', 9000);
    }
  }
  function terminarViaje(desdeNativo) {
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    if (simulacion) { clearInterval(simulacion); simulacion = null; }
    soltarWakeLock();
    if (hudActivo) cerrarHud();
    marcarViajeActivo(false);
    $('vel').textContent = '--';
    $('hudProx').hidden = true;
    $('hudVel').classList.remove('exceso', 'exceso-calle', 'exceso-est');
    limiteActual = null; calleActual = null; mostrarCalle();
    const g = $('gpsEstado'); g.className = 'gps'; g.textContent = 'GPS apagado';
    actualizarChipRuta();
    nat('pantalla', false);
    if (desdeNativo !== true) nat('detener');
  }
  function errorGeo(e) {
    const g = $('gpsEstado'); g.className = 'gps mal';
    if (e.code === 1) {
      g.textContent = 'Sin permiso de ubicación';
      toast(NATIVO ? 'Radares BA necesita tu ubicación precisa. Activala en Ajustes → Apps → Radares BA → Permisos → Ubicación: "Permitir solo con la app en uso" y "Usar ubicación precisa".' : 'No hay permiso para usar tu ubicación. En el iPhone: Configuración → Privacidad → Localización → Safari → "Al usar la app".', 10000);
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
        if (fueAlFondo && !NATIVO) toast('Mientras la app estuvo cerrada o con la pantalla bloqueada no se pudieron dar avisos.', 6000);
      }
      fueAlFondo = false;
    } else if (viajeActivo) fueAlFondo = true;
  });

  // ---------- Radares en tu ruta ----------
  const NOMINATIM = 'https://nominatim.openstreetmap.org';
  const OSRM = ['https://routing.openstreetmap.de/routed-car/route/v1/driving/', 'https://router.project-osrm.org/route/v1/driving/'];
  let ruta = LS.get('ruta', null);
  let itemsRuta = [];
  let eligiendoDestino = false;
  const capaRuta = L.layerGroup().addTo(mapa);

  function estadoRuta(txt) { $('rutaEstado').textContent = txt; }
  async function buscarLugar(texto) {
    const u = NOMINATIM + '/search?format=jsonv2&limit=6&countrycodes=ar&accept-language=es&viewbox=-63.5,-33.0,-56.5,-41.2&bounded=0&q=' + encodeURIComponent(texto);
    const r = await fetch(u, { signal: conTiempo(15000), headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    return (j || []).map((x) => ({ nombre: x.display_name, lat: +x.lat, lon: +x.lon }));
  }
  async function nombreDeLugar(lat, lon) {
    try {
      const r = await fetch(NOMINATIM + '/reverse?format=jsonv2&zoom=17&accept-language=es&lat=' + lat + '&lon=' + lon, { signal: conTiempo(10000), headers: { Accept: 'application/json' } });
      const j = await r.json();
      return j && j.display_name ? j.display_name : null;
    } catch (e) { return null; }
  }
  async function calcularRuta(o, d) {
    let ultimo = null;
    for (const b of OSRM) {
      try {
        const u = b + o.lon.toFixed(6) + ',' + o.lat.toFixed(6) + ';' + d.lon.toFixed(6) + ',' + d.lat.toFixed(6) + '?overview=full&geometries=geojson&steps=false&alternatives=false';
        const r = await fetch(u, { signal: conTiempo(25000) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        if (j.code !== 'Ok' || !j.routes || !j.routes.length) throw new Error(j.message || 'sin ruta');
        const rt = j.routes[0];
        return { coords: rt.geometry.coordinates.map((c) => [+c[1].toFixed(6), +c[0].toFixed(6)]), distancia: rt.distance, duracion: rt.duration };
      } catch (e) { ultimo = e; }
    }
    throw ultimo || new Error('sin ruta');
  }
  function posicionUnaVez() {
    return new Promise((ok, mal) => {
      if (!('geolocation' in navigator)) { mal(new Error('sin gps')); return; }
      navigator.geolocation.getCurrentPosition((p) => ok({ lat: p.coords.latitude, lon: p.coords.longitude }), mal, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
    });
  }
  // Recorre una línea: devuelve la posición y el rumbo a una distancia dada desde el inicio.
  function caminante(coords) {
    const acum = [0];
    for (let i = 1; i < coords.length; i++) acum.push(acum[i - 1] + dist(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]));
    return {
      acum, largo: acum[acum.length - 1],
      punto(m) {
        m = Math.max(0, Math.min(m, this.largo));
        let lo = 0, hi = acum.length - 1;
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (acum[mid] <= m) lo = mid; else hi = mid; }
        const a = coords[lo], b = coords[Math.min(lo + 1, coords.length - 1)];
        const seg = acum[Math.min(lo + 1, acum.length - 1)] - acum[lo];
        const t = seg > 0 ? (m - acum[lo]) / seg : 0;
        return { lat: a[0] + (b[0] - a[0]) * t, lon: a[1] + (b[1] - a[1]) * t, rumbo: rumbo(a[0], a[1], b[0], b[1]) };
      }
    };
  }
  function calcularItemsRuta(coords) {
    if (!coords || coords.length < 2) return [];
    const cam = caminante(coords);
    const grilla = new Map();
    for (let i = 0; i < coords.length - 1; i++) {
      const a = coords[i], b = coords[i + 1];
      const y0 = Math.floor(Math.min(a[0], b[0]) / 0.01), y1 = Math.floor(Math.max(a[0], b[0]) / 0.01);
      const x0 = Math.floor(Math.min(a[1], b[1]) / 0.01), x1 = Math.floor(Math.max(a[1], b[1]) / 0.01);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const k = y + ':' + x;
        if (!grilla.has(k)) grilla.set(k, []);
        grilla.get(k).push(i);
      }
    }
    const cercano = (lat, lon, umbral) => {
      const cy = Math.floor(lat / 0.01), cx = Math.floor(lon / 0.01);
      let mejor = null;
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        for (const s of grilla.get((cy + i) + ':' + (cx + j)) || []) {
          const r = distSeg(lat, lon, coords[s], coords[s + 1]);
          if (r.d <= umbral && (!mejor || r.d < mejor.d)) mejor = { d: r.d, s, t: r.t };
        }
      }
      if (!mejor) return null;
      const a = coords[mejor.s], b = coords[mejor.s + 1];
      return { d: mejor.d, along: cam.acum[mejor.s] + (cam.acum[mejor.s + 1] - cam.acum[mejor.s]) * mejor.t, rumbo: rumbo(a[0], a[1], b[0], b[1]) };
    };
    const items = [];
    for (const r of radares) {
      if (!activo(r)) continue;
      const c = cercano(r.lat, r.lon, 40);
      if (!c) continue;
      if (r.dir != null && difAng(r.dir, c.rumbo) > 60) continue;
      items.push({ r, m: c.along });
    }
    if (ajustes.verPeajes) for (const q of peajes) {
      // Solo los que cobran en el sentido de la ruta; los de un ramal, solo si la ruta pasa por la cabina.
      const c = cercano(q.lat, q.lon, q.ramal ? 25 : 150);
      if (!c || (q.dir != null && difAng(q.dir, c.rumbo) > 60)) continue;
      items.push({ q, m: c.along });
    }
    return items.sort((a, b) => a.m - b.m);
  }
  function nombreCorto(n) { return String(n || '').split(',')[0].trim() || 'Destino'; }
  function mostrarRuta(ajustar) {
    capaRuta.clearLayers();
    if (!ruta) { itemsRuta = []; $('rutaInfo').hidden = true; actualizarChipRuta(); return; }
    const colorRuta = getComputedStyle(document.documentElement).getPropertyValue('--ruta').trim() || '#1f6feb';
    L.polyline(ruta.coords, { color: '#08213f', weight: 10, opacity: 0.3, interactive: false }).addTo(capaRuta);
    L.polyline(ruta.coords, { color: colorRuta, weight: 6, opacity: 0.9, interactive: false }).addTo(capaRuta);
    L.marker([ruta.destino.lat, ruta.destino.lon], { icon: L.divIcon({ className: '', html: '<div class="destino-mk"></div>', iconSize: [22, 22], iconAnchor: [11, 22] }), interactive: false }).addTo(capaRuta);
    itemsRuta = calcularItemsRuta(ruta.coords);
    const anillo = L.divIcon({ className: '', html: '<div class="anillo-ruta"></div>', iconSize: [40, 40], iconAnchor: [20, 20] });
    for (const it of itemsRuta) if (it.r) L.marker([it.r.lat, it.r.lon], { icon: anillo, interactive: false, keyboard: false, zIndexOffset: -500 }).addTo(capaRuta);
    renderListaRuta();
    actualizarChipRuta();
    if (ajustar) verRutaCompleta();
  }
  function renderListaRuta() {
    $('rutaInfo').hidden = false;
    $('rutaDestino').textContent = 'Hasta ' + nombreCorto(ruta.destino.nombre) + (ruta.origenTexto ? ', desde ' + ruta.origenTexto : '');
    const nRad = itemsRuta.filter((x) => x.r).length, nPea = itemsRuta.filter((x) => x.q).length;
    const caja = $('rutaResumen');
    caja.textContent = '';
    for (const [v, t] of [[formatoKm(ruta.distancia), 'distancia'], [formatoDuracion(ruta.duracion), 'tiempo aprox.'], [nRad, nRad === 1 ? 'radar' : 'radares'], [nPea, nPea === 1 ? 'peaje' : 'peajes']]) {
      const d = document.createElement('div');
      const b = document.createElement('b'); b.textContent = v;
      const s = document.createElement('span'); s.textContent = t;
      d.append(b, s); caja.appendChild(d);
    }
    const lista = $('rutaLista');
    lista.textContent = '';
    if (!itemsRuta.length) {
      const li = document.createElement('li'); li.className = 'nota'; li.textContent = 'No hay radares ni peajes cargados en este camino.';
      lista.appendChild(li);
    }
    for (const it of itemsRuta) {
      const li = document.createElement('li');
      const b = document.createElement('button'); b.type = 'button';
      const k = document.createElement('span'); k.className = 'km'; k.textContent = formatoKm(it.m);
      const ic = document.createElement('span');
      const d = document.createElement('span'); d.className = 'det';
      const sm = document.createElement('small');
      if (it.r) {
        const t = TIPOS[it.r.tipo] || TIPOS.otro;
        ic.className = 'mk mini ' + t.clase + claseFuente(it.r);
        if (it.r.tipo === 'semaforo') ic.innerHTML = '<i></i><i></i><i></i>';
        d.textContent = t.nombre + (tieneLimite(it.r) ? ' · máx. ' + (it.r.vmaxFuente === 'estimado' ? '≈' : '') + it.r.vmax : '');
        sm.textContent = it.r.nombre || 'Sin descripción';
      } else {
        ic.className = 'peaje-mk mini';
        d.textContent = 'Peaje';
        sm.textContent = it.q.nombre || 'Estación de peaje';
      }
      d.appendChild(sm);
      b.append(k, ic, d);
      const lat = it.r ? it.r.lat : it.q.lat, lon = it.r ? it.r.lon : it.q.lon;
      b.onclick = () => { cerrarHojas(); irA(lat, lon, 17); };
      li.appendChild(b); lista.appendChild(li);
    }
  }
  function actualizarChipRuta() {
    const chip = $('chipRuta');
    if (!ruta || viajeActivo || !$('hojaRuta').hidden || !$('hudProx').hidden) { chip.hidden = true; return; }
    const nRad = itemsRuta.filter((x) => x.r).length;
    $('chipRutaTxt').textContent = nombreCorto(ruta.destino.nombre) + ' · ' + formatoKm(ruta.distancia) + ' · ' + nRad + (nRad === 1 ? ' radar' : ' radares');
    chip.hidden = false;
  }
  function verRutaCompleta() {
    if (!ruta) return;
    dejarDeSeguir();
    mapa.fitBounds(L.latLngBounds(ruta.coords), { paddingTopLeft: [24, 80], paddingBottomRight: [24, 140] });
  }
  function borrarRuta() {
    ruta = null; LS.del('ruta');
    mostrarRuta(false);
    estadoRuta('Sale desde tu ubicación actual.');
  }
  async function elegirDestino(dest) {
    $('rutaResultados').textContent = '';
    estadoRuta('Calculando la ruta…');
    let origen = null, textoOrigen = 'tu ubicación actual';
    if (posAnt && Date.now() - ultimaFix < 120000 && !simulacion) origen = { lat: posAnt.lat, lon: posAnt.lon };
    else origen = await posicionUnaVez().catch(() => null);
    if (!origen) { const c = mapa.getCenter(); origen = { lat: c.lat, lon: c.lng }; textoOrigen = 'el centro del mapa (no se pudo obtener tu ubicación)'; }
    try {
      const r = await calcularRuta(origen, dest);
      ruta = { destino: dest, origenTexto: textoOrigen, coords: r.coords, distancia: r.distancia, duracion: r.duracion, fecha: Date.now() };
      LS.set('ruta', ruta);
      mostrarRuta(true);
      estadoRuta('Listo. Tocá un radar de la lista para verlo en el mapa.');
    } catch (e) {
      estadoRuta('No se pudo calcular la ruta. Probá de nuevo en un rato.');
    }
  }
  $('formRuta').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('rutaBuscar').value.trim();
    if (q.length < 3) { estadoRuta('Escribí al menos 3 letras.'); return; }
    $('rutaBuscar').blur();
    estadoRuta('Buscando…');
    $('rutaResultados').textContent = '';
    try {
      const res = await buscarLugar(q);
      if (!res.length) { estadoRuta('No encontré ese lugar. Probá agregando la ciudad, por ejemplo "Av. Mitre 500, Avellaneda".'); return; }
      estadoRuta('Elegí el destino:');
      for (const r of res) {
        const b = document.createElement('button'); b.type = 'button';
        const partes = r.nombre.split(',');
        const nb = document.createElement('b'); nb.textContent = partes[0];
        b.append(nb, document.createTextNode(partes.slice(1, 4).join(',').trim()));
        b.onclick = () => elegirDestino(r);
        $('rutaResultados').appendChild(b);
      }
    } catch (err) {
      estadoRuta('No se pudo buscar (¿sin internet?). Probá de nuevo en un rato.');
    }
  });
  $('btnElegirMapa').onclick = () => {
    eligiendoDestino = true;
    $('hojaRuta').hidden = true;
    dejarDeSeguir();
    toast('Tocá el mapa en el lugar de destino.', 6000);
  };
  $('btnVerRuta').onclick = () => { cerrarHojas(); verRutaCompleta(); };
  $('btnBorrarRuta').onclick = borrarRuta;
  $('btnViajeRuta').onclick = () => { cerrarHojas(); if (!viajeActivo) iniciarViaje(); };
  $('chipRutaVer').onclick = () => abrirRuta();
  $('chipRutaX').onclick = borrarRuta;
  function abrirRuta() {
    const abierto = !$('hojaRuta').hidden;
    cerrarHojas();
    if (abierto) return;
    ocultarToast();
    $('hojaRuta').hidden = false;
    if (ruta) renderListaRuta();
    actualizarChipRuta();
  }

  function irA(lat, lon, zoom) {
    dejarDeSeguir();
    mapa.setView([lat, lon], zoom || 17);
  }
  function dejarDeSeguir() {
    if (viajeActivo) { siguiendo = false; marcarSeguimiento(); }
    if (modoRot) girarA(0, false);
  }

  // ---------- Modo parabrisas ----------
  let hudActivo = false, hudEspejo = LS.get('hudEspejo', true), tHudCtrl = null;
  function abrirHud() {
    cerrarHojas();
    if (!viajeActivo) iniciarViaje();
    hudActivo = true;
    $('hudModo').hidden = false;
    $('btnHud').classList.add('activo');
    aplicarEspejo();
    mostrarCtrlHud();
    prepararRotacion();
    actualizarHud();
  }
  function cerrarHud() {
    hudActivo = false;
    $('hudModo').hidden = true;
    $('btnHud').classList.remove('activo');
    prepararRotacion();
    if (viajeActivo && posAnt) centrar(Object.assign({}, posAnt));
  }
  function aplicarEspejo() {
    $('hudCont').classList.toggle('espejo', hudEspejo);
    $('hudEspejo').textContent = 'Espejado: ' + (hudEspejo ? 'sí (para reflejar en el parabrisas)' : 'no (para mirar la pantalla)');
  }
  function mostrarCtrlHud() {
    $('hudCtrl').hidden = false;
    clearTimeout(tHudCtrl);
    tHudCtrl = setTimeout(() => { $('hudCtrl').hidden = true; }, 6000);
  }
  function actualizarHud() {
    if (!hudActivo) return;
    $('hudVelNum').textContent = viajeActivo && posAnt ? Math.round(velActual) : '--';
    const bc = $('hudCalleBloque');
    if (ajustes.mostrarLimite && limiteActual) {
      bc.hidden = false;
      $('hudLim').textContent = limiteActual.v;
      $('hudLim').classList.toggle('estimado', limiteActual.estimado);
    } else bc.hidden = true;
    const br = $('hudRadarBloque');
    if (proximo && proximo.d <= 2000) {
      br.hidden = false;
      $('hudRadarVmax').textContent = tieneLimite(proximo.r) ? proximo.r.vmax : (proximo.r.tipo === 'velocidad' ? '?' : '●');
      $('hudRadarVmax').classList.toggle('estimado', proximo.r.vmaxFuente === 'estimado');
      $('hudRadarDist').textContent = formatoDist(proximo.d);
    } else br.hidden = true;
    const hv = $('hudVel');
    $('hudModo').classList.toggle('exceso', hv.classList.contains('exceso') || hv.classList.contains('exceso-calle'));
  }
  $('btnHud').onclick = () => { if (hudActivo) cerrarHud(); else abrirHud(); };
  $('hudModo').addEventListener('click', (e) => { if (!e.target.closest('#hudCtrl')) mostrarCtrlHud(); });
  $('hudEspejo').onclick = () => { hudEspejo = !hudEspejo; LS.set('hudEspejo', hudEspejo); aplicarEspejo(); mostrarCtrlHud(); };
  $('hudSalir').onclick = cerrarHud;

  // ---------- Simulación ----------
  function simular() {
    let recorrido = null, inicio = 0, velSim = 70, descripcion = '';
    if (ruta && ruta.coords && ruta.coords.length > 1) {
      recorrido = caminante(ruta.coords);
      const primero = itemsRuta.find((x) => x.r);
      inicio = primero ? Math.max(0, primero.m - 1300) : 0;
      descripcion = 'por tu ruta a ' + nombreCorto(ruta.destino.nombre);
    } else {
      const centro = mapa.getCenter();
      const candidatos = radares.filter((r) => r.tipo === 'velocidad' && activo(r));
      const lista = candidatos.length ? candidatos : radares.filter(activo);
      if (!lista.length) { toast('No hay radares cargados. Tocá "Actualizar radares" primero.'); return; }
      let obj = null, mejor = Infinity;
      for (const r of lista) { const d = dist(centro.lat, centro.lng, r.lat, r.lon); if (d < mejor) { mejor = d; obj = r; } }
      const brng = obj.dir != null ? obj.dir : 45;
      const a = destino(obj.lat, obj.lon, (brng + 180) % 360, 1300), b = destino(obj.lat, obj.lon, brng, 600);
      recorrido = caminante([a, b]);
      velSim = tieneLimite(obj) ? obj.vmax + 15 : 70;
      descripcion = 'hacia ' + (obj.nombre || 'un radar');
    }
    cerrarHojas();
    if (viajeActivo) terminarViaje();
    audio(); tono(440, 0, 0.05, 0.001);
    reiniciarSeguimiento();
    marcarViajeActivo(true);
    toast('Simulación a ' + Math.round(velSim) + ' km/h ' + descripcion + '.', 5000);
    if (ajustes.voz) hablar('Empieza la simulación.');
    const paso = velSim / 3.6;
    let m = inicio, n = 0;
    simulacion = setInterval(() => {
      m += paso;
      const p = recorrido.punto(m);
      onPos({ lat: p.lat, lon: p.lon, vel: velSim, rumbo: p.rumbo, precision: 5, t: Date.now() });
      if (++n > 240 || m >= recorrido.largo) { terminarViaje(); toast('Simulación terminada.'); }
    }, 1000);
  }

  // ---------- Agregar radar ----------
  let agregando = false, puntoNuevo = null, marcaTemporal = null;
  function abrirAgregar() {
    cerrarHojas();
    agregando = true; puntoNuevo = null;
    dejarDeSeguir();
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
    if (marcaTemporal) mapa.removeLayer(marcaTemporal);
    $('hojaAgregar').hidden = true;
  }
  mapa.on('click', (e) => {
    if (agregando) { fijarPunto(e.latlng.lat, e.latlng.lng, 'Punto marcado. Si está bien, completá los datos y guardá.'); return; }
    if (eligiendoDestino) {
      eligiendoDestino = false;
      $('hojaRuta').hidden = false;
      actualizarChipRuta();
      const dest = { nombre: 'Punto elegido en el mapa', lat: e.latlng.lat, lon: e.latlng.lng };
      elegirDestino(dest).then(() => nombreDeLugar(dest.lat, dest.lon)).then((nom) => {
        if (nom && ruta && ruta.destino === dest) { dest.nombre = nom; LS.set('ruta', ruta); renderListaRuta(); actualizarChipRuta(); }
      });
    }
  });
  $('btnAquiEstoy').onclick = () => {
    if (posAnt && !simulacion) { fijarPunto(posAnt.lat, posAnt.lon, 'Usando tu posición actual.'); return; }
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
  function cerrarHojas() {
    $('panel').hidden = true;
    $('hojaRuta').hidden = true;
    $('hojaNovedades').hidden = true;
    if (agregando) cerrarAgregar();
    actualizarChipRuta();
  }
  const CAMPOS = [
    ['ajAviso1', 'aviso1', 'num'], ['ajAviso2', 'aviso2', 'num'], ['ajTol', 'tolerancia', 'num'],
    ['ajVoz', 'voz', 'check'], ['ajSonido', 'sonido', 'check'], ['ajExceso', 'alarmaExceso', 'check'], ['ajAvisarPeajes', 'avisarPeajes', 'check'],
    ['ajMostrarLimite', 'mostrarLimite', 'check'], ['ajLimiteAlarma', 'limiteAlarma', 'txt'],
    ['ajVerVel', 'verVelocidad', 'check'], ['ajVerCam', 'verCamaras', 'check'], ['ajVerOtros', 'verOtros', 'check'], ['ajVerPeajes', 'verPeajes', 'check'],
    ['ajRotar', 'rotarMapa', 'check'], ['ajModo', 'modoMapa', 'txt']
  ];
  function cargarAjustesEnPanel() {
    for (const [id, k, tipo] of CAMPOS) {
      if (tipo === 'check') $(id).checked = !!ajustes[k]; else $(id).value = String(ajustes[k]);
    }
  }
  function guardarAjustes() {
    const antes = [ajustes.verVelocidad, ajustes.verCamaras, ajustes.verOtros, ajustes.verPeajes].join();
    for (const [id, k, tipo] of CAMPOS) {
      if (tipo === 'check') ajustes[k] = $(id).checked;
      else if (tipo === 'num') ajustes[k] = +$(id).value;
      else ajustes[k] = $(id).value;
    }
    ajustes.aviso2 = Math.min(ajustes.aviso2, ajustes.aviso1);
    LS.set('ajustes', ajustes);
    if (antes !== [ajustes.verVelocidad, ajustes.verCamaras, ajustes.verOtros, ajustes.verPeajes].join()) dibujarRadares();
    else sincronizarNativo();
    aplicarModoMapa();
    prepararRotacion();
    mostrarCalle();
  }
  CAMPOS.forEach(([id]) => $(id).addEventListener('change', guardarAjustes));

  $('btnMenu').onclick = () => {
    const abierto = !$('panel').hidden;
    cerrarHojas();
    if (!abierto) { ocultarToast(); cargarAjustesEnPanel(); actualizarResumen(); mostrarNovedades(); revisarBateria(); $('panel').hidden = false; }
  };
  $('btnRuta').onclick = abrirRuta;
  $('btnAgregar').onclick = () => abrirAgregar();
  document.querySelectorAll('[data-cerrar]').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.cerrar === 'hojaAgregar') cerrarAgregar(); else $(b.dataset.cerrar).hidden = true;
      if (b.dataset.cerrar === 'hojaRuta') eligiendoDestino = false;
      actualizarChipRuta();
    };
  });
  $('btnActualizar').onclick = actualizarRadares;
  $('btnSimular').onclick = simular;
  $('btnRestaurar').onclick = () => {
    const n = ocultos.size; ocultos.clear(); LS.set('radaresOcultos', []); dibujarRadares();
    toast(n ? (n === 1 ? 'Se volvió a mostrar el que estaba oculto.' : 'Se volvieron a mostrar los ' + n + ' que estaban ocultos.') : 'No había radares ni peajes ocultos.');
  };
  $('btnNovedades').onclick = abrirNovedades;
  $('btnNovedadesVolver').onclick = () => { $('btnMenu').click(); };
  $('btnNovedadesVistas').onclick = () => {
    if (novedades) { novedades.visto = true; LS.set('novedades', novedades); }
    dibujarRadares(); mostrarNovedades();
    toast('Listo: los radares nuevos ya no se resaltan en el mapa.');
  };
  $('btnProbarSonido').onclick = () => {
    if (NATIVO) { nat('probarSonido'); return; }
    pitido(2);
    setTimeout(() => hablar('Radar de velocidad a 250 metros. Máxima 60.'), 600);
  };
  $('btnViaje').onclick = () => { if (viajeActivo) terminarViaje(); else iniciarViaje(); };
  $('btnCentrar').onclick = () => {
    if (!viajeActivo) { irAMiUbicacion(); return; }
    siguiendo = true; marcarSeguimiento();
    if (modoRot && rumboActual != null) girarA(-rumboActual, true);
    if (posAnt) centrar(Object.assign({}, posAnt));
  };
  $('btnBrujula').onclick = () => {
    ajustes.rotarMapa = !ajustes.rotarMapa;
    LS.set('ajustes', ajustes);
    if ($('ajRotar')) $('ajRotar').checked = ajustes.rotarMapa;
    prepararRotacion();
    if (ajustes.rotarMapa && !viajeActivo) toast('El mapa va a girar con el auto cuando inicies el viaje.');
    else toast(ajustes.rotarMapa ? 'El mapa gira con el auto.' : 'Mapa con el norte hacia arriba.');
  };
  mapa.on('dragstart', () => { if (viajeActivo) dejarDeSeguir(); });
  mapa.on('popupopen', () => { if (modoRot && rotGrados % 360 !== 0) dejarDeSeguir(); });

  // ---------- Puente con la app de Android ----------
  let tSync = null;
  function sincronizarNativo() {
    if (!NATIVO) return;
    clearTimeout(tSync);
    tSync = setTimeout(() => {
      const datos = {
        radares: radares.filter(activo).map((r) => [+r.lat.toFixed(6), +r.lon.toFixed(6), r.tipo, tieneLimite(r) ? r.vmax : 0, r.dir == null ? -1 : Math.round(r.dir), (r.nombre || '').slice(0, 60), r.vmaxFuente === 'estimado' ? 1 : 0]),
        // La app de Android nueva entiende la mano y los ramales; a una vieja no se le pasan los peajes de
        // subidas y bajadas, que avisaría aunque no entres por ahí.
        peajes: (ajustes.verPeajes ? peajes : []).filter((q) => peajesConSentido() || !q.ramal).map((q) => peajesConSentido()
          ? [+q.lat.toFixed(6), +q.lon.toFixed(6), (q.nombre || '').slice(0, 60), q.dir == null ? -1 : Math.round(q.dir), q.ramal ? 1 : 0,
            q.ramal && Array.isArray(q.tramo) ? q.tramo : [], q.ramal && Array.isArray(q.otros) ? q.otros : []]
          : [+q.lat.toFixed(6), +q.lon.toFixed(6), (q.nombre || '').slice(0, 60)]),
        ajustes: { aviso1: ajustes.aviso1, aviso2: ajustes.aviso2, tolerancia: ajustes.tolerancia, voz: ajustes.voz, sonido: ajustes.sonido, alarmaExceso: ajustes.alarmaExceso, avisarPeajes: ajustes.avisarPeajes && ajustes.verPeajes }
      };
      nat('datos', JSON.stringify(datos));
    }, 400);
  }
  const peajesConSentido = () => nat('peajesConSentido') === true;
  function revisarBateria() {
    if (NATIVO) $('bloqueBateria').hidden = nat('bateriaLibre') !== false;
  }
  $('btnBateria').onclick = () => nat('pedirBateria');
  window.__radaresNativo = {
    detenido() { if (viajeActivo && !simulacion) terminarViaje(true); },
    activo() { return viajeActivo; },
    // Botón "atrás" de Android: primero cierra lo que esté abierto.
    atras() {
      if (hudActivo) { cerrarHud(); return true; }
      if (!$('intro').hidden) { $('btnIntroOk').click(); return true; }
      if (eligiendoDestino) { eligiendoDestino = false; $('hojaRuta').hidden = false; return true; }
      if (!$('hojaNovedades').hidden) { $('btnMenu').click(); return true; } // de Novedades se vuelve al menú
      if (!$('panel').hidden || !$('hojaRuta').hidden || !$('hojaAgregar').hidden) { cerrarHojas(); return true; }
      return false;
    },
    volvio() { revisarBateria(); }
  };
  function urlApk() {
    let usuario = 'juancelularmotog-hash', repoNombre = 'radares-ba';
    if (location.hostname.endsWith('.github.io')) {
      usuario = location.hostname.split('.')[0];
      const seg = location.pathname.split('/').filter(Boolean)[0];
      if (seg && !seg.includes('.')) repoNombre = seg;
    }
    return 'https://github.com/' + usuario + '/' + repoNombre + '/raw/apk/radares-ba.apk';
  }

  // ---------- Inicio ----------
  $('version').textContent = VERSION + (NATIVO ? ' · app de Android ' + (nat('version') || '') : '');
  if (NATIVO) {
    $('introBloqueo').innerHTML = 'Los avisos siguen aunque bloquees la pantalla o uses otra app, como Google Maps. Vas a ver una notificación fija mientras el viaje está activo.';
    $('introInstalar').hidden = true;
  } else if (/Android/i.test(navigator.userAgent)) {
    $('bloqueAndroid').hidden = false;
    $('linkApk').href = urlApk();
    $('introInstalar').innerHTML = 'En Android conviene <b>la app</b>, que avisa con la pantalla bloqueada: descargala desde el menú.';
  }
  if (!LS.get('introVisto', false)) {
    $('intro').hidden = false;
    LS.set('versionVista', VERSION); // a quien recién empieza no hace falta contarle qué cambió en la app
  }
  $('btnIntroOk').onclick = () => { LS.set('introVisto', true); $('intro').hidden = true; };
  aplicarModoMapa();
  prepararRotacion();
  dibujarRadares();
  mostrarNovedades();
  if (NATIVO && nat('activo') === true) iniciarViaje();
  // Trae la lista del proyecto en segundo plano (no molesta si no hay conexión).
  bajarRepo().then(recalcularBase, () => { /* sin conexión: se usan los datos guardados */ });

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* sin modo sin conexión */ });
  }

  // Funciones expuestas para pruebas automáticas.
  window.__radares = {
    onPos, parsearOSM, parsearCSVCaba, deduplicar, calcularItemsRuta, estimarLimite, calcularNovedades,
    estado: () => ({ radares: radares.length, peajes: peajes.length, viajeActivo, velActual, limite: limiteActual, calle: calleActual && calleActual.calle.t.name, rot: rotGrados, modoRot, siguiendo, items: itemsRuta.length, hud: hudActivo })
  };
})();
