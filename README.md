# Radares BA

App web (instalable en iPhone y Android) que muestra los radares y peajes de CABA y Provincia de Buenos Aires y avisa con sonido y voz al acercarse. También hay una app para Android que avisa con la pantalla bloqueada.

- **Usarla en el iPhone:** abrir `https://<usuario>.github.io/radares-ba/` en Safari → Compartir → *Agregar a pantalla de inicio*.
- **App de Android:** `https://github.com/<usuario>/radares-ba/raw/apk/radares-ba.apk` (la compila `.github/workflows/android.yml` cada vez que cambia la carpeta `android/` y la deja en la rama `apk`). Es la misma app web dentro de una ventana, más un servicio que sigue el GPS y avisa con la pantalla bloqueada o con otra app abierta.

## Qué hace

- Avisos de radares con voz y pitidos (a la distancia que elijas), solo de los que están adelante y en tu sentido.
- Límite de la calle por la que vas, con alarma si lo superás. Si la calle no tiene el dato cargado, se estima por la ley de tránsito (calles 40, avenidas 60, rutas 110) y se muestra punteado.
- Radares en tu ruta: buscás un destino y lista los radares y peajes del camino.
- Peajes en el mapa y aviso a 1 km.
- Mapa que gira con el auto (botón de la brújula).
- Novedades: radares nuevos, quitados o que cambiaron de tipo después de cada actualización.
- Modo parabrisas (botón de la barra): pantalla negra con la velocidad y el próximo radar, espejados para reflejarse en el vidrio.

## Datos

`data/radares.json`, armado por `scripts/actualizar_radares.py`:

- CABA (oficial): [Cámaras fijas de control vehicular – Buenos Aires Data](https://data.buenosaires.gob.ar/dataset/camaras-fijas-control-vehicular)
- Provincia, peajes y límites de las calles: [OpenStreetMap](https://www.openstreetmap.org/copyright) (cargados por la comunidad)
- Correcciones a mano: `data/manual.json`

La búsqueda de destinos usa Nominatim y las rutas, OSRM (los dos con datos de OpenStreetMap).

**Actualización automática:** `.github/workflows/actualizar-radares.yml` corre todos los lunes (y a mano desde *Actions → Actualizar radares → Run workflow*).

## Límites

- En el iPhone, como app web, avisa solo con la app abierta y la pantalla prendida.
- La clave para firmar el APK (`android/radares-ba.keystore`) está en el repositorio para que cada versión nueva se pueda instalar encima de la anterior. Instalá el APK solo desde este repositorio.

Los datos pueden estar incompletos. Respetá siempre la señalización. No manipules el celular mientras manejás.
