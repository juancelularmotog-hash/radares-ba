#!/usr/bin/env python3
"""Arma data/radares.json juntando las fuentes de radares de CABA y Provincia de Buenos Aires.

Fuentes:
  - CABA (oficial): dataset "Cámaras fijas de control vehicular" de Buenos Aires Data.
  - OpenStreetMap: radares y peajes cargados por la comunidad en CABA y Provincia (consultas Overpass).
  - data/manual.json: correcciones y agregados revisados a mano (opcional).

Además:
  - Completa la velocidad máxima de los radares que no la traen, con el límite cargado en la
    calle donde está el radar. Si la calle no lo tiene y es zona urbana, la estima según la
    ley de tránsito (calles 40, avenidas 60) y lo marca como estimado.
  - Deduce el sentido de circulación que controla el radar cuando está sobre una calle de mano única.

Si una fuente no responde, se conservan los datos que ya teníamos de esa fuente.
Solo usa la biblioteca estándar de Python.
"""
import csv
import io
import json
import math
import re
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
DATOS = RAIZ / "data"
SALIDA = DATOS / "radares.json"
MANUAL = DATOS / "manual.json"

URL_CABA = ("https://cdn.buenosaires.gob.ar/datosabiertos/datasets/transporte-y-obras-publicas/"
            "camaras-fijas-control-vehicular/camaras-fijas-de-control-vehicular.csv")
OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]
AREA = '(area["ISO3166-2"="AR-B"];area["ISO3166-2"="AR-C"];)->.a;'
CONSULTA_RADARES = (
    '[out:json][timeout:180];' + AREA +
    '(node["highway"="speed_camera"](area.a);'
    'node["enforcement"~"maxspeed|traffic_signals|average_speed"](area.a);'
    'relation["type"="enforcement"]["enforcement"~"maxspeed|traffic_signals|average_speed"](area.a););'
    'out body;>;out skel qt;'
)
CONSULTA_PEAJES = (
    '[out:json][timeout:180];' + AREA +
    '(node["barrier"="toll_booth"](area.a);way["barrier"="toll_booth"](area.a););'
    'out center tags;'
)
CLASES_AUTO = r"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|road)(_link)?$"
PRIORIDAD = {"CABA": 3, "ANSV": 3, "PBA": 3, "manual": 2, "OSM": 1}
UA = "radares-ba/1.1 (actualizacion semanal; proyecto personal)"


# ---------------- Utilidades ----------------
def bajar(url, datos=None, tiempo=200):
    req = urllib.request.Request(url, data=datos, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=tiempo) as r:
        return r.read()


def overpass(consulta, intentos=3):
    """Consulta Overpass probando los servidores disponibles, con esperas si están saturados."""
    ultimo = None
    for intento in range(intentos):
        for url in OVERPASS:
            try:
                return json.loads(bajar(url, urllib.parse.urlencode({"data": consulta}).encode()))
            except Exception as e:
                ultimo = e
        time.sleep(15 * (intento + 1))
    raise ultimo or RuntimeError("Overpass no respondió")


def dist(a, b, c, d):
    R = 6371000
    p1, p2 = math.radians(a), math.radians(c)
    dl, dn = math.radians(c - a), math.radians(d - b)
    s = math.sin(dl / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dn / 2) ** 2
    return 2 * R * math.asin(min(1, math.sqrt(s)))


def rumbo(a, b, c, d):
    y = math.sin(math.radians(d - b)) * math.cos(math.radians(c))
    x = (math.cos(math.radians(a)) * math.sin(math.radians(c))
         - math.sin(math.radians(a)) * math.cos(math.radians(c)) * math.cos(math.radians(d - b)))
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def dif_ang(a, b):
    d = abs(a - b) % 360
    return 360 - d if d > 180 else d


def numero(txt):
    try:
        return float(str(txt).strip().replace(",", "."))
    except ValueError:
        return None


def velocidad(valor):
    """Convierte un valor de maxspeed de OpenStreetMap a km/h (o None si no es un número)."""
    if not valor:
        return None
    m = re.match(r"^\s*(\d{1,3})\s*(mph)?", str(valor))
    if not m:
        return None
    v = int(m.group(1))
    if m.group(2):
        v = round(v * 1.609)
    return v if 5 <= v <= 150 else None


