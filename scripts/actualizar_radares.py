#!/usr/bin/env python3
"""Arma data/radares.json juntando las fuentes de radares de CABA y Provincia de Buenos Aires.

Fuentes:
  - CABA (oficial): dataset "Cámaras fijas de control vehicular" de Buenos Aires Data.
  - OpenStreetMap: radares cargados por la comunidad en CABA y Provincia (consulta Overpass).
  - data/manual.json: correcciones y agregados revisados a mano (opcional).

Si una fuente no responde, se conservan los radares que ya teníamos de esa fuente.
Solo usa la biblioteca estándar de Python.
"""
import csv
import io
import json
import math
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
SALIDA = RAIZ / "data" / "radares.json"
MANUAL = RAIZ / "data" / "manual.json"

URL_CABA = ("https://cdn.buenosaires.gob.ar/datosabiertos/datasets/transporte-y-obras-publicas/"
            "camaras-fijas-control-vehicular/camaras-fijas-de-control-vehicular.csv")
OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]
CONSULTA_OSM = (
    '[out:json][timeout:120];'
    '(area["ISO3166-2"="AR-B"];area["ISO3166-2"="AR-C"];)->.a;'
    '(node["highway"="speed_camera"](area.a);'
    'node["enforcement"~"maxspeed|traffic_signals|average_speed"](area.a);'
    'relation["type"="enforcement"]["enforcement"~"maxspeed|traffic_signals|average_speed"](area.a););'
    'out body;>;out skel qt;'
)
PRIORIDAD = {"CABA": 3, "ANSV": 3, "PBA": 3, "manual": 2, "OSM": 1}
UA = "radares-ba/1.0 (actualizacion semanal; proyecto personal)"


def bajar(url, datos=None, tiempo=150):
    req = urllib.request.Request(url, data=datos, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=tiempo) as r:
        return r.read()


def dist(a, b, c, d):
    R = 6371000
    p1, p2 = math.radians(a), math.radians(c)
    dl, dn = math.radians(c - a), math.radians(d - b)
    s = math.sin(dl / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dn / 2) ** 2
    return 2 * R * math.asin(min(1, math.sqrt(s)))


def numero(txt):
    try:
        return float(str(txt).strip().replace(",", "."))
    except ValueError:
        return None


# ---------------- CABA ----------------
def fuente_caba():
    crudo = bajar(URL_CABA, tiempo=60)
    try:
        texto = crudo.decode("utf-8")
    except UnicodeDecodeError:
        texto = crudo.decode("cp1252")
    lector = csv.reader(io.StringIO(texto), delimiter=";")
    filas = list(lector)
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


# ---------------- OpenStreetMap ----------------
DIRS = {"N": 0, "NNE": 22.5, "NE": 45, "ENE": 67.5, "E": 90, "ESE": 112.5, "SE": 135, "SSE": 157.5,
        "S": 180, "SSW": 202.5, "SW": 225, "WSW": 247.5, "W": 270, "WNW": 292.5, "NW": 315, "NNW": 337.5}


def vmax(v):
    import re
    m = re.search(r"(\d{2,3})", v or "")
    return int(m.group(1)) if m else None


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
        "vmax": vmax(t.get("maxspeed")), "dir": direccion(t.get("direction")),
        "nombre": t.get("name") or t.get("description") or t.get("ref") or "", "fuente": "OSM",
    }


def fuente_osm():
    ultimo = None
    for url in OVERPASS:
        try:
            j = json.loads(bajar(url, urllib.parse.urlencode({"data": CONSULTA_OSM}).encode()))
            break
        except Exception as e:  # probar el siguiente servidor
            ultimo = e
    else:
        raise ultimo or RuntimeError("Overpass no respondió")
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
    return out


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


def main():
    anterior = {}
    if SALIDA.exists():
        try:
            anterior = json.loads(SALIDA.read_text(encoding="utf-8"))
        except Exception:
            anterior = {}
    previos = anterior.get("radares", [])

    fuentes, todos = [], []
    for nombre, url, funcion in (
        ("CABA", "https://data.buenosaires.gob.ar/dataset/camaras-fijas-control-vehicular", fuente_caba),
        ("OSM", "https://www.openstreetmap.org", fuente_osm),
    ):
        crudo = RAIZ / "data" / f"fuente_{nombre.lower()}.json"
        try:
            lista = funcion()
            crudo.write_text(json.dumps(lista, ensure_ascii=False), encoding="utf-8")
            fuentes.append({"id": nombre, "url": url, "cantidad": len(lista), "estado": "ok"})
            print(f"{nombre}: {len(lista)} radares")
        except Exception as e:
            if crudo.exists():
                lista = json.loads(crudo.read_text(encoding="utf-8"))
            else:
                lista = [r for r in previos if r.get("fuente") == nombre]
            fuentes.append({"id": nombre, "url": url, "cantidad": len(lista), "estado": f"error: {e}"[:200]})
            print(f"{nombre}: ERROR ({e}); se mantienen {len(lista)} radares anteriores", file=sys.stderr)
        todos.extend(lista)

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

    nuevo = {
        "generado": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "fuentes": fuentes,
        "radares": radares,
    }
    # Solo reescribir si cambiaron los radares (evita cambios vacíos cada semana).
    if anterior.get("radares") == radares and anterior.get("fuentes") == fuentes:
        print("Sin cambios.")
        return 0
    SALIDA.write_text(json.dumps(nuevo, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Total: {len(radares)} radares guardados en {SALIDA.relative_to(RAIZ)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
