import React, { Suspense, lazy, useEffect, useState } from 'react';

// cada configurador (y three.js con él) se descarga solo al entrar en él
const CinemaConfigurator = lazy(() => import('./CinemaConfigurator.jsx'));
const PlaneConfigurator = lazy(() => import('./PlaneConfigurator.jsx'));

// ============================================================================
// Página de entrada: elige experiencia (cine o avión).
// Rutas por hash: #/cine y #/avion, para que recargar mantenga la experiencia
// y el botón "atrás" del navegador vuelva a esta página. Una configuración de
// sala compartida (#c=...) entra directamente al cine para restaurarla.
// ============================================================================

const routeFromHash = () => {
  const h = window.location.hash;
  if (h.startsWith('#/avion')) return 'avion';
  if (h.startsWith('#/cine') || h.includes('c=')) return 'cine';
  return null;
};

const TITLES = {
  cine: 'Sala de cine · Ticketing3D',
  avion: 'Cabina de avión · Ticketing3D',
};

const Loader = ({ label }) => (
  <div style={st.loader} role="status">
    <div className="t3d-spin" style={st.spinner} />
    <span>{label}</span>
  </div>
);

export default function App() {
  const [app, setApp] = useState(routeFromHash);

  useEffect(() => {
    const onHash = () => setApp(routeFromHash());
    window.addEventListener('hashchange', onHash);
    window.addEventListener('popstate', onHash);
    return () => {
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('popstate', onHash);
    };
  }, []);

  useEffect(() => {
    document.title = TITLES[app] || 'Ticketing3D · Elige tu asiento en 3D';
  }, [app]);

  const go = (route) => {
    const hash = route ? `#/${route}` : '';
    if (hash === window.location.hash) return;
    if (route) window.location.hash = hash;
    else {
      // volver a la landing sin dejar un "#" colgando en la URL
      window.history.pushState(null, '', window.location.pathname);
    }
    setApp(route);
  };

  if (app) {
    const Comp = app === 'cine' ? CinemaConfigurator : PlaneConfigurator;
    return (
      <Suspense
        fallback={<Loader label={app === 'cine' ? 'Preparando la sala…' : 'Preparando la cabina…'} />}
      >
        <Comp onExit={() => go(null)} />
      </Suspense>
    );
  }

  return (
    <div style={st.page}>
      <style>{`
        .t3d-card { transition: transform .25s ease, box-shadow .25s ease, border-color .25s ease; }
        .t3d-card:hover { transform: translateY(-6px); box-shadow: 0 24px 60px rgba(0,0,0,.55); }
        .t3d-card:hover .t3d-go { opacity: 1; transform: translateX(0); }
        .t3d-card.cine:hover { border-color: rgba(216,35,42,.65); }
        .t3d-card.avion:hover { border-color: rgba(59,130,246,.65); }
      `}</style>

      <div style={st.glowRed} />
      <div style={st.glowBlue} />

      <header style={st.header}>
        <h1 style={st.title}>
          TICKETING<span style={{ color: '#d8232a' }}>3D</span>
        </h1>
        <p style={st.tagline}>
          Configuradores de espacios con visión real desde el asiento.
          Elige dónde quieres sentarte hoy:
        </p>
      </header>

      <div style={st.cards}>
        <button
          className="t3d-card cine"
          style={{ ...st.card, ...st.cardCine }}
          onClick={() => go('cine')}
        >
          <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="#ff6b70" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="7" width="20" height="15" rx="2" />
            <path d="M2 12l20-5" />
            <path d="M7 2l3 4.5" />
            <path d="M13 2l3 4.5" />
          </svg>
          <h2 style={st.cardTitle}>Sala de cine</h2>
          <p style={st.cardDesc}>
            Sala Kinepolis-style con butacas VIP, trailer en pantalla gigante,
            graderío paramétrico y venta de entradas con mejores-asientos.
          </p>
          <ul style={st.cardList}>
            <li>Butacas y assets del cine Splau original</li>
            <li>POV desde cada butaca + mapa de visión</li>
            <li>Aforo, precios y recaudación</li>
          </ul>
          <span className="t3d-go" style={{ ...st.go, color: '#ff6b70' }}>
            Entrar →
          </span>
        </button>

        <button
          className="t3d-card avion"
          style={{ ...st.card, ...st.cardAvion }}
          onClick={() => go('avion')}
        >
          <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="#7ab5ff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17.8 19.2L16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z" />
          </svg>
          <h2 style={st.cardTitle}>Cabina de avión</h2>
          <p style={st.cardDesc}>
            Flota low-cost A319 · A320 · A321 con zonas tarifarias Space One,
            Space Plus y Space. Elige asiento viendo lo que de verdad compras:
            ¿te toca el ala en la ventanilla?
          </p>
          <ul style={st.cardList}>
            <li>POV con vista real por la ventanilla</li>
            <li>Zonas y salidas de emergencia por modelo, sin fila 13</li>
            <li>Viajamos juntos: mejores asientos contiguos</li>
          </ul>
          <span className="t3d-go" style={{ ...st.go, color: '#7ab5ff' }}>
            Entrar →
          </span>
        </button>
      </div>

      <footer style={st.footer}>
        Un motor · dos espacios — Three.js r128 sin dependencias de escena
      </footer>
    </div>
  );
}

