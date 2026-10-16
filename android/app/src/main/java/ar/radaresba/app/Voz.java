package ar.radaresba.app;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

import java.util.Locale;

/**
 * Voz y pitidos de los avisos. Usa el canal de "indicaciones de navegación": baja un momento
 * la música o las indicaciones de Google Maps mientras habla, y después las deja como estaban.
 */
final class Voz implements TextToSpeech.OnInitListener {
    private static Voz unica;

    static synchronized Voz get(Context c) {
        if (unica == null) unica = new Voz(c.getApplicationContext());
        return unica;
    }

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
    private TextToSpeech tts;
    private volatile boolean lista = false;
    private String pendiente;
    private int sonando = 0;

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
                hilo.post(() -> terminoSonido());
            }

            @Override
            @SuppressWarnings("deprecation")
            public void onError(String id) {
                hilo.post(() -> terminoSonido());
            }

            @Override
            public void onStop(String id, boolean interrumpida) {
                // un aviso nuevo cortó al anterior
                hilo.post(() -> terminoSonido());
            }
        });
        lista = true;
        hilo.post(() -> {
            if (pendiente != null) {
                String p = pendiente;
                pendiente = null;
                hablar(p);
            }
        });
    }

    void hablar(String texto) {
        if (texto == null || texto.isEmpty()) return;
        hilo.post(() -> {
            if (!lista) {
                pendiente = texto;
                return;
            }
            empiezaSonido();
            int r = tts.speak(texto, TextToSpeech.QUEUE_FLUSH, null, "aviso" + System.nanoTime());
            if (r != TextToSpeech.SUCCESS) terminoSonido();
        });
    }

    void hablarLuego(String texto, long ms) {
        hilo.postDelayed(() -> hablar(texto), ms);
    }

    /** 1: primer aviso · 2: aviso cercano · 3: alarma por exceso · 4: límite de la calle. */
    void pitido(int tipo) {
        hilo.post(() -> {
            double[][] notas;
            switch (tipo) {
                case 1:
                    notas = new double[][]{{880, 0, 0.20, 0.5}};
                    break;
                case 2:
                    notas = new double[][]{{880, 0, 0.16, 0.5}, {1175, 0.20, 0.24, 0.5}};
                    break;
                case 3:
                    notas = new double[][]{{1480, 0, 0.12, 0.7}, {1480, 0.17, 0.12, 0.7}, {1480, 0.34, 0.12, 0.7}};
                    break;
                default:
                    notas = new double[][]{{520, 0, 0.18, 0.6}, {520, 0.26, 0.18, 0.6}};
            }
            reproducir(sintetizar(notas));
        });
    }

    /** Cada nota: frecuencia (Hz), inicio (s), duración (s), volumen (0-1). */
    private static short[] sintetizar(double[][] notas) {
        double fin = 0;
        for (double[] n : notas) fin = Math.max(fin, n[1] + n[2]);
        int total = (int) ((fin + 0.05) * TASA);
        float[] mezcla = new float[total];
        for (double[] n : notas) {
            int ini = (int) (n[1] * TASA), dur = (int) (n[2] * TASA);
            for (int i = 0; i < dur && ini + i < total; i++) {
                double env = Math.min(1.0, Math.min(i / (0.01 * TASA), (dur - i) / (0.04 * TASA)));
                mezcla[ini + i] += (float) (Math.sin(2 * Math.PI * n[0] * i / TASA) * env * n[3]);
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

    // Por las dudas: si algo quedó colgado, a los 15 s se devuelve el audio a las otras apps.
    private final Runnable liberar = this::liberarFoco;

    private void liberarFoco() {
        if (sonando > 0) {
            sonando = 0;
            if (audio != null) audio.abandonAudioFocusRequest(foco);
        }
    }

    private void empiezaSonido() {
        if (sonando++ == 0 && audio != null) audio.requestAudioFocus(foco);
        hilo.removeCallbacks(liberar);
        hilo.postDelayed(liberar, 15000);
    }

    private void terminoSonido() {
        if (sonando > 0 && --sonando == 0 && audio != null) audio.abandonAudioFocusRequest(foco);
    }
}
