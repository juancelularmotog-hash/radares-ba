package ar.radaresba.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.drawable.Icon;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;

/**
 * Servicio del viaje: sigue el GPS y da los avisos de radares y peajes con voz y pitidos,
 * aunque la pantalla esté bloqueada o estés usando otra app (por ejemplo, Google Maps).
 * Mientras está activo se ve una notificación fija con el botón "Terminar viaje".
 */
public class ServicioRadares extends Service implements LocationListener {
    static final String INICIAR = "ar.radaresba.app.INICIAR";
    static final String DETENER = "ar.radaresba.app.DETENER";
    private static final String CANAL = "viaje";
    private static final int ID_NOTIF = 7;
    private static final String ARCHIVO = "datos.json";

    static volatile boolean activo = false;
    private static volatile Datos datos;

    private LocationManager gps;
    private PowerManager.WakeLock despierto;
    private Voz voz;
    private Location anterior;
    private double rumbo = -1;
    private double vel = 0;
    private Datos datosEnUso;
    private final HashMap<Integer, double[]> estadoRadar = new HashMap<>();
    private final HashMap<Integer, double[]> estadoPeaje = new HashMap<>();
    private long ultimaAlarma = 0;
    private String textoNotif = "";
    private long ultimaNotif = 0;

    // ---------- Datos que manda la web ----------
    static void guardarDatos(Context c, String json) {
        try {
            Datos d = Datos.desdeJson(json);
            datos = d;
            File f = new File(c.getFilesDir(), ARCHIVO);
            File tmp = new File(c.getFilesDir(), ARCHIVO + ".tmp");
            try (OutputStream o = new FileOutputStream(tmp)) {
                o.write(json.getBytes(StandardCharsets.UTF_8));
            }
            if (!tmp.renameTo(f)) {
                f.delete();
                tmp.renameTo(f);
            }
        } catch (Exception ignorada) {
            // datos con problemas: se siguen usando los anteriores
        }
    }

    private static Datos leerDatos(Context c) {
        File f = new File(c.getFilesDir(), ARCHIVO);
        if (!f.exists()) return null;
        try (InputStream in = new FileInputStream(f)) {
            byte[] b = new byte[(int) f.length()];
            int leidos = 0;
            while (leidos < b.length) {
                int r = in.read(b, leidos, b.length - leidos);
                if (r < 0) break;
                leidos += r;
            }
            return Datos.desdeJson(new String(b, 0, leidos, StandardCharsets.UTF_8));
        } catch (Exception e) {
            return null;
        }
    }

