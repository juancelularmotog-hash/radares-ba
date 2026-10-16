# Radares BA

App web (instalable en iPhone y Android) que muestra los radares de CABA y Provincia de Buenos Aires y avisa con sonido y voz al acercarse.

- **Usarla:** abrir `https://<usuario>.github.io/radares-ba/` en Safari → Compartir → *Agregar a pantalla de inicio*.
- **Datos:** `data/radares.json`, armado por `scripts/actualizar_radares.py`:
  - CABA (oficial): [Cámaras fijas de control vehicular – Buenos Aires Data](https://data.buenosaires.gob.ar/dataset/camaras-fijas-control-vehicular)
  - Provincia y resto: [OpenStreetMap](https://www.openstreetmap.org/copyright) (cargados por la comunidad)
  - Correcciones a mano: `data/manual.json`
- **Actualización automática:** `.github/workflows/actualizar-radares.yml` corre todos los lunes (y a mano desde *Actions → Actualizar radares → Run workflow*).
- **Límite en iPhone:** como app web, avisa solo con la app abierta y la pantalla prendida.

Los datos pueden estar incompletos. Respetá siempre la señalización. No manipules el celular mientras manejás.