def estimar_limite(highway, urbano):
    """Límite según la Ley 24.449 (art. 51) para autos, cuando la calle no tiene uno cargado."""
    h = (highway or "").replace("_link", "")
    if urbano:
        if h == "living_street":
            return 20
        if h in ("residential", "unclassified", "road"):
            return 40
        if h in ("primary", "secondary", "tertiary"):
            return 60
        return None  # autopistas urbanas: siempre señalizadas
    if h == "motorway":
        return 130
    if h in ("trunk", "primary", "secondary"):
        return 110
    return None


# ---------------- CABA ----------------
def fuente_caba():
    crudo = bajar(URL_CABA, tiempo=60)
    try:
        texto = crudo.decode("utf-8")
    except UnicodeDecodeError:
        texto = crudo.decode("cp1252")
    filas = list(csv.reader(io.StringIO(texto), delimiter=";"))
    if len(filas) < 2:
        raise ValueError("CSV vacío")
    cab = [c.strip().lower() for c in filas[0]]

    def col(prefijo):
        for i, c in enumerate(cab):
            if c.startswith(prefijo):
                return i
        raise ValueError(f"falta la columna {prefijo}")

    i_tipo, i_ubi, i_lat, i_lon = col("tipo"), col("ubic"), col("lat"), col("lon")
    out = []
    for f in filas[1:]:
        if len(f) <= max(i_tipo, i_ubi, i_lat, i_lon):
            continue
        lat, lon = numero(f[i_lat]), numero(f[i_lon])
        if lat is None or lon is None or not (-35.5 < lat < -33.5 and -59.5 < lon < -57.5):
            continue
        t = f[i_tipo].lower()
        tipo = "velocidad" if "cinem" in t else ("video" if ("anal" in t or "video" in t) else "otro")
        out.append({
            "id": f"caba-{lat:.5f},{lon:.5f}-{tipo}", "lat": round(lat, 6), "lon": round(lon, 6),
            "tipo": tipo, "vmax": None, "dir": None, "nombre": f[i_ubi].strip(), "fuente": "CABA",
        })
    if not out:
        raise ValueError("sin filas válidas")
    return out


# ---------------- OpenStreetMap: radares ----------------
DIRS = {"N": 0, "NNE": 22.5, "NE": 45, "ENE": 67.5, "E": 90, "ESE": 112.5, "SE": 135, "SSE": 157.5,
        "S": 180, "SSW": 202.5, "SW": 225, "WSW": 247.5, "W": 270, "WNW": 292.5, "NW": 315, "NNW": 337.5}


def direccion(v):
    if v is None:
        return None
    n = numero(v)
    if n is not None:
        return n % 360
    return DIRS.get(str(v).upper().strip())


def radar_osm(t, lat, lon, ident):
    enf = str(t.get("enforcement", "")).lower()
    tipo = "velocidad"
    if "traffic_signals" in enf:
        tipo = "semaforo"
    elif enf and "maxspeed" not in enf and "average_speed" not in enf and t.get("highway") != "speed_camera":
        tipo = "otro"
    return {
        "id": f"osm-{ident}", "lat": round(lat, 6), "lon": round(lon, 6), "tipo": tipo,
        "vmax": velocidad(t.get("maxspeed")), "dir": direccion(t.get("direction")),
        "nombre": t.get("name") or t.get("description") or t.get("ref") or "", "fuente": "OSM",
    }


