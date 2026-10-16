"""Saca capturas de la app con distintos estilos de mapa (sin tocar la app publicada): copia el sitio, cambia
la capa base y fotografía La Plata con Playwright. Solo estilos que no necesitan clave."""
import json, re, shutil, subprocess, sys, time, urllib.request
from pathlib import Path

RAIZ = Path(sys.argv[1]).resolve()
SALIDA = Path(sys.argv[2]).resolve()
SALIDA.mkdir(parents=True, exist_ok=True)
OSM = '© OpenStreetMap'
IGN = 'https://wms.ign.gob.ar/geoserver/gwc/service/tms/1.0.0/{capa}@EPSG%3A3857@png/{{z}}/{{x}}/{{-y}}.png'

# Capas del IGN: se prueban varios nombres posibles y se usan los que existen.
candidatos_ign = ['capabaseargenmap', 'mapabase_gris', 'argenmap_gris', 'capabasegris', 'argenmap_oscuro',
                  'mapabase_oscuro', 'argenmap_oscuro_v1', 'mapabase_topo', 'mapabase_hibrido', 'mapabase_satelital']
existen = {}
for capa in candidatos_ign:
    url = IGN.format(capa=capa).replace('{z}', '12').replace('{x}', '1388').replace('{-y}', str(2**12 - 1 - 2467))
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'radares-ba/1.2 (vista previa de estilos)'})
        with urllib.request.urlopen(req, timeout=30) as r:
            tipo = r.headers.get('Content-Type', '')
            datos = r.read()
            existen[capa] = tipo.startswith('image') and len(datos) > 500
    except Exception as e:
        existen[capa] = False
print('capas del IGN:', existen)

