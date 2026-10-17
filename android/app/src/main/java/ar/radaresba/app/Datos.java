package ar.radaresba.app;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Radares, peajes y ajustes que manda la app web (los mismos que se ven en el mapa). */
final class Datos {
    final int n;
    final double[] lat, lon;
    final String[] tipo, nombre;
    final int[] vmax, dir;
    final boolean[] estimado;

    final int np;
    final double[] plat, plon;
    final String[] pnombre;
    final int[] pdir;            // rumbo de quienes pagan (-1 = no se sabe: las dos manos)
    final boolean[] pramal;      // la cabina está en una subida o bajada
    final double[][][] ptramo;   // en los ramales: tramos por los que se llega a la cabina ([lat, lon, lat, lon, ...])
    final double[][][] potros;   // y los otros caminos que salen de donde se abre el ramal

    /** Segundos antes de llegar al radar en que empiezan los pips; distancias mínima y máxima del aviso (m). */
    static final double T_CUENTA = 5, AVISO_MIN = 50, AVISO_MAX = 700;

    int anticipacion = 15, tolerancia = 5;   // anticipacion: segundos antes de llegar en que suenan el pip y la voz
    boolean voz = true, sonido = true, pipsCuenta = true, alarmaExceso = true, avisarPeajes = true;

    private Datos(int n, int np) {
        this.n = n;
        lat = new double[n];
        lon = new double[n];
        tipo = new String[n];
        nombre = new String[n];
        vmax = new int[n];
        dir = new int[n];
        estimado = new boolean[n];
        this.np = np;
        plat = new double[np];
        plon = new double[np];
        pnombre = new String[np];
        pdir = new int[np];
        pramal = new boolean[np];
        ptramo = new double[np][][];
        potros = new double[np][][];
    }

    private static double[][] lineas(JSONArray a) {
        int nt = a == null ? 0 : a.length();
        double[][] res = new double[nt][];
        for (int k = 0; k < nt; k++) {
            JSONArray t = a.optJSONArray(k);
            int m = t == null ? 0 : t.length();
            double[] plano = new double[m * 2];
            for (int q = 0; q < m; q++) {
                JSONArray pt = t.optJSONArray(q);
                plano[q * 2] = pt == null ? 0 : pt.optDouble(0, 0);
                plano[q * 2 + 1] = pt == null ? 0 : pt.optDouble(1, 0);
            }
            res[k] = plano;
        }
        return res;
    }

    /**
     * Formato: {"radares":[[lat,lon,tipo,vmax(0=sin dato),dir(-1=ambos sentidos),nombre,estimado(0/1)],...],
     * "peajes":[[lat,lon,nombre,dir(-1=las dos manos),ramal(0/1),tramos,otros],...],
     * "ajustes":{anticipacion, pipsCuenta, tolerancia, voz, sonido, alarmaExceso, avisarPeajes}}
     * (tramos y otros: listas de líneas [[lat,lon],...]; ver vasAPasarPorPeaje)
     * (una web vieja manda los peajes solo con [lat,lon,nombre]: se toman como de las dos manos y sin ramal).
     */
    static Datos desdeJson(String texto) throws JSONException {
        JSONObject j = new JSONObject(texto);
        JSONArray r = j.optJSONArray("radares");
        JSONArray p = j.optJSONArray("peajes");
        Datos d = new Datos(r == null ? 0 : r.length(), p == null ? 0 : p.length());
        for (int i = 0; i < d.n; i++) {
            JSONArray x = r.getJSONArray(i);
            d.lat[i] = x.getDouble(0);
            d.lon[i] = x.getDouble(1);
            d.tipo[i] = x.optString(2, "velocidad");
            d.vmax[i] = x.optInt(3, 0);
            d.dir[i] = x.optInt(4, -1);
            d.nombre[i] = x.optString(5, "");
            d.estimado[i] = x.optInt(6, 0) == 1;
        }
        for (int i = 0; i < d.np; i++) {
            JSONArray x = p.getJSONArray(i);
            d.plat[i] = x.getDouble(0);
            d.plon[i] = x.getDouble(1);
            d.pnombre[i] = x.optString(2, "");
            d.pdir[i] = x.optInt(3, -1);
            d.pramal[i] = x.optInt(4, 0) == 1;
            d.ptramo[i] = lineas(x.optJSONArray(5));
            d.potros[i] = lineas(x.optJSONArray(6));
        }
        JSONObject a = j.optJSONObject("ajustes");
        if (a != null) {
            d.anticipacion = Math.max(5, Math.min(30, a.optInt("anticipacion", 15)));
            d.tolerancia = a.optInt("tolerancia", 5);
            d.voz = a.optBoolean("voz", true);
            d.sonido = a.optBoolean("sonido", true);
            d.pipsCuenta = a.optBoolean("pipsCuenta", true);
            d.alarmaExceso = a.optBoolean("alarmaExceso", true);
            d.avisarPeajes = a.optBoolean("avisarPeajes", true);
        }
        return d;
    }