def fuente_osm():
    j = overpass(CONSULTA_RADARES)
    nodos = {e["id"]: e for e in j.get("elements", []) if e.get("type") == "node"}
    out = []
    for e in j.get("elements", []):
        t = e.get("tags") or {}
        if e.get("type") == "node" and (t.get("highway") == "speed_camera" or t.get("enforcement")):
            out.append(radar_osm(t, e["lat"], e["lon"], f"n{e['id']}"))
    for e in j.get("elements", []):
        if e.get("type") != "relation" or not e.get("tags"):
            continue
        miembros = e.get("members", [])
        ref = next((m["ref"] for m in miembros if m.get("role") == "device" and m.get("type") == "node"), None)
        ref = ref or next((m["ref"] for m in miembros if m.get("role") == "from" and m.get("type") == "node"), None)
        n = nodos.get(ref)
        if not n or "lat" not in n:
            continue
        out.append(radar_osm({**(n.get("tags") or {}), **e["tags"]}, n["lat"], n["lon"], f"r{e['id']}"))
    if not out:
        raise ValueError("Overpass no devolvió radares")
    return out


# ---------------- OpenStreetMap: peajes ----------------
def fuente_peajes():
    j = overpass(CONSULTA_PEAJES)
    puntos = []
    for e in j.get("elements", []):
        lat = e.get("lat", (e.get("center") or {}).get("lat"))
        lon = e.get("lon", (e.get("center") or {}).get("lon"))
        if lat is None or lon is None:
            continue
        t = e.get("tags") or {}
        puntos.append({"id": f"{e['type'][0]}{e['id']}", "lat": lat, "lon": lon,
                       "nombre": t.get("name") or t.get("operator") or ""})
    # Una estación de peaje tiene varias cabinas: se agrupan las que están a menos de 300 m.
    grupos = []
    for p in sorted(puntos, key=lambda x: (x["lat"], x["lon"])):
        g = next((g for g in grupos if any(dist(q["lat"], q["lon"], p["lat"], p["lon"]) < 300 for q in g)), None)
        if g is None:
            grupos.append([p])
        else:
            g.append(p)
    out = []
    for g in grupos:
        nombres = Counter(p["nombre"] for p in g if p["nombre"])
        out.append({
            "id": "peaje-" + min(p["id"] for p in g),
            "lat": round(sum(p["lat"] for p in g) / len(g), 6),
            "lon": round(sum(p["lon"] for p in g) / len(g), 6),
            "nombre": nombres.most_common(1)[0][0] if nombres else "",
        })
    if not out:
        raise ValueError("Overpass no devolvió peajes")
    return out


# ---------------- Completar límites y sentido ----------------
def distancia_a_segmento(lat, lon, a, b):
    """Distancia en metros de un punto a un segmento (aproximación plana, válida para tramos cortos)."""
    k = math.cos(math.radians(lat))
    ax, ay = (a["lon"] - lon) * 111320 * k, (a["lat"] - lat) * 110540
    bx, by = (b["lon"] - lon) * 111320 * k, (b["lat"] - lat) * 110540
    dx, dy = bx - ax, by - ay
    largo2 = dx * dx + dy * dy
    t = 0 if largo2 == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / largo2))
    px, py = ax + t * dx, ay + t * dy
    return math.hypot(px, py)


def tramo_cercano(r, calle):
    """Devuelve (distancia, rumbo del tramo) del tramo de la calle más cercano al radar."""
    g = calle.get("geometry") or []
    mejor = (float("inf"), None)
    for a, b in zip(g, g[1:]):
        d = distancia_a_segmento(r["lat"], r["lon"], a, b)
        if d < mejor[0]:
            mejor = (d, rumbo(a["lat"], a["lon"], b["lat"], b["lon"]))
    return mejor


BONO_CLASE = {"motorway": 8, "trunk": 8, "primary": 6, "secondary": 4, "tertiary": 2}


def es_mano_unica(t):
    return t.get("oneway") in ("yes", "true", "1", "-1") or t.get("junction") == "roundabout"


def limite_de_calle(t, rumbo_tramo, dir_radar):
    """Límite cargado en la calle, teniendo en cuenta los límites distintos por sentido."""
    general = velocidad(t.get("maxspeed"))
    ida, vuelta = velocidad(t.get("maxspeed:forward")), velocidad(t.get("maxspeed:backward"))
    if dir_radar is not None and rumbo_tramo is not None and (ida or vuelta):
        sentido_ida = dif_ang(dir_radar, rumbo_tramo) < 90
        return (ida if sentido_ida else vuelta) or general
    if general:
        return general
    candidatos = [v for v in (ida, vuelta) if v]
    return min(candidatos) if candidatos else None