    // ---------- Ciclo de vida ----------
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String accion = intent != null ? intent.getAction() : null;
        if (DETENER.equals(accion)) {
            terminar();
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!activo) arrancar();
        return START_NOT_STICKY;
    }

    private void arrancar() {
        crearCanal();
        Notification n = notificacion("Te aviso cuando haya un radar adelante.");
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(ID_NOTIF, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
            else startForeground(ID_NOTIF, n);
        } catch (Exception e) {
            stopSelf();
            MainActivity.avisarDetenido();
            return;
        }
        activo = true;
        if (datos == null) datos = leerDatos(this);
        voz = Voz.get(this);
        gps = getSystemService(LocationManager.class);
        try {
            gps.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000, 0, this, Looper.getMainLooper());
        } catch (SecurityException | IllegalArgumentException e) {
            terminar();
            stopSelf();
            return;
        }
        PowerManager pm = getSystemService(PowerManager.class);
        if (pm != null) {
            despierto = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "radaresba:viaje");
            despierto.acquire(10 * 60 * 60 * 1000L);
        }
        anterior = null;
        rumbo = -1;
        estadoRadar.clear();
        estadoPeaje.clear();
        Datos d = datos;
        if (d == null || d.voz) voz.hablar("Viaje iniciado. Te aviso cuando haya un radar adelante.");
    }

    private void terminar() {
        if (!activo) return;
        activo = false;
        if (gps != null) gps.removeUpdates(this);
        if (despierto != null && despierto.isHeld()) despierto.release();
        stopForeground(STOP_FOREGROUND_REMOVE);
        MainActivity.avisarDetenido();
    }

    @Override
    public void onDestroy() {
        terminar();
        super.onDestroy();
    }

    // ---------- GPS ----------
    @Override
    public void onLocationChanged(Location l) {
        double v = 0;
        if (l.hasSpeed()) {
            v = l.getSpeed() * 3.6;
        } else if (anterior != null) {
            double dt = (l.getTime() - anterior.getTime()) / 1000.0;
            if (dt > 0) v = anterior.distanceTo(l) / dt * 3.6;
        }
        if (l.hasBearing() && l.hasSpeed() && l.getSpeed() > 1) {
            rumbo = l.getBearing();
        } else if (anterior != null && anterior.distanceTo(l) > 6) {
            rumbo = (anterior.bearingTo(l) + 360) % 360;
        }
        vel = v;
        anterior = l;
        Datos d = datos;
        if (d == null) return;
        if (d != datosEnUso) {
            datosEnUso = d;
            estadoRadar.clear();
            estadoPeaje.clear();
        }
        evaluarRadares(d, l.getLatitude(), l.getLongitude());
        if (d.avisarPeajes) evaluarPeajes(d, l.getLatitude(), l.getLongitude());
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onStatusChanged(String proveedor, int estado, Bundle extras) {
    }

    @Override
    public void onProviderEnabled(String proveedor) {
    }

    @Override
    public void onProviderDisabled(String proveedor) {
        actualizarNotif("La ubicación del teléfono está apagada.", true);
    }

    // ---------- Avisos (la misma lógica que la app web) ----------
    private void evaluarRadares(Datos d, double la, double lo) {
        int mejor = -1;
        double dMejor = Double.MAX_VALUE;
        for (int i = 0; i < d.n; i++) {
            if (Math.abs(d.lat[i] - la) > 0.03 || Math.abs(d.lon[i] - lo) > 0.04) {
                estadoRadar.remove(i);
                continue;
            }
            double dist = Datos.dist(la, lo, d.lat[i], d.lon[i]);
            double[] e = estadoRadar.get(i);
            if (dist > 3000) {
                if (e != null) estadoRadar.remove(i);
                continue;
            }
            if (e == null) {
                e = new double[]{0, dist};
                estadoRadar.put(i, e);
            }
            boolean acercando = dist <= e[1] + 3;
            e[1] = dist;
            if (dist > d.aviso1 + 300) e[0] = 0;
            boolean delante = rumbo < 0 ? dist < 120 : Datos.difAng(Datos.rumbo(la, lo, d.lat[i], d.lon[i]), rumbo) <= 40;
            boolean sentido = d.dir[i] < 0 || rumbo < 0 || Datos.difAng(d.dir[i], rumbo) <= 60;
            if (!delante || !sentido) continue;
            if (dist < dMejor) {
                dMejor = dist;
                mejor = i;
            }
            if (vel < 8) continue;
            if (e[0] < 1 && dist <= d.aviso1 && acercando) {
                e[0] = 1;
                aviso(d, i, dist, 1);
            }
            if (e[0] < 2 && dist <= d.aviso2 && acercando) {
                e[0] = 2;
                aviso(d, i, dist, 2);
            }
        }
        // Alarma si vas más rápido que el límite del radar que tenés adelante.
        if (mejor >= 0 && d.vmax[mejor] > 0 && dMejor <= d.aviso1 && vel > d.vmax[mejor] + d.tolerancia
                && d.alarmaExceso && SystemClock.elapsedRealtime() - ultimaAlarma > 2500) {
            ultimaAlarma = SystemClock.elapsedRealtime();
            voz.pitido(3);
        }
        if (mejor >= 0 && dMejor <= 2000) {
            String lim = d.vmax[mejor] > 0 ? " · máx. " + d.vmax[mejor] : "";
            actualizarNotif(Datos.nombreTipo(d.tipo[mejor]) + lim + " a " + formatoDist(dMejor), false);
        } else {
            actualizarNotif("Sin radares cerca.", false);
        }
    }

    private void aviso(Datos d, int i, double dist, int nivel) {
        String lim = d.vmax[i] > 0 ? (d.estimado[i] ? ". Máxima probable " : ". Máxima ") + d.vmax[i] : "";
        String texto = Datos.nombreTipo(d.tipo[i]) + " a " + Datos.redondear(dist) + " metros" + lim;
        boolean excede = d.vmax[i] > 0 && vel > d.vmax[i] + d.tolerancia;
        if (d.sonido) voz.pitido(nivel);
        if (d.voz && (nivel == 2 || !d.sonido)) {
            String dicho = texto + (excede ? ". Bajá la velocidad." : "");
            if (d.sonido) voz.hablarLuego(dicho, 450);
            else voz.hablar(dicho);
        }
    }

    private void evaluarPeajes(Datos d, double la, double lo) {
        for (int i = 0; i < d.np; i++) {
            if (Math.abs(d.plat[i] - la) > 0.03 || Math.abs(d.plon[i] - lo) > 0.04) {
                estadoPeaje.remove(i);
                continue;
            }
            double dist = Datos.dist(la, lo, d.plat[i], d.plon[i]);
            double[] e = estadoPeaje.get(i);
            if (dist > 3000) {
                if (e != null) estadoPeaje.remove(i);
                continue;
            }
            if (e == null) {
                e = new double[]{0, dist};
                estadoPeaje.put(i, e);
            }
            boolean acercando = dist <= e[1] + 3;
            e[1] = dist;
            if (dist > 1600) e[0] = 0;
            boolean delante = rumbo >= 0 && Datos.difAng(Datos.rumbo(la, lo, d.plat[i], d.plon[i]), rumbo) <= 35;
            if (delante && acercando && vel >= 15 && e[0] < 1 && dist <= 1000) {
                e[0] = 1;
                String texto = "Peaje a " + (dist >= 900 ? "1 kilómetro" : Datos.redondear(dist) + " metros")
                        + (d.pnombre[i].isEmpty() ? "" : ": " + d.pnombre[i]);
                if (d.sonido) voz.pitido(1);
                if (d.voz) {
                    if (d.sonido) voz.hablarLuego(texto, 450);
                    else voz.hablar(texto);
                }
            }
        }
    }

    private static String formatoDist(double d) {
        if (d >= 1000) return String.format(java.util.Locale.US, "%.1f", d / 1000).replace('.', ',') + " km";
        return Datos.redondear(d) + " m";
    }

    // ---------- Notificación ----------
    private void crearCanal() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null || nm.getNotificationChannel(CANAL) != null) return;
        NotificationChannel c = new NotificationChannel(CANAL, "Viaje en curso", NotificationManager.IMPORTANCE_LOW);
        c.setDescription("Se muestra mientras Radares BA te avisa de los radares.");
        c.setShowBadge(false);
        nm.createNotificationChannel(c);
    }

    private Notification notificacion(String texto) {
        PendingIntent abrir = PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent detener = PendingIntent.getService(this, 1,
                new Intent(this, ServicioRadares.class).setAction(DETENER),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b = new Notification.Builder(this, CANAL)
                .setSmallIcon(R.drawable.ic_notif)
                .setContentTitle("Radares BA · viaje en curso")
                .setContentText(texto)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setCategory(Notification.CATEGORY_NAVIGATION)
                .setColor(0xFFD7192A)
                .setContentIntent(abrir)
                .addAction(new Notification.Action.Builder(
                        Icon.createWithResource(this, R.drawable.ic_notif), "Terminar viaje", detener).build());
        if (Build.VERSION.SDK_INT >= 31) b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        return b.build();
    }

    private void actualizarNotif(String texto, boolean ya) {
        if (!activo || texto.equals(textoNotif)) return;
        long ahora = SystemClock.elapsedRealtime();
        if (!ya && ahora - ultimaNotif < 2000) return;
        textoNotif = texto;
        ultimaNotif = ahora;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.notify(ID_NOTIF, notificacion(texto));
    }
}