    // ---------- Geometría ----------
    static final double R = 6371000;

    static double dist(double a, double b, double c, double d) {
        double dLat = Math.toRadians(c - a), dLon = Math.toRadians(d - b);
        double s = Math.pow(Math.sin(dLat / 2), 2)
                + Math.cos(Math.toRadians(a)) * Math.cos(Math.toRadians(c)) * Math.pow(Math.sin(dLon / 2), 2);
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
    }

    static double rumbo(double a, double b, double c, double d) {
        double y = Math.sin(Math.toRadians(d - b)) * Math.cos(Math.toRadians(c));
        double x = Math.cos(Math.toRadians(a)) * Math.sin(Math.toRadians(c))
                - Math.sin(Math.toRadians(a)) * Math.cos(Math.toRadians(c)) * Math.cos(Math.toRadians(d - b));
        return (Math.toDegrees(Math.atan2(y, x)) + 360) % 360;
    }

    static double difAng(double a, double b) {
        double d = Math.abs(a - b) % 360;
        return d > 180 ? 360 - d : d;
    }

    /** Distancia en metros de un punto a un segmento (aproximación plana, sirve para tramos cortos). */
    static double distSeg(double lat, double lon, double aLat, double aLon, double bLat, double bLon) {
        double k = Math.cos(Math.toRadians(lat));
        double ax = (aLon - lon) * 111320 * k, ay = (aLat - lat) * 110540;
        double bx = (bLon - lon) * 111320 * k, by = (bLat - lat) * 110540;
        double dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
        double t = l2 == 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2));
        return Math.hypot(ax + t * dx, ay + t * dy);
    }

    /** Distancia a la línea más cercana que va en tu mismo sentido (infinito si no hay ninguna). */
    static double distLineas(double lat, double lon, double rumbo, double[][] lineas) {
        double mejor = Double.POSITIVE_INFINITY;
        if (lineas == null) return mejor;
        for (double[] t : lineas) {
            for (int i = 0; i + 3 < t.length; i += 2) {
                if (difAng(rumbo(t[i], t[i + 1], t[i + 2], t[i + 3]), rumbo) > 50) continue;
                mejor = Math.min(mejor, distSeg(lat, lon, t[i], t[i + 1], t[i + 2], t[i + 3]));
            }
        }
        return mejor;
    }

    /**
     * Si vas por el ramal que lleva a la cabina: cerca de uno de sus tramos, en su mismo sentido, y más cerca
     * de él que de los otros caminos que salen de donde se abre (si no, todavía podés irte por el otro lado).
     */
    static boolean enTramo(double lat, double lon, double rumbo, double[][] tramos, double[][] otros) {
        if (rumbo < 0 || tramos == null) return false;
        double d = distLineas(lat, lon, rumbo, tramos);
        return d <= 25 && d + 3 < distLineas(lat, lon, rumbo, otros);
    }

    /**
     * Si vas a pasar por la cabina de peaje i: tiene que cobrar en tu mano y, si está en una subida o bajada,
     * tenés que estar en ese ramal. Las de la ruta principal se avisan desde 1 km si están adelante.
     */
    boolean vasAPasarPorPeaje(int i, double lat, double lon, double rumbo, double dist) {
        if (rumbo < 0) return false;
        // En los ramales el camino puede dar la vuelta (rulos): cuenta el sentido de cada tramo, no el de la cabina.
        if (pramal[i]) return dist <= 700 && enTramo(lat, lon, rumbo, ptramo[i], potros[i]);
        if (pdir[i] >= 0 && difAng(pdir[i], rumbo) > 50) return false;
        return dist <= 1000 && difAng(rumbo(lat, lon, plat[i], plon[i]), rumbo) <= 35;
    }

    // ---------- Avisos de radares ----------
    /** A qué distancia suenan el pip y la voz: unos segundos antes de llegar, según la velocidad (km/h). */
    double distAviso(double vel) {
        return Math.min(AVISO_MAX, Math.max(AVISO_MIN, vel / 3.6 * anticipacion));
    }

    /** Radares de velocidad: pips al acercarte y sonido al pasarlos. Las cámaras de semáforo y de control, no. */
    boolean mideVelocidad(int i) {
        return "velocidad".equals(tipo[i]) || vmax[i] > 0;
    }

    /** Segundos hasta el próximo pip: de 0,7 a 0,12 al llegar (más seguidos si vas pasado). */
    static double intervaloPip(double restante, boolean rapido) {
        double s = 0.12 + 0.58 * Math.pow(Math.max(0, Math.min(1, restante / T_CUENTA)), 1.2);
        return rapido ? s * 0.75 : s;
    }

    static long redondear(double d) {
        return d >= 200 ? Math.round(d / 50) * 50 : Math.max(10, Math.round(d / 10) * 10);
    }

    static String nombreTipo(String t) {
        if ("semaforo".equals(t)) return "Cámara de semáforo";
        if ("video".equals(t)) return "Cámara de control";
        if ("otro".equals(t)) return "Control vial";
        return "Radar de velocidad";
    }
}