def enriquecer(radares, urbanos_fijos):
    """Completa vmax, sentido y nombre de calle de los radares que no los tienen."""
    def falta_limite(r):
        return r.get("tipo") in ("velocidad", "otro") and not r.get("vmax")

    pendientes = [r for r in radares if falta_limite(r) or r.get("dir") is None or not r.get("nombre")]
    completados = {"vmax_calle": 0, "vmax_estimado": 0, "sentido": 0, "nombre": 0}
    for i in range(0, len(pendientes), 40):
        lote = pendientes[i:i + 40]
        consulta = "[out:json][timeout:180];"
        for r in lote:
            consulta += (f'way(around:35,{r["lat"]},{r["lon"]})["highway"~"{CLASES_AUTO}"];out tags geom;'
                         f'way(around:300,{r["lat"]},{r["lon"]})["highway"="residential"];out count;')
        try:
            j = overpass(consulta)
        except Exception as e:
            print(f"  Completar límites: lote {i // 40 + 1} sin respuesta ({e})", file=sys.stderr)
            continue
        # La respuesta trae, para cada radar en orden: sus calles cercanas y después un elemento "count".
        grupos, actual = [], []
        for e in j.get("elements", []):
            if e.get("type") == "count":
                total = int((e.get("tags") or {}).get("ways", 0))
                grupos.append((actual, total))
                actual = []
            elif e.get("type") == "way":
                actual.append(e)
        for r, (calles, residenciales) in zip(lote, grupos):
            evaluadas = []
            for c in calles:
                d, rb = tramo_cercano(r, c)
                if d <= 35:
                    clase = (c.get("tags") or {}).get("highway", "").replace("_link", "")
                    evaluadas.append((d - BONO_CLASE.get(clase, 0), d, rb, c))
            if not evaluadas:
                continue
            evaluadas.sort(key=lambda x: x[0])
            _, d, rb, c = evaluadas[0]
            t = c.get("tags") or {}
            urbano = r["id"] in urbanos_fijos or residenciales >= 8
            # Sentido: solo si está sobre una calle de mano única y no hay otra de sentido contrario al lado.
            if r.get("dir") is None and es_mano_unica(t) and d <= 15 and rb is not None:
                sentido = (rb + 180) % 360 if t.get("oneway") == "-1" else rb
                opuesta = any(
                    es_mano_unica(x[3].get("tags") or {}) and x[3] is not c and x[1] <= 30
                    and x[2] is not None and dif_ang(x[2], sentido) > 150
                    for x in evaluadas
                )
                if not opuesta:
                    r["dir"] = round(sentido)
                    r["dirInferida"] = True
                    completados["sentido"] += 1
            if falta_limite(r):
                v = limite_de_calle(t, rb, r.get("dir"))
                if v:
                    r["vmax"], r["vmaxFuente"] = v, "calle"
                    completados["vmax_calle"] += 1
                elif urbano:
                    est = estimar_limite(t.get("highway"), True)
                    if est:
                        r["vmax"], r["vmaxFuente"] = est, "estimado"
                        completados["vmax_estimado"] += 1
            if not r.get("nombre"):
                nombre = t.get("name") or t.get("ref")
                if nombre:
                    r["nombre"] = nombre
                    completados["nombre"] += 1
        time.sleep(3)
    return completados


# ---------------- Combinar ----------------
def deduplicar(lista):
    lista = sorted(lista, key=lambda r: -PRIORIDAD.get(r.get("fuente"), 0))
    res, grilla = [], {}
    for r in lista:
        ca, co = round(r["lat"] * 2000), round(r["lon"] * 2000)
        dup = None
        for i in (-1, 0, 1):
            for j in (-1, 0, 1):
                for x in grilla.get((ca + i, co + j), []):
                    if dist(x["lat"], x["lon"], r["lat"], r["lon"]) < 30 and (
                            x["tipo"] == r["tipo"] or "otro" in (x["tipo"], r["tipo"])):
                        dup = x
                        break
                if dup:
                    break
            if dup:
                break
        if dup:
            dup["vmax"] = dup.get("vmax") or r.get("vmax")
            dup["dir"] = dup.get("dir") if dup.get("dir") is not None else r.get("dir")
            dup["nombre"] = dup.get("nombre") or r.get("nombre")
            continue
        copia = dict(r)
        res.append(copia)
        grilla.setdefault((ca, co), []).append(copia)
    res.sort(key=lambda r: (r["fuente"], r["lat"], r["lon"]))
    return res


