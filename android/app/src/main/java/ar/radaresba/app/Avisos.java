package ar.radaresba.app;

import java.util.HashMap;

/**
 * Cuándo avisar cada radar (la misma lógica que la app web). Solo decide: los sonidos los da el servicio.
 * El pip y la voz llegan unos segundos antes del radar, según la velocidad (a 60 km/h, 15 s son 250 m). En los
 * radares de velocidad, además, suenan pips los últimos 5 s y un sonido al pasarlo. Las cámaras de semáforo y de
 * control solo avisan con la voz.
 */
final class Avisos {
    interface Oyente {
        /** Pip y voz. */
        void aviso(int i, double dist);

        /** Empiezan los pips de los últimos segundos (ver restante). */
        void empiezaCuenta(int i);

        /** Lo pasaste; rapido: por encima de la máxima. */
        void pasado(int i, boolean rapido);

        /** Se cortan los pips sin pasarlo (doblaste antes, o quedó lejos). */
        void terminaCuenta();
    }

    static final int NADA = 0, AVISADO = 1, CUENTA = 2, PASADO = 3;

    // Por radar: fase, distancia anterior, distancia mínima desde el aviso y velocidad en ese punto.
    private final HashMap<Integer, double[]> estado = new HashMap<>();

    /** Radar más cercano adelante y en tu sentido (-1 si no hay), y su distancia. */
    int mejor = -1;
    double dMejor = Double.MAX_VALUE;

    /** Radar con los pips sonando (-1 si ninguno). */
    int cuenta = -1;
    private double cuentaD, cuentaV;
    private long cuentaT;
    private boolean cuentaFuera;

    void reiniciar() {
        estado.clear();
        cuenta = -1;
        mejor = -1;
        dMejor = Double.MAX_VALUE;
    }

    int fase(int i) {
        double[] e = estado.get(i);
        return e == null ? NADA : (int) e[0];
    }

    /** Una posición nueva del GPS. ahora: reloj en milisegundos (el mismo que después se pasa a restante). */
    void evaluar(Datos d, double la, double lo, double rumbo, double vel, long ahora, Oyente o) {
        mejor = -1;
        dMejor = Double.MAX_VALUE;
        for (int i = 0; i < d.n; i++) {
            if (Math.abs(d.lat[i] - la) > 0.03 || Math.abs(d.lon[i] - lo) > 0.04) {
                quitar(i, o);
                continue;
            }
            double dist = Datos.dist(la, lo, d.lat[i], d.lon[i]);
            if (dist > 3000) {
                quitar(i, o);
                continue;
            }
            double[] e = estado.get(i);
            if (e == null) {
                e = new double[]{NADA, dist, Double.MAX_VALUE, 0};
                estado.put(i, e);
            }
            boolean acercando = dist <= e[1] + 3;
            e[1] = dist;
            double ang = rumbo < 0 ? -1 : Datos.difAng(Datos.rumbo(la, lo, d.lat[i], d.lon[i]), rumbo);
            if (cuenta == i) {
                cuentaD = dist;
                cuentaT = ahora;
                cuentaV = vel;
                cuentaFuera = ang > 75 && dist > 40;
            }
            if (e[0] == AVISADO || e[0] == CUENTA) {
                if (dist < e[2]) {
                    e[2] = dist;
                    e[3] = vel;
                }
                // Ya lo pasaste: llegaste cerca y ahora quedó atrás (o te estás alejando).
                if (e[2] <= 100 && ((ang > 100 && dist < 120) || (dist > e[2] + 15 && vel > 5))) {
                    e[0] = PASADO;
                    if (cuenta == i) cuenta = -1;
                    o.pasado(i, d.vmax[i] > 0 && e[3] > d.vmax[i] + d.tolerancia);
                    continue;
                }
                // Doblaste antes de llegar.
                if (e[2] > 100 && dist > e[2] + 100) {
                    e[0] = NADA;
                    e[2] = Double.MAX_VALUE;
                    if (cuenta == i) {
                        cuenta = -1;
                        o.terminaCuenta();
                    }
                }
            }
            if (dist > Datos.AVISO_MAX + 300) {
                e[0] = NADA;
                e[2] = Double.MAX_VALUE;
            }
            boolean delante = ang < 0 ? dist < 120 : ang <= 40;
            boolean sentido = d.dir[i] < 0 || rumbo < 0 || Datos.difAng(d.dir[i], rumbo) <= 60;
            if (!delante || !sentido || e[0] == PASADO) continue;
            if (dist < dMejor) {
                dMejor = dist;
                mejor = i;
            }
            if (vel < 8) continue;
            if (e[0] == NADA && acercando && dist <= d.distAviso(vel)) {
                e[0] = AVISADO;
                e[2] = dist;
                e[3] = vel;
                o.aviso(i, dist);
            }
            if (e[0] == AVISADO && d.mideVelocidad(i) && dist <= vel / 3.6 * Datos.T_CUENTA + 3) {
                e[0] = CUENTA;
                cuenta = i;
                cuentaD = dist;
                cuentaV = vel;
                cuentaT = ahora;
                cuentaFuera = false;
                o.empiezaCuenta(i);
            }
        }
    }

    private void quitar(int i, Oyente o) {
        if (estado.remove(i) != null && cuenta == i) {
            cuenta = -1;
            o.terminaCuenta();
        }
    }

    /**
     * Segundos que faltan para llegar al radar de los pips. Entre una posición del GPS y la siguiente se estima
     * con la velocidad. Infinito si estás parado o mirando para otro lado; -1 si no hay pips.
     */
    double restante(long ahora) {
        if (cuenta < 0) return -1;
        double v = cuentaV / 3.6;
        if (v < 1.5 || cuentaFuera) return Double.POSITIVE_INFINITY;
        return (cuentaD - v * (ahora - cuentaT) / 1000.0) / v;
    }

    /** Sin posiciones del GPS hace rato: mejor cortar los pips. */
    boolean cuentaVieja(long ahora) {
        return cuenta >= 0 && ahora - cuentaT > 15000;
    }
}
