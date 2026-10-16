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

    int aviso1 = 500, aviso2 = 250, tolerancia = 5;
    boolean voz = true, sonido = true, alarmaExceso = true, avisarPeajes = true;

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
    }

    /**
     * Formato: {"radares":[[lat,lon,tipo,vmax(0=sin dato),dir(-1=ambos sentidos),nombre,estimado(0/1)],...],
     * "peajes":[[lat,lon,nombre],...], "ajustes":{...}}
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
        }
        JSONObject a = j.optJSONObject("ajustes");
        if (a != null) {
            d.aviso1 = a.optInt("aviso1", 500);
            d.aviso2 = Math.min(a.optInt("aviso2", 250), d.aviso1);
            d.tolerancia = a.optInt("tolerancia", 5);
            d.voz = a.optBoolean("voz", true);
            d.sonido = a.optBoolean("sonido", true);
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

    static long redondear(double d) {
        return d >= 100 ? Math.round(d / 50) * 50 : Math.max(10, Math.round(d / 10) * 10);
    }

    static String nombreTipo(String t) {
        if ("semaforo".equals(t)) return "Cámara de semáforo";
        if ("video".equals(t)) return "Cámara de control";
        if ("otro".equals(t)) return "Control vial";
        return "Radar de velocidad";
    }
}
