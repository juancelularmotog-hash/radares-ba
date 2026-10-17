package ar.radaresba.app;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

import java.util.HashMap;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Voz y pitidos de los avisos. Usa el canal de "indicaciones de navegación": baja un momento
 * la música o las indicaciones de Google Maps mientras suena, y después las deja como estaban.
 */
final class Voz implements TextToSpeech.OnInitListener {
    private static Voz unica;

    static synchronized Voz get(Context c) {
        if (unica == null) unica = new Voz(c.getApplicationContext());
        return unica;
    }

    /** 1: peaje · 3: alarma por exceso · 4: límite de la calle. */
    static final int PEAJE = 1, EXCESO = 3, CALLE = 4;
    /** Radares: pip del aviso, pips de los últimos segundos (normal o pasado de la máxima) y al pasarlo. */
    static final int AVISO = 10, PIP = 11, PIP_RAPIDO = 12, APROBADO = 13, GRAVE = 14;

    private static final int TASA = 22050;
    private final AudioManager audio;
    private final Handler hilo = new Handler(Looper.getMainLooper());
    private final AudioAttributes atributosVoz = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build();
    private final AudioAttributes atributosPitido = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build();
    private final AudioFocusRequest foco;
    private final HashMap<Integer, short[]> sonidos = new HashMap<>();
    private TextToSpeech tts;
    private volatile boolean lista = false;
    private String pendiente;
    private int sonando = 0;
    private boolean conFoco = false;
    // Para que los pips no se pisen con la voz.
    private final AtomicInteger programadas = new AtomicInteger();   // voces que van a sonar en un momento
    private volatile String diciendo;                                 // la que está sonando
    private volatile long diciendoDesde;

    private Voz(Context c) {
        audio = c.getSystemService(AudioManager.class);
        foco = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                .setAudioAttributes(atributosVoz)
                .build();
        tts = new TextToSpeech(c, this);
    }

