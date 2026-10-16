#!/usr/bin/env python3
"""Arma data/radares.json juntando las fuentes de radares de CABA y Provincia de Buenos Aires.

Fuentes:
  - CABA (oficial): dataset "Cámaras fijas de control vehicular" de Buenos Aires Data.
  - Provincia (oficial): listado de radares fijos de Infracciones BA (equiposDeConstatacion).
  - OpenStreetMap: radares y peajes cargados por la comunidad en CABA y Provincia (consultas Overpass).
  - data/manual.json: correcciones y agregados revisados a mano (opcional).

Las fuentes oficiales tienen prioridad: si OpenStreetMap marca el mismo radar, queda el oficial.

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
import unicodedata
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
URL_PBA = "https://infraccionesba.gba.gob.ar/equiposDeConstatacion"
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
# Un radar de OpenStreetMap a menos de esta distancia de uno oficial de Provincia, y del mismo tipo,
# es el mismo aparato marcado un poco corrido (revisado contra los datos: siempre la misma calle).
RADIO_OFICIAL_PBA = 100
UA = "radares-ba/1.1 (actualizacion semanal; proyecto personal)"
UA_WEB = "Mozilla/5.0 (compatible; radares-ba/1.2; actualizacion semanal)"
ESTADISTICAS = {}  # datos extra de cada fuente para el resumen de data/radares.json


# ---------------- Utilidades ----------------
def bajar(url, datos=None, tiempo=200, ua=UA):
    req = urllib.request.Request(url, data=datos, headers={"User-Agent": ua})
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


# ---------------- Provincia de Buenos Aires ----------------
# La página de Infracciones BA trae dentro del HTML el listado completo de radares fijos, uno por
# aparato: receivedArr.push({nroSerie, calleRuta, velocidadPermitida, sentido, latitud, longitud,
# // nroKilometro, // tipo}). Aunque el mapa de Google de la página no cargue, el listado está.
CAJA_PBA = (-41.3, -33.1, -63.5, -56.5)  # sur, norte, oeste, este (CABA queda adentro)
PALABRAS_VACIAS = {
    "AV", "AVENIDA", "AVDA", "CALLE", "DE", "DEL", "LA", "LAS", "LOS", "EL", "Y", "E", "DR", "DOCTOR",
    "PTE", "PRES", "PRESIDENTE", "GRAL", "GENERAL", "CRUCE", "RUTA", "PROVINCIAL", "NACIONAL", "KM",
    "BV", "BOULEVARD", "BULEVAR", "CAMINO", "AUTOPISTA", "AU", "SAN", "SANTA", "NRO", "RP", "RN",
}
MINUSCULAS = {"de", "del", "la", "las", "los", "el", "y", "e", "a", "al", "en"}
VARIANTES = {"IRIGOYEN": "YRIGOYEN", "LASALLE": "SALLE"}  # misma calle escrita de otra forma
# En el listado algunas letras con tilde llegan cambiadas por "¿" o "?".
TILDES = {
    "jos?": "josé", "rep?blica": "república", "mart?n": "martín", "per?n": "perón", "ram?n": "ramón",
    "garc?a": "garcía", "g?mez": "gómez", "pe?a": "peña", "mu?iz": "muñiz", "espa?a": "españa",
    "ca?uelas": "cañuelas", "mor?n": "morón", "bel?n": "belén", "jes?s": "jesús", "ra?l": "raúl",
    "alfons?n": "alfonsín", "mart?nez": "martínez", "l?pez": "lópez", "rodr?guez": "rodríguez",
    "fern?ndez": "fernández", "gonz?lez": "gonzález", "s?enz": "sáenz", "pe?a?": "peña",
}
PARECE_RUTA = re.compile(r"\b(ruta|autopista|autov[ií]a|acceso|corredor|camino)\b", re.I)


def sin_tildes(s):
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


def ruta_de(texto):
    """'RP 73', 'Ruta Provincial N 2', 'RN7'... -> 'RP73', 'RP2', 'RN7' (o None)."""
    s = sin_tildes(texto).upper()
    m = re.search(r"\b(?:RUTA\s+(PROVINCIAL|NACIONAL)|R\.?\s?([PN]))(?![A-Z])\.?\s*(?:N[O°º]?\.?\s*)?(\d{1,3})(?!\d)", s)
    if not m:
        return None
    return ("RP" if (m.group(1) == "PROVINCIAL" or m.group(2) == "P") else "RN") + m.group(3)


def es_mayusculas(s):
    letras = [c for c in s if c.isalpha()]
    return len(letras) >= 3 and sum(c.isupper() for c in letras) / len(letras) > 0.8


def titulo(s):
    """'AV. JUAN B. JUSTO Y CHACABUCO' -> 'Av. Juan B. Justo y Chacabuco'."""
    palabras = s.lower().split()
    out = []
    for i, p in enumerate(palabras):
        siguiente = palabras[i + 1] if i + 1 < len(palabras) else ""
        # "a" va en minúscula solo como preposición ("Camino a las Flores"), no como inicial ("Diego A. Maradona").
        minuscula = p in MINUSCULAS and (p != "a" or siguiente in ("la", "las", "los", "el"))
        if i == 0 or not minuscula:
            p = re.sub(r"(^|[.\-/(])(\w)", lambda m: m.group(1) + m.group(2).upper(), p)
        out.append(p)
    return " ".join(out)


def corregir_tildes(texto):
    texto = re.sub(r"([cs])i[¿?]n\b", lambda m: m.group(1) + "ión", texto, flags=re.I)

    def palabra(m):
        w = m.group(0)
        bien = TILDES.get(w.lower().replace("¿", "?"))
        if not bien:
            return w.replace("¿", "").replace("?", "")
        return bien[0].upper() + bien[1:] if w[:1].isupper() else bien
    return re.sub(r"[^\W\d_]*[¿?][^\W\d_]*", palabra, texto)


def nombre_calle(calle):
    s = " ".join(calle.replace(" ", " ").split()).strip(" .,-")
    if es_mayusculas(s):
        s = titulo(s)
    s = corregir_tildes(s)
    s = re.sub(r"\bR\.?\s?P(?![^\W\d_])\.?\s*(?:N[º°o]?\.?\s*(?=\d))?", "Ruta Provincial ", s, flags=re.I)
    s = re.sub(r"\bR\.?\s?N(?![^\W\d_])\.?\s*(?:N[º°o]?\.?\s*(?=\d))?", "Ruta Nacional ", s, flags=re.I)
    s = re.sub(r"\b(Ruta (?:Provincial|Nacional))\s+N[º°o]?\.?\s*(?=\d)", r"\1 ", s, flags=re.I)
    s = re.sub(r"\b(?:Avda|Av)\b\.?\s*", "Av. ", s, flags=re.I)
    return " ".join(s.split()).strip(" .,-")


def numero_lugar(txt):
    """Kilómetro o altura: '21', '21.1', '21,1', 'km o,3' -> número (o None si es un texto)."""
    t = " ".join(str(txt).split()).lower().replace(",", ".")
    m = re.fullmatch(r"(?:km\.?\s*)?([\do]+(?:\.\d+)?)", t)
    if not m or not re.search(r"\d", m.group(1)):
        return None
    try:
        return float(m.group(1).replace("o", "0"))
    except ValueError:
        return None


def formato_km(n):
    return f"{n:.2f}".rstrip("0").rstrip(".").replace(".", ",")


def es_kilometro(calle, n):
    return n is not None and n < 1500 and (ruta_de(calle) is not None or bool(PARECE_RUTA.search(calle))
                                           or n != int(n))


def lugar_texto(calle, km_txt):
    """Lo que va después del nombre de la calle: ', km 21,1', ' 2199' o ' y Marcos Ezcurra'."""
    t = " ".join(str(km_txt).split())
    if not t:
        return ""
    n = numero_lugar(t)
    if n is not None:
        if es_kilometro(calle, n):
            return ", km " + formato_km(n)
        return " " + (str(int(n)) if n == int(n) else formato_km(n))
    m = re.match(r"cruce\s+(.+)", t, re.I)
    if m:
        cruce = corregir_tildes(titulo(m.group(1)) if es_mayusculas(m.group(1)) else m.group(1))
        return " y " + cruce
    if re.fullmatch(r"calle\s+\S+", t, re.I):
        return " y " + t.lower()
    return ""  # textos como "Carril 1 y Carril 2" no suman


def nombre_equipo(e):
    calle = nombre_calle(e["calle"])
    return calle + lugar_texto(e["calle"], e["km"]) if calle else ""


def claves_calle(calle):
    s = sin_tildes(calle).upper().replace("¿", "").replace("?", "")
    claves = {VARIANTES.get(w, w) for w in re.findall(r"[A-Z0-9]+", s)
              if w not in PALABRAS_VACIAS and (len(w) > 1 or w.isdigit())}
    r = ruta_de(calle)
    if r:
        claves.add(r)
    return claves


def html_pba():
    ultimo = None
    for intento in range(3):
        try:
            crudo = bajar(URL_PBA, tiempo=90, ua=UA_WEB)
            break
        except Exception as e:
            ultimo = e
            time.sleep(20 * (intento + 1))
    else:
        raise ultimo
    try:
        return crudo.decode("utf-8")
    except UnicodeDecodeError:
        return crudo.decode("cp1252", errors="replace")


def leer_equipos_pba(html):
    equipos = []
    for bloque in re.findall(r"receivedArr\.push\(\{(.*?)\}\)", html, re.S):
        # Algunos campos vienen comentados (// nroKilometro, // tipo), pero se leen igual.
        c = {k: v.strip() for k, v in re.findall(r'(\w+)\s*:\s*"([^"]*)"', bloque)}
        tipo = sin_tildes(c.get("tipo", "")).lower()
        if "movil" in tipo:
            continue  # solo radares fijos
        serie = c.get("nroSerie", "")
        calle = c.get("calleRuta", "")
        n = numero_lugar(c.get("nroKilometro", ""))
        equipos.append({
            "serie": serie, "calle": calle, "km": c.get("nroKilometro", ""),
            "lat_txt": c.get("latitud", ""), "lon_txt": c.get("longitud", ""),
            "lat": numero(c.get("latitud", "")), "lon": numero(c.get("longitud", "")),
            "vmax": velocidad(c.get("velocidadPermitida")),
            "sentido": sin_tildes(c.get("sentido", "")).lower(),
            "semaforo": bool(re.search(r"(^|_)RED(_|CAM)", serie.upper())),
            "claves": claves_calle(calle), "num": n, "es_km": es_kilometro(calle, n),
        })
    return equipos


def coordenada_valida(e):
    lat, lon = e["lat"], e["lon"]
    if lat is None or lon is None:
        return False
    if not (CAJA_PBA[0] < lat < CAJA_PBA[1] and CAJA_PBA[2] < lon < CAJA_PBA[3]):
        return False
    dec_lat = (e["lat_txt"].split(".") + [""])[1]
    dec_lon = (e["lon_txt"].split(".") + [""])[1]
    if len(dec_lat) < 3 or len(dec_lon) < 3:
        return False  # sin precisión suficiente
    if dec_lat[:6] == dec_lon[:6] or "12345" in dec_lat or "12345" in dec_lon:
        return False  # decimales copiados de la latitud a la longitud, o coordenadas de relleno
    return True


def compatibles(a, b):
    """Si dos aparatos pueden estar en el mismo lugar según la calle y el kilómetro o la altura."""
    if a["claves"] and b["claves"] and not (a["claves"] & b["claves"]):
        # Otro nombre para la misma calle ("Ruta 202" y "Av. Hipólito Yrigoyen") con la misma altura exacta.
        return a["num"] is not None and a["num"] == b["num"]
    if a["num"] is None or b["num"] is None:
        return True
    tope = 1.5 if (a["es_km"] and b["es_km"]) else 400
    return abs(a["num"] - b["num"]) <= tope


def depurar_mismo_punto(grupo):
    """Aparatos cargados con exactamente las mismas coordenadas. Si dicen estar en lugares distintos
    (otra calle, otro kilómetro), las coordenadas se copiaron mal: queda la mayoría que coincide
    (dos tercios o más) y, si no la hay, se descarta el punto."""
    if len(grupo) == 1:
        return grupo, []
    ancla = max(grupo, key=lambda e: sum(compatibles(e, o) for o in grupo))
    ok = [o for o in grupo if compatibles(ancla, o)]
    if len(ok) == len(grupo):
        return grupo, []
    if 3 * len(ok) >= 2 * len(grupo):
        return ok, [o for o in grupo if o not in ok]
    return [], grupo


def agrupar(equipos, radio):
    grupos = []
    for e in sorted(equipos, key=lambda x: (x["lat"], x["lon"])):
        g = next((g for g in grupos if any(dist(o["lat"], o["lon"], e["lat"], e["lon"]) < radio for o in g)), None)
        if g is None:
            grupos.append([e])
        else:
            g.append(e)
    return grupos


def radar_pba(grupo):
    """Un radar por lugar: junta los aparatos de cada sentido y carril."""
    grupo = sorted(grupo, key=lambda e: e["serie"])
    lat = sum(e["lat"] for e in grupo) / len(grupo)
    lon = sum(e["lon"] for e in grupo) / len(grupo)
    tipo = "semaforo" if grupo[0]["semaforo"] else "velocidad"
    nombres = [n for n in map(nombre_equipo, grupo) if n]
    nombre = Counter(nombres).most_common(1)[0][0] if nombres else ""
    velocidades = [e["vmax"] for e in grupo if e["vmax"]]
    sentidos = sorted({e["sentido"] for e in grupo if e["sentido"] in ("ascendente", "descendente")})
    r = {
        "id": f"pba-{lat:.5f},{lon:.5f}-{tipo}", "lat": round(lat, 6), "lon": round(lon, 6), "tipo": tipo,
        "vmax": min(velocidades) if velocidades and tipo == "velocidad" else None, "dir": None,
        "nombre": nombre, "fuente": "PBA",
    }
    en_km = any(e["es_km"] for e in grupo)
    if len(sentidos) == 2:
        r["sentido"] = "ambos"
        por_sentido = {s: sorted({e["vmax"] for e in grupo if e["sentido"] == s and e["vmax"]}) for s in sentidos}
        if tipo == "velocidad" and all(len(v) == 1 for v in por_sentido.values()) and \
                por_sentido["ascendente"] != por_sentido["descendente"]:
            r["detalle"] = (f"Controla los dos sentidos: máx. {por_sentido['ascendente'][0]} km/h ascendente "
                            f"y {por_sentido['descendente'][0]} km/h descendente")
        else:
            r["detalle"] = "Controla los dos sentidos"
    elif sentidos:
        r["sentido"] = sentidos[0]
        hacia = ("los km más altos" if sentidos[0] == "ascendente" else "los km más bajos") if en_km else \
            ("la numeración más alta" if sentidos[0] == "ascendente" else "la numeración más baja")
        r["detalle"] = f"Controla el sentido {sentidos[0]} (hacia {hacia})"
    return r


def fuente_pba():
    equipos = leer_equipos_pba(html_pba())
    if len(equipos) < 100:
        raise ValueError(f"la página trajo solo {len(equipos)} radares; puede haber cambiado")
    validos = [e for e in equipos if coordenada_valida(e)]
    descartados = [e for e in equipos if not coordenada_valida(e)]
    por_punto = {}
    for e in validos:
        por_punto.setdefault((round(e["lat"], 5), round(e["lon"], 5)), []).append(e)
    quedan = []
    for grupo in por_punto.values():
        ok, malos = depurar_mismo_punto(grupo)
        quedan += ok
        descartados += malos
    out = []
    for semaforo in (False, True):
        out += [radar_pba(g) for g in agrupar([e for e in quedan if e["semaforo"] == semaforo], 30)]
    for e in descartados:
        print(f"  PBA descartado (ubicación dudosa): {e['serie']} · {e['calle']} {e['km']} · "
              f"{e['lat_txt']}, {e['lon_txt']}", file=sys.stderr)
    ESTADISTICAS["PBA"] = {"equipos": len(equipos), "descartados": len(descartados)}
    if not out:
        raise ValueError("sin radares válidos")
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


# Hay cámaras de semáforo o de carril cargadas en OpenStreetMap como radar de velocidad; la descripción lo aclara.
SOLO_SEMAFORO = re.compile(r"luz roja|sem[aá]foro|senda peatonal", re.I)
SOLO_CARRIL = re.compile(r"carril", re.I)
MIDE_VELOCIDAD = re.compile(r"velocidad|cinem[oó]metro|radar", re.I)


def radar_osm(t, lat, lon, ident):
    enf = str(t.get("enforcement", "")).lower()
    tipo = "velocidad"
    if "traffic_signals" in enf:
        tipo = "semaforo"
    elif enf and "maxspeed" not in enf and "average_speed" not in enf and t.get("highway") != "speed_camera":
        tipo = "otro"
    texto = " ".join(str(t.get(k) or "") for k in ("name", "description", "note"))
    if tipo == "velocidad" and not MIDE_VELOCIDAD.search(texto):
        if SOLO_SEMAFORO.search(texto):
            tipo = "semaforo"
        elif SOLO_CARRIL.search(texto):
            tipo = "otro"
    r = {
        "id": f"osm-{ident}", "lat": round(lat, 6), "lon": round(lon, 6), "tipo": tipo,
        "vmax": velocidad(t.get("maxspeed")), "dir": direccion(t.get("direction")),
        "nombre": t.get("name") or t.get("ref") or "", "fuente": "OSM",
    }
    if t.get("description"):
        r["detalle"] = str(t["description"])[:120]
    return r


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


LIMITE_ENRIQUECER = 50 * 60  # segundos; si Overpass anda lento, lo que falte se completa con lo de la vez anterior


def enriquecer(radares, urbanos_fijos, conocidos=frozenset()):
    """Completa vmax, sentido y nombre de calle de los radares que no los tienen.
    Primero consulta los radares nuevos (los que no estaban en la lista anterior), que no tienen
    datos previos para reutilizar si se acaba el tiempo."""
    def falta_limite(r):
        return r.get("tipo") in ("velocidad", "otro") and not r.get("vmax")

    def falta_sentido(r):
        # Los radares de Provincia que controlan los dos sentidos no tienen un único sentido que deducir.
        return r.get("dir") is None and r.get("sentido") != "ambos"

    pendientes = [r for r in radares if falta_limite(r) or falta_sentido(r) or not r.get("nombre")]
    pendientes.sort(key=lambda r: r["id"] in conocidos)
    completados = {"vmax_calle": 0, "vmax_estimado": 0, "sentido": 0, "nombre": 0}
    inicio = time.monotonic()
    for i in range(0, len(pendientes), 40):
        if time.monotonic() - inicio > LIMITE_ENRIQUECER:
            print(f"  Completar límites: se cortó por tiempo en el lote {i // 40 + 1}; "
                  f"los {len(pendientes) - i} radares restantes usan lo de la vez anterior", file=sys.stderr)
            break
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
            if falta_sentido(r) and es_mano_unica(t) and d <= 15 and rb is not None:
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
def mismo_radar(x, r):
    """x ya quedó en la lista (fuente de igual o mayor prioridad); r es el que se está por sumar."""
    if not (x["tipo"] == r["tipo"] or "otro" in (x["tipo"], r["tipo"])):
        return False
    d = dist(x["lat"], x["lon"], r["lat"], r["lon"])
    return d < 30 or (d < RADIO_OFICIAL_PBA and x.get("fuente") == "PBA" and r.get("fuente") == "OSM")


def deduplicar(lista):
    lista = sorted(lista, key=lambda r: -PRIORIDAD.get(r.get("fuente"), 0))
    res, grilla = [], {}
    for r in lista:
        ca, co = round(r["lat"] * 2000), round(r["lon"] * 2000)
        # Celdas de unos 50 m: con 3 para cada lado se cubren los 100 m de RADIO_OFICIAL_PBA.
        dup = next((x for i in range(-3, 4) for j in range(-3, 4)
                    for x in grilla.get((ca + i, co + j), []) if mismo_radar(x, r)), None)
        if dup:
            dup["vmax"] = dup.get("vmax") or r.get("vmax")
            # Provincia informa el sentido: no se le copia el de otra fuente.
            if dup.get("dir") is None and dup.get("fuente") != "PBA":
                dup["dir"] = r.get("dir")
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
        fuentes.append({"id": nombre, "url": url, "cantidad": len(lista), "estado": "ok", **ESTADISTICAS.get(nombre, {})})
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
    todos += cargar_fuente("PBA", URL_PBA, fuente_pba, [r for r in previos if r.get("fuente") == "PBA"], fuentes)
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
    completados = enriquecer(radares, urbanos, frozenset(previo_por_id))
    for r in radares:
        p = previo_por_id.get(r["id"])
        if not p:
            continue
        if r.get("tipo") in ("velocidad", "otro") and not r.get("vmax") and p.get("vmax") and p.get("vmaxFuente"):
            r["vmax"], r["vmaxFuente"] = p["vmax"], p["vmaxFuente"]
        if r.get("dir") is None and p.get("dir") is not None and p.get("dirInferida"):
            r["dir"], r["dirInferida"] = p["dir"], True
        if not r.get("nombre") and p.get("nombre") and p.get("nombre") != r.get("detalle"):
            r["nombre"] = p["nombre"]
    # Si no se encontró la calle, queda al menos la descripción del aparato.
    for r in radares:
        if not r.get("nombre") and r.get("detalle") and r.get("fuente") == "OSM":
            r["nombre"] = r.pop("detalle")
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