def cargar_fuente(nombre, url, funcion, previos, fuentes):
    crudo = DATOS / f"fuente_{nombre.lower()}.json"
    try:
        lista = funcion()
        crudo.write_text(json.dumps(lista, ensure_ascii=False), encoding="utf-8")
        fuentes.append({"id": nombre, "url": url, "cantidad": len(lista), "estado": "ok"})
        print(f"{nombre}: {len(lista)}")
    except Exception as e:
        if crudo.exists():
            lista = json.loads(crudo.read_text(encoding="utf-8"))
        else:
            lista = list(previos)
        fuentes.append({"id": nombre, "url": url, "cantidad": len(lista), "estado": f"error: {e}"[:200]})
        print(f"{nombre}: ERROR ({e}); se mantienen {len(lista)} anteriores", file=sys.stderr)
    return lista


def main():
    anterior = {}
    if SALIDA.exists():
        try:
            anterior = json.loads(SALIDA.read_text(encoding="utf-8"))
        except Exception:
            anterior = {}
    previos = anterior.get("radares", [])

    fuentes, todos = [], []
    todos += cargar_fuente("CABA", "https://data.buenosaires.gob.ar/dataset/camaras-fijas-control-vehicular",
                           fuente_caba, [r for r in previos if r.get("fuente") == "CABA"], fuentes)
    todos += cargar_fuente("OSM", "https://www.openstreetmap.org", fuente_osm,
                           [r for r in previos if r.get("fuente") == "OSM"], fuentes)
    peajes = cargar_fuente("Peajes", "https://www.openstreetmap.org", fuente_peajes,
                           anterior.get("peajes", []), fuentes)

    if MANUAL.exists():
        manual = json.loads(MANUAL.read_text(encoding="utf-8"))
        agregados = [dict(r, fuente=r.get("fuente", "manual")) for r in manual.get("agregar", [])]
        quitar = set(manual.get("quitar", []))
        todos = [r for r in todos if r["id"] not in quitar] + agregados
        fuentes.append({"id": "manual", "url": "data/manual.json", "cantidad": len(agregados), "estado": "ok"})

    radares = deduplicar(todos)
    if not radares:
        print("No se obtuvo ningún radar: no se modifica el archivo.", file=sys.stderr)
        return 1

    # Lo completado la vez anterior se reutiliza si esta vez Overpass no responde.
    previo_por_id = {r["id"]: r for r in previos}
    urbanos = {r["id"] for r in radares if r.get("fuente") == "CABA"}
    completados = enriquecer(radares, urbanos)
    for r in radares:
        p = previo_por_id.get(r["id"])
        if not p:
            continue
        if r.get("tipo") in ("velocidad", "otro") and not r.get("vmax") and p.get("vmax") and p.get("vmaxFuente"):
            r["vmax"], r["vmaxFuente"] = p["vmax"], p["vmaxFuente"]
        if r.get("dir") is None and p.get("dir") is not None and p.get("dirInferida"):
            r["dir"], r["dirInferida"] = p["dir"], True
    print("Completados:", completados)
    print("Con límite:", sum(1 for r in radares if r.get("vmax")), "de", len(radares))

    nuevo = {
        "generado": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "fuentes": fuentes,
        "radares": radares,
        "peajes": peajes,
    }
    if (anterior.get("radares") == radares and anterior.get("peajes") == peajes
            and anterior.get("fuentes") == fuentes):
        print("Sin cambios.")
        return 0
    SALIDA.write_text(json.dumps(nuevo, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Total: {len(radares)} radares y {len(peajes)} peajes guardados en {SALIDA.relative_to(RAIZ)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