const st = {
  page: {
    position: 'fixed',
    inset: 0,
    overflow: 'auto',
    background: '#0b0a0e',
    color: '#e8e6ec',
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 34,
    padding: '40px 20px',
  },
  glowRed: {
    position: 'fixed',
    width: 520,
    height: 520,
    left: '12%',
    top: '8%',
    borderRadius: '50%',
    background: 'radial-gradient(circle, rgba(216,35,42,.14), transparent 65%)',
    pointerEvents: 'none',
  },
  glowBlue: {
    position: 'fixed',
    width: 560,
    height: 560,
    right: '10%',
    bottom: '5%',
    borderRadius: '50%',
    background: 'radial-gradient(circle, rgba(59,130,246,.13), transparent 65%)',
    pointerEvents: 'none',
  },
  header: { textAlign: 'center', maxWidth: 640 },
  title: { fontSize: 'clamp(34px, 6vw, 54px)', letterSpacing: 2, margin: 0 },
  tagline: { opacity: 0.7, fontSize: 15.5, lineHeight: 1.6, marginTop: 12 },
  cards: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 26,
    justifyContent: 'center',
    maxWidth: 980,
  },
  card: {
    width: 'min(400px, 92vw)',
    textAlign: 'left',
    padding: '30px 28px 26px',
    borderRadius: 20,
    border: '1px solid rgba(255,255,255,.13)',
    cursor: 'pointer',
    color: '#e8e6ec',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    boxShadow: '0 14px 44px rgba(0,0,0,.45)',
  },
  cardCine: {
    background:
      'linear-gradient(160deg, rgba(70,14,18,.55), rgba(16,10,12,.9) 55%), #14090b',
  },
  cardAvion: {
    background:
      'linear-gradient(160deg, rgba(20,44,86,.55), rgba(9,12,20,.9) 55%), #090d16',
  },
  cardTitle: { margin: 0, fontSize: 24, letterSpacing: 0.5 },
  cardDesc: { margin: 0, opacity: 0.75, fontSize: 13.5, lineHeight: 1.55 },
  cardList: {
    margin: 0,
    paddingLeft: 18,
    opacity: 0.65,
    fontSize: 12.5,
    lineHeight: 1.8,
  },
  go: {
    marginTop: 6,
    fontWeight: 700,
    fontSize: 14,
    opacity: 0,
    transform: 'translateX(-6px)',
    transition: 'opacity .25s, transform .25s',
  },
  footer: { opacity: 0.35, fontSize: 12 },
  loader: {
    position: 'fixed',
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    background: '#0b0a0e',
    color: 'rgba(232,230,236,.7)',
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
    fontSize: 14,
  },
  spinner: {
    width: 34,
    height: 34,
    borderRadius: '50%',
    border: '3px solid rgba(255,255,255,.12)',
    borderTopColor: '#d8232a',
  },
};