    @Override
    public void onInit(int estado) {
        if (estado != TextToSpeech.SUCCESS) return;
        int r = tts.setLanguage(new Locale("es", "AR"));
        if (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED) {
            r = tts.setLanguage(new Locale("es", "US"));
            if (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED) tts.setLanguage(new Locale("es"));
        }
        tts.setAudioAttributes(atributosVoz);
        tts.setSpeechRate(1.05f);
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override
            public void onStart(String id) {
            }

            @Override
            public void onDone(String id) {
                hilo.post(() -> termino(id));
            }

            @Override
            @SuppressWarnings("deprecation")
            public void onError(String id) {
                hilo.post(() -> termino(id));
            }

            @Override
            public void onStop(String id, boolean interrumpida) {
                // un aviso nuevo cortó al anterior
                hilo.post(() -> termino(id));
            }
        });
        lista = true;
        hilo.post(() -> {
            if (pendiente != null) {
                String p = pendiente;
                pendiente = null;
                hablarYa(p);
            }
        });
    }

    private void termino(String id) {
        if (id != null && id.equals(diciendo)) diciendo = null;
        terminoSonido();
    }

    void hablar(String texto) {
        if (texto == null || texto.isEmpty()) return;
        hilo.post(() -> hablarYa(texto));
    }

    void hablarLuego(String texto, long ms) {
        programadas.incrementAndGet();
        hilo.postDelayed(() -> {
            programadas.decrementAndGet();
            hablarYa(texto);
        }, ms);
    }

    // En el hilo principal.
    private void hablarYa(String texto) {
        if (texto == null || texto.isEmpty()) return;
        if (!lista) {
            pendiente = texto;
            return;
        }
        empiezaSonido();
        String id = "aviso" + System.nanoTime();
        diciendo = id;
        diciendoDesde = SystemClock.elapsedRealtime();
        int r = tts.speak(texto, TextToSpeech.QUEUE_FLUSH, null, id);
        if (r != TextToSpeech.SUCCESS) termino(id);
    }

    /** Si la voz está hablando o por hablar (si algo quedó colgado, a los 12 s deja de contar). */
    boolean hablando() {
        return programadas.get() > 0 || (diciendo != null && SystemClock.elapsedRealtime() - diciendoDesde < 12000);
    }

    void pitido(int tipo) {
        sonido(tipo);
    }

    void sonido(int tipo) {
        hilo.post(() -> {
            short[] pcm = sonidos.get(tipo);
            if (pcm == null) {
                pcm = sintetizar(notas(tipo));
                sonidos.put(tipo, pcm);
            }
            reproducir(pcm);
        });
    }

    /** Cada nota: frecuencia (Hz), inicio (s), duración (s), volumen (0-1), forma (0 senoidal, 1 triangular), caída (1: campanita). */
    private static double[][] notas(int tipo) {
        switch (tipo) {
            // Volúmenes altos: con música, el teléfono la baja un poco y los pips quedan por encima.
            case PEAJE:
                return new double[][]{{880, 0, 0.20, 0.8, 0, 0}};
            case EXCESO:
                return new double[][]{{1480, 0, 0.12, 0.85, 0, 0}, {1480, 0.17, 0.12, 0.85, 0, 0}, {1480, 0.34, 0.12, 0.85, 0, 0}};
            case AVISO:
                return new double[][]{{1046.5, 0, 0.13, 0.8, 0, 0}, {2093, 0, 0.09, 0.08, 0, 0}};
            case PIP:
                return new double[][]{{1318.5, 0, 0.065, 0.75, 0, 0}};
            case PIP_RAPIDO:
                return new double[][]{{1760, 0, 0.055, 0.65, 1, 0}};
            case APROBADO:
                return new double[][]{{1046.5, 0, 0.35, 0.7, 0, 1}, {2093, 0, 0.2, 0.07, 0, 1},
                        {1568, 0.13, 0.6, 0.72, 0, 1}, {3136, 0.13, 0.3, 0.07, 0, 1}};
            case GRAVE:
                return new double[][]{{523.25, 0, 0.2, 0.7, 1, 0}, {392, 0.24, 0.5, 0.72, 1, 1}};
            default: // CALLE
                return new double[][]{{520, 0, 0.18, 0.8, 0, 0}, {520, 0.26, 0.18, 0.8, 0, 0}};
        }
    }

    private static short[] sintetizar(double[][] notas) {
        double fin = 0;
        for (double[] n : notas) fin = Math.max(fin, n[1] + n[2]);
        int total = (int) ((fin + 0.05) * TASA);
        float[] mezcla = new float[total];
        for (double[] n : notas) {
            int ini = (int) (n[1] * TASA), dur = (int) (n[2] * TASA);
            boolean triangular = n[4] == 1, caida = n[5] == 1;
            for (int i = 0; i < dur && ini + i < total; i++) {
                double ataque = Math.min(1.0, i / (0.01 * TASA));
                double env = caida ? ataque * Math.exp(-5.0 * i / dur) : Math.min(ataque, (dur - i) / (0.035 * TASA));
                double fase = 2 * Math.PI * n[0] * i / TASA;
                double onda = triangular ? (2 / Math.PI) * Math.asin(Math.sin(fase)) : Math.sin(fase);
                mezcla[ini + i] += (float) (onda * Math.min(1.0, env) * n[3]);
            }
        }
        short[] pcm = new short[total];
        for (int i = 0; i < total; i++) pcm[i] = (short) (Math.max(-1f, Math.min(1f, mezcla[i])) * 32000);
        return pcm;
    }

    private void reproducir(short[] pcm) {
        try {
            AudioTrack pista = new AudioTrack.Builder()
                    .setAudioAttributes(atributosPitido)
                    .setAudioFormat(new AudioFormat.Builder()
                            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                            .setSampleRate(TASA)
                            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                            .build())
                    .setTransferMode(AudioTrack.MODE_STATIC)
                    .setBufferSizeInBytes(pcm.length * 2)
                    .build();
            pista.write(pcm, 0, pcm.length);
            empiezaSonido();
            pista.play();
            hilo.postDelayed(() -> {
                try {
                    pista.release();
                } catch (Exception ignorada) {
                    // ya estaba liberada
                }
                terminoSonido();
            }, pcm.length * 1000L / TASA + 150);
        } catch (Exception ignorada) {
            // sin audio disponible
        }
    }

    // ---------- Prueba (botón "Probar sonido y voz") ----------
    private long inicioPrueba, inicioPips;
    private final Runnable pasoPrueba = new Runnable() {
        @Override
        public void run() {
            long ahora = SystemClock.elapsedRealtime();
            if (inicioPips < 0) {
                // Espera a que termine la voz.
                if (hablando() && ahora - inicioPrueba < 9000) {
                    hilo.postDelayed(this, 200);
                    return;
                }
                inicioPips = ahora + 700;
                hilo.postDelayed(this, 700);
                return;
            }
            double resto = Datos.T_CUENTA - (ahora - inicioPips) / 1000.0;
            if (resto <= 0.15) {
                hilo.postDelayed(() -> sonido(APROBADO), 600);
                return;
            }
            sonido(PIP);
            hilo.postDelayed(this, (long) (Datos.intervaloPip(resto, false) * 1000));
        }
    };

    /** La secuencia completa de un radar: pip y voz, los pips de los últimos segundos y el sonido de aprobado. */
    void probarSecuencia() {
        hilo.post(() -> {
            hilo.removeCallbacks(pasoPrueba);
            sonido(AVISO);
            hablarLuego("Radar de velocidad a 250 metros. Máxima 60.", 350);
            inicioPrueba = SystemClock.elapsedRealtime();
            inicioPips = -1;
            hilo.postDelayed(pasoPrueba, 1200);
        });
    }

    // ---------- Foco de audio ----------
    // Se pide al empezar a sonar y se suelta un rato después de terminar: así los pips seguidos no hacen subir
    // y bajar la música entre uno y otro.
    private final Runnable soltarFoco = this::soltarFocoSiTermino;

    private void soltarFocoSiTermino() {
        if (sonando == 0 && conFoco) {
            conFoco = false;
            if (audio != null) audio.abandonAudioFocusRequest(foco);
        }
    }
    // Por las dudas: si algo quedó colgado, a los 15 s se devuelve el audio a las otras apps.
    private final Runnable liberar = this::liberarFoco;

    private void liberarFoco() {
        sonando = 0;
        hilo.removeCallbacks(soltarFoco);
        if (conFoco) {
            conFoco = false;
            if (audio != null) audio.abandonAudioFocusRequest(foco);
        }
    }

    private void empiezaSonido() {
        sonando++;
        hilo.removeCallbacks(soltarFoco);
        if (!conFoco && audio != null) {
            audio.requestAudioFocus(foco);
            conFoco = true;
        }
        hilo.removeCallbacks(liberar);
        hilo.postDelayed(liberar, 15000);
    }

    private void terminoSonido() {
        if (sonando > 0 && --sonando == 0) hilo.postDelayed(soltarFoco, 900);
    }
}