ESTILOS = [
    # (id, nombre, url, vector, modo, invertir, maxNativo, subdominios)
    ('osm', 'OpenStreetMap (el actual)', 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', False, 'dia', False, 19, ''),
    ('osm_noche', 'OpenStreetMap invertido (el actual de noche)', 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', False, 'noche', True, 19, ''),
    ('hot', 'OpenStreetMap Humanitario', 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', False, 'dia', False, 19, 'abc'),
    ('esri_calles', 'Esri calles', 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', False, 'dia', False, 19, ''),
    ('esri_satelite', 'Esri satélite', 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', False, 'dia', False, 19, ''),
    ('ofm_liberty', 'OpenFreeMap Liberty', 'https://tiles.openfreemap.org/styles/liberty', True, 'dia', False, 20, ''),
    ('ofm_bright', 'OpenFreeMap Bright', 'https://tiles.openfreemap.org/styles/bright', True, 'dia', False, 20, ''),
    ('ofm_positron', 'OpenFreeMap Positron', 'https://tiles.openfreemap.org/styles/positron', True, 'dia', False, 20, ''),
    ('ofm_dark', 'OpenFreeMap Dark', 'https://tiles.openfreemap.org/styles/dark', True, 'noche', False, 20, ''),
    ('ofm_fiord', 'OpenFreeMap Fiord', 'https://tiles.openfreemap.org/styles/fiord', True, 'noche', False, 20, ''),
    ('carto_voyager', 'CARTO Voyager', 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json', True, 'dia', False, 20, ''),
    ('carto_positron', 'CARTO Positron', 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json', True, 'dia', False, 20, ''),
    ('carto_dark', 'CARTO Dark Matter', 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json', True, 'noche', False, 20, ''),
]
nombres_ign = {'capabaseargenmap': ('ign', 'IGN Argenmap', 'dia'), 'mapabase_gris': ('ign_gris', 'IGN Argenmap gris', 'dia'),
               'argenmap_gris': ('ign_gris', 'IGN Argenmap gris', 'dia'), 'capabasegris': ('ign_gris', 'IGN Argenmap gris', 'dia'),
               'argenmap_oscuro': ('ign_oscuro', 'IGN Argenmap oscuro', 'noche'), 'mapabase_oscuro': ('ign_oscuro', 'IGN Argenmap oscuro', 'noche'),
               'argenmap_oscuro_v1': ('ign_oscuro', 'IGN Argenmap oscuro', 'noche'), 'mapabase_topo': ('ign_topo', 'IGN topográfico', 'dia'),
               'mapabase_hibrido': ('ign_hibrido', 'IGN híbrido', 'dia'), 'mapabase_satelital': ('ign_satelite', 'IGN satelital', 'dia')}
usados = set()
for capa, ok in existen.items():
    if ok and nombres_ign[capa][0] not in usados:
        usados.add(nombres_ign[capa][0])
        i, n, modo = nombres_ign[capa]
        ESTILOS.append((i, n, IGN.format(capa=capa), False, modo, False, 18, ''))

js = (RAIZ / 'app.js').read_text()
html = (RAIZ / 'index.html').read_text()
ini = js.index('  const PROVEEDORES = {')
fin = js.index('  let capaBase = null')
LIB = ('<link rel="stylesheet" href="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css">\n'
       '<script src="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js"></script>\n'
       '<script src="https://unpkg.com/@maplibre/maplibre-gl-leaflet@0.0.22/leaflet-maplibre-gl.js"></script>\n')

from playwright.sync_api import sync_playwright
informe = []
VISTAS = {'la_plata': (-34.9205, -57.9536), 'autopista': (-34.8389, -58.0701)}
with sync_playwright() as p:
    nav = p.chromium.launch()
    for (ide, nombre, url, vector, modo, invertir, maxn, sub) in ESTILOS:
        sitio = SALIDA.parent / ('sitio_' + ide)
        if sitio.exists():
            shutil.rmtree(sitio)
        shutil.copytree(RAIZ, sitio, ignore=shutil.ignore_patterns('.git', 'android', 'scripts', '.github'))
        prov = json.dumps({'url': url, 'sub': sub, 'atrib': OSM, 'max': maxn, 'invertir': invertir, 'vector': vector})
        nuevo = js[:ini] + '  const PROVEEDORES = { dia: [' + prov + '], noche: [' + prov + '] };\n' + js[fin:]
        nuevo = nuevo.replace('const capa = L.tileLayer(p.url, opciones);',
                              'const capa = p.vector ? L.maplibreGL({ style: p.url }) : L.tileLayer(p.url, opciones);')
        (sitio / 'app.js').write_text(nuevo)
        (sitio / 'index.html').write_text(html.replace('<script src="lib/leaflet.js"></script>',
                                                        '<script src="lib/leaflet.js"></script>\n' + (LIB if vector else '')))
        srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8811', '-d', str(sitio)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(1)
        for vista, (lat, lon) in VISTAS.items():
            ctx = nav.new_context(viewport={'width': 390, 'height': 800}, device_scale_factor=2, is_mobile=True, has_touch=True,
                                  permissions=['geolocation'], geolocation={'latitude': lat, 'longitude': lon})
            ctx.add_init_script("localStorage.setItem('introVisto','true'); localStorage.setItem('versionVista', JSON.stringify('x'));"
                                "localStorage.setItem('ajustes', JSON.stringify({modoMapa: '" + modo + "'}));")
            pg = ctx.new_page()
            errores = []
            pg.on('pageerror', lambda e: errores.append(str(e)))
            fallas = []
            pg.on('requestfailed', lambda r: fallas.append(r.url[:120]))
            pg.goto('http://localhost:8811/index.html')
            pg.wait_for_timeout(1500)
            pg.click('#btnCentrar')
            pg.wait_for_timeout(1500)
            pg.evaluate("document.getElementById('puntoMenu').hidden = true")
            try:
                pg.wait_for_load_state('networkidle', timeout=20000)
            except Exception:
                pass
            pg.wait_for_timeout(4000 if vector else 2500)
            archivo = SALIDA / f'{ide}_{vista}.png'
            pg.screenshot(path=str(archivo))
            toast = pg.inner_text('#toast') if pg.is_visible('#toast') else ''
            informe.append({'id': ide, 'nombre': nombre, 'vista': vista, 'modo': modo, 'vector': vector, 'url': url,
                            'errores': errores[:3], 'fallas': fallas[:5], 'aviso': toast})
            print(ide, vista, 'errores', errores[:1], 'fallas', len(fallas), toast[:60])
            ctx.close()
        srv.terminate()
        shutil.rmtree(sitio)
    nav.close()
(SALIDA / 'informe.json').write_text(json.dumps({'ign': existen, 'estilos': informe}, ensure_ascii=False, indent=1))
