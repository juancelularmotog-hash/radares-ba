package ar.radaresba.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.WindowManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.lang.ref.WeakReference;
import java.util.ArrayList;

/**
 * Pantalla principal: muestra la app web de Radares BA (la misma que en el iPhone) y la conecta
 * con el servicio que da los avisos aunque la pantalla esté bloqueada o se use otra app.
 */
public class MainActivity extends Activity {
    static final String URL_APP = "https://juancelularmotog-hash.github.io/radares-ba/";
    static final String HOST_APP = "juancelularmotog-hash.github.io";
    private static final int PEDIDO_PERMISOS = 1;
    private static WeakReference<MainActivity> actual = new WeakReference<>(null);

    private WebView web;
    private boolean pidiendoPermisos = false;
    private boolean iniciarAlTenerPermiso = false;
    private String origenGeo;
    private GeolocationPermissions.Callback avisoGeo;

    @Override
    protected void onCreate(Bundle estado) {
        super.onCreate(estado);
        actual = new WeakReference<>(this);
        Voz.get(this); // prepara la voz del teléfono desde ahora
        getWindow().setStatusBarColor(0xFF11161D);
        getWindow().setNavigationBarColor(0xFF11161D);

        web = new WebView(this);
        web.setBackgroundColor(0xFF11161D);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setGeolocationEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUserAgentString(s.getUserAgentString() + " RadaresBA/" + version());
        web.addJavascriptInterface(new Puente(), "RadaresAndroid");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest pedido) {
                Uri u = pedido.getUrl();
                if (HOST_APP.equals(u.getHost())) return false;
                abrirAfuera(u);
                return true;
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest pedido, WebResourceError error) {
                if (pedido.isForMainFrame()) mostrarSinConexion();
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origen, GeolocationPermissions.Callback aviso) {
                if (tienePermisoUbicacion()) {
                    aviso.invoke(origen, true, false);
                } else {
                    origenGeo = origen;
                    avisoGeo = aviso;
                    pedirPermisos();
                }
            }
        });
        web.loadUrl(URL_APP);
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        // Si el viaje se terminó desde la notificación mientras la app no estaba a la vista.
        if (!ServicioRadares.activo) {
            web.evaluateJavascript("window.__radaresNativo && window.__radaresNativo.detenido()", null);
        }
        web.evaluateJavascript("window.__radaresNativo && window.__radaresNativo.volvio && window.__radaresNativo.volvio()", null);
    }

    @Override
    protected void onPause() {
        web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (actual.get() == this) actual.clear();
        web.destroy();
        super.onDestroy();
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        // Primero cierra lo que esté abierto en la app web (menú, ruta, modo parabrisas).
        web.evaluateJavascript("(window.__radaresNativo && window.__radaresNativo.atras) ? window.__radaresNativo.atras() : false", valor -> {
            if ("true".equals(valor)) return;
            if (web.canGoBack()) web.goBack();
            else moveTaskToBack(true);
        });
    }

    /** El servicio avisa que el viaje terminó (por ejemplo, desde el botón de la notificación). */
    static void avisarDetenido() {
        MainActivity a = actual.get();
        if (a == null) return;
        a.runOnUiThread(() -> {
            if (a.web != null) a.web.evaluateJavascript("window.__radaresNativo && window.__radaresNativo.detenido()", null);
        });
    }

    String version() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "?";
        }
    }

    private boolean tienePermisoUbicacion() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private void pedirPermisos() {
        if (pidiendoPermisos) return;
        ArrayList<String> lista = new ArrayList<>();
        lista.add(Manifest.permission.ACCESS_FINE_LOCATION);
        lista.add(Manifest.permission.ACCESS_COARSE_LOCATION);
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            lista.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        pidiendoPermisos = true;
        requestPermissions(lista.toArray(new String[0]), PEDIDO_PERMISOS);
    }

    @Override
    public void onRequestPermissionsResult(int codigo, String[] permisos, int[] resultados) {
        super.onRequestPermissionsResult(codigo, permisos, resultados);
        if (codigo != PEDIDO_PERMISOS) return;
        pidiendoPermisos = false;
        boolean ok = tienePermisoUbicacion();
        if (avisoGeo != null) {
            avisoGeo.invoke(origenGeo, ok, false);
            avisoGeo = null;
        }
        if (iniciarAlTenerPermiso) {
            iniciarAlTenerPermiso = false;
            if (ok) iniciarServicio();
        }
    }

    private void iniciarServicio() {
        Intent i = new Intent(this, ServicioRadares.class).setAction(ServicioRadares.INICIAR);
        try {
            startForegroundService(i);
        } catch (Exception e) {
            web.evaluateJavascript("window.__radaresNativo && window.__radaresNativo.detenido()", null);
        }
    }

    private void abrirAfuera(Uri u) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u));
        } catch (Exception ignorada) {
            // no hay navegador para abrirlo
        }
    }

    private void mostrarSinConexion() {
        String html = "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'>"
                + "<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#11161d;color:#eaf0f5;"
                + "font:17px/1.4 system-ui,sans-serif;text-align:center;padding:24px;box-sizing:border-box}"
                + "a{display:inline-block;margin-top:18px;padding:14px 22px;border-radius:14px;background:#ffc21a;color:#1b1400;"
                + "font-weight:700;text-decoration:none}</style></head><body><div><h2>Sin conexión</h2>"
                + "<p>La primera vez, Radares BA necesita internet para descargar el mapa y los radares. "
                + "Después funciona aunque la señal sea mala.</p>"
                + "<a href='" + URL_APP + "'>Reintentar</a></div></body></html>";
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    /** Funciones que la app web puede llamar como window.RadaresAndroid.xxx(). */
    public final class Puente {
        @JavascriptInterface
        public void datos(String json) {
            ServicioRadares.guardarDatos(getApplicationContext(), json);
        }

        @JavascriptInterface
        public void iniciar() {
            runOnUiThread(() -> {
                if (tienePermisoUbicacion()) {
                    iniciarServicio();
                } else {
                    iniciarAlTenerPermiso = true;
                    pedirPermisos();
                }
            });
        }

        @JavascriptInterface
        public void detener() {
            runOnUiThread(() -> stopService(new Intent(MainActivity.this, ServicioRadares.class)));
        }

        @JavascriptInterface
        public void pantalla(boolean prender) {
            runOnUiThread(() -> {
                if (prender) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            });
        }

        @JavascriptInterface
        public void hablar(String texto) {
            Voz.get(getApplicationContext()).hablar(texto);
        }

        @JavascriptInterface
        public void probarSonido() {
            Voz v = Voz.get(getApplicationContext());
            v.pitido(2);
            v.hablarLuego("Radar de velocidad a 250 metros. Máxima 60.", 600);
        }

        @JavascriptInterface
        public String version() {
            return MainActivity.this.version();
        }

        /** Le avisa a la web que este servicio entiende la mano y los ramales de los peajes. */
        @JavascriptInterface
        public boolean peajesConSentido() {
            return true;
        }

        @JavascriptInterface
        public boolean activo() {
            return ServicioRadares.activo;
        }

        @JavascriptInterface
        public boolean bateriaLibre() {
            PowerManager pm = getSystemService(PowerManager.class);
            return pm == null || pm.isIgnoringBatteryOptimizations(getPackageName());
        }

        @JavascriptInterface
        @SuppressWarnings("BatteryLife")
        public void pedirBateria() {
            runOnUiThread(() -> {
                try {
                    startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                            Uri.parse("package:" + getPackageName())));
                } catch (Exception e) {
                    try {
                        startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
                    } catch (Exception ignorada) {
                        // el teléfono no tiene esa pantalla
                    }
                }
            });
        }
    }
}
