import React, { useCallback, useEffect, useRef, useState } from 'react';
import './panel.css';

// ============================================================================
// Utilidades compartidas por los configuradores (cine y avión)
// ============================================================================

export const easeInOutCubic = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

// hash determinista → [0,1). Con él la ocupación simulada es estable: subir
// el slider añade asientos vendidos sin cambiar los que ya lo estaban.
export const hash01 = (str) => {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h >>> 8) / 16777216;
};

// localStorage puede no existir o lanzar (modo privado, cuota llena)
export const readStorage = (key) => {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
};
export const writeStorage = (key, value) => {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch (err) { /* sin persistencia disponible */ }
};

// true en pantallas estrechas: el panel pasa a hoja inferior
export const useNarrow = (query = '(max-width: 640px)') => {
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return narrow;
};

// Libera todo lo que three.js tiene en GPU. renderer.dispose() por sí solo no
// toca geometrías, materiales ni texturas, y el contexto WebGL sigue vivo hasta
// que el recolector lo encuentra: al ir y volver entre configuradores se
// acumulan. `extras` recoge lo que no cuelga de la escena (plantillas de
// asiento, materiales sin usar, texturas alternativas…) en cualquier
// anidación de objetos y arrays.
export function disposeThree(scene, renderer, extras = []) {
  const geos = new Set();
  const mats = new Set();
  const texs = new Set();
  const seen = new Set();

  const addMaterial = (m) => {
    if (!m || mats.has(m)) return;
    mats.add(m);
    for (const k of Object.keys(m)) {
      const v = m[k];
      if (v && v.isTexture) texs.add(v);
    }
  };
  const addObject3D = (root) =>
    root.traverse((o) => {
      if (o.geometry) geos.add(o.geometry);
      if (o.material) {
        (Array.isArray(o.material) ? o.material : [o.material]).forEach(addMaterial);
      }
    });
  const collect = (v) => {
    if (!v || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (v.isObject3D) addObject3D(v);
    else if (v.isMaterial) addMaterial(v);
    else if (v.isBufferGeometry) geos.add(v);
    else if (v.isTexture) texs.add(v);
    else if (Array.isArray(v)) v.forEach(collect);
    else if (Object.getPrototypeOf(v) === Object.prototype) {
      Object.values(v).forEach(collect);
    }
  };

  collect(scene);
  extras.forEach(collect);
  if (scene.background && scene.background.isTexture) texs.add(scene.background);

  geos.forEach((g) => g.dispose());
  mats.forEach((m) => m.dispose());
  texs.forEach((t) => t.dispose());
  if (renderer) {
    renderer.dispose();
    renderer.forceContextLoss();
  }
}

// iconos outline (trazo, sin relleno — estilo Feather)
export const Ic = ({ children, size = 15, style }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
    style={{ verticalAlign: '-2px', ...style }}
  >
    {children}
  </svg>
);

export const icons = {
  menu: (
    <>
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </>
  ),
  x: (
    <>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </>
  ),
  map: (
    <>
      <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6" />
      <line x1="8" y1="2" x2="8" y2="18" />
      <line x1="16" y1="6" x2="16" y2="22" />
    </>
  ),
  eye: (
    <>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
    </>
  ),
  volOff: (
    <>
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <line x1="23" y1="9" x2="17" y2="15" />
      <line x1="17" y1="9" x2="23" y2="15" />
    </>
  ),
  volOn: (
    <>
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    </>
  ),
  download: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </>
  ),
  upload: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </>
  ),
  home: (
    <>
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </>
  ),
  back: (
    <>
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="12 19 5 12 12 5" />
    </>
  ),
  undo: (
    <>
      <polyline points="1 4 1 10 7 10" />
      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
    </>
  ),
  redo: (
    <>
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10" />
    </>
  ),
  play: <polygon points="5 3 19 12 5 21 5 3" />,
  camera: (
    <>
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </>
  ),
  share: (
    <>
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
    </>
  ),
  trash: (
    <>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </>
  ),
  ticket: (
    <>
      <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.83z" />
      <line x1="7" y1="7" x2="7.01" y2="7" />
    </>
  ),
  wing: (
    <path d="M17.8 19.2L16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z" />
  ),
  star: (
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
  ),
  ban: (
    <>
      <circle cx="12" cy="12" r="10" />
      <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
    </>
  ),
  eraser: (
    <>
      <path d="M20 20H7L3 16a2 2 0 0 1 0-2.83L13.17 3a2 2 0 0 1 2.83 0L21 8a2 2 0 0 1 0 2.83L11 20" />
      <line x1="7" y1="10" x2="14" y2="17" />
    </>
  ),
  check: <polyline points="20 6 9 17 4 12" />,
};

// ============================================================================
// Kit del panel lateral estilo Apple (clases en panel.css)
// ============================================================================

const nf = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2 });
export const fmtNum = (n) => nf.format(n);
const cf = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });
export const fmtEUR = (n) => cf.format(n);

// Panel lateral. `top` (cabecera, resumen, pestañas) queda fijo y es la zona
// de arrastre de la hoja en móvil: deslizarla hacia abajo la cierra.
export function Panel({ open, sheet, accent, label, onClose, top, children }) {
  const [drag, setDrag] = useState(0);
  const startY = useRef(null);
  const dragRef = useRef(0);

  const onDown = (e) => {
    if (!sheet || e.target.closest('button, input, [role="switch"]')) return;
    startY.current = e.clientY;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e) => {
    if (startY.current === null) return;
    dragRef.current = Math.max(0, e.clientY - startY.current);
    setDrag(dragRef.current);
  };
  const onUp = () => {
    if (startY.current === null) return;
    startY.current = null;
    if (dragRef.current > 90) onClose();
    dragRef.current = 0;
    setDrag(0);
  };

  return (
    <aside
      className={`t3d-panel${sheet ? ' is-sheet' : ''}${open ? '' : ' is-closed'}`}
      style={{
        '--accent': accent,
        ...(drag ? { transform: `translateY(${drag}px)`, transition: 'none' } : {}),
      }}
      aria-label={label}
      aria-hidden={!open}
      {...(open ? {} : { inert: '' })}
    >
      <div
        className="t3d-top"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        {sheet && <div className="t3d-grabber" />}
        {top}
      </div>
      <div className="t3d-scroll">{children}</div>
    </aside>
  );
}

// cabecera editorial: código de barras, antetítulo con acciones, título grande.
// acciones: [{ icon, label, onClick, disabled, shortcut }]
export const PanelHeader = ({ eyebrow, title, subtitle, onClose, actions = [] }) => (
  <div className="t3d-head">
    <span className="t3d-barcode" aria-hidden="true" />
    <div className="t3d-head-bar">
      <span className="t3d-eyebrow">{eyebrow}</span>
      {actions.map((a) => (
        <button
          key={a.label}
          className="t3d-icon-btn"
          aria-label={a.label}
          title={a.shortcut ? `${a.label} (${a.shortcut})` : a.label}
          disabled={a.disabled}
          onClick={a.onClick}
        >
          <Ic size={13}>{a.icon}</Ic>
        </button>
      ))}
      <button className="t3d-icon-btn" aria-label="Cerrar panel" title="Cerrar (Esc)" onClick={onClose}>
        <Ic size={13}>{icons.x}</Ic>
      </button>
    </div>
    <h2 className="t3d-title">
      {title}
      <svg viewBox="0 0 10 10" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="0.7">
        <path d="M1 9 9 1M3.2 1H9v5.8" />
      </svg>
    </h2>
    {subtitle && <p className="t3d-subtitle">{subtitle}</p>}
  </div>
);

// pestañas del panel (pastillas a todo lo ancho)
export const Tabs = ({ tabs, value, onChange }) => (
  <div className="t3d-tabs" role="tablist">
    {tabs.map((t) => (
      <button
        key={t.value}
        role="tab"
        aria-selected={value === t.value}
        onClick={() => onChange(t.value)}
      >
        {t.label}
      </button>
    ))}
  </div>
);

// barra flotante de herramientas sobre la escena (estilo barra de marcado)
// items: [{ key, label, icon, active, onClick, dot, shortcut } | { sep: true }]
export const ToolBar = ({ items, hidden, offsetX = 0, label }) => (
  <div
    className={`t3d-toolbar${hidden ? ' is-hidden' : ''}`}
    style={{ '--ox': `${offsetX}px` }}
    role="toolbar"
    aria-label={label}
    {...(hidden ? { inert: '' } : {})}
  >
    {items.map((it, i) =>
      it.sep ? (
        <span key={`sep${i}`} className="t3d-toolbar-sep" />
      ) : (
        <button
          key={it.key}
          aria-pressed={!!it.active}
          title={it.shortcut ? `${it.label} (${it.shortcut})` : it.label}
          onClick={it.onClick}
        >
          {it.dot ? <span className="t3d-dot" style={{ background: it.dot }} /> : <Ic size={15}>{it.icon}</Ic>}
          <span>{it.label}</span>
        </button>
      )
    )}
  </div>
);

// aviso breve tipo HUD de iOS; showToast('Texto') lo muestra 2 s
export function useToast() {
  const [msg, setMsg] = useState(null);
  const timer = useRef(0);
  const showToast = useCallback((text) => {
    window.clearTimeout(timer.current);
    setMsg({ text, id: Date.now() });
    timer.current = window.setTimeout(() => setMsg(null), 2000);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const toast = (
    <div className="t3d-toast-wrap" aria-live="polite">
      {msg && (
        <div key={msg.id} className="t3d-toast">
          {msg.text}
        </div>
      )}
    </div>
  );
  return { toast, showToast };
}

// atajos de teclado globales (se ignoran mientras se escribe en un campo)
export function useKeys(handler) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const onKey = (e) => {
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        if (e.key === 'Escape') e.target.blur();
        return;
      }
      ref.current(e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

// propuesta de compra: asientos, total y acciones
export const ProposalCard = ({ title, detail, total, onConfirm, onCancel }) => (
  <div className="t3d-proposal">
    <div className="t3d-proposal-title">{title}</div>
    {detail && <div className="t3d-proposal-detail">{detail}</div>}
    <div className="t3d-price">
      <span className="t3d-price-label">Total</span>
      <span className="t3d-price-value">{fmtEUR(total)}</span>
    </div>
    <div className="t3d-proposal-actions">
      <button className="t3d-btn is-primary" onClick={onConfirm}>Confirmar venta</button>
      <button className="t3d-btn is-round" aria-label="Cancelar propuesta" title="Cancelar" onClick={onCancel}>
        <Ic size={15}>{icons.x}</Ic>
      </button>
    </div>
  </div>
);

// preferencia de interfaz por configurador (pestaña abierta, panel visible)
export function useUiPref(key, initial) {
  const [val, setVal] = useState(() => ({ ...initial, ...(readStorage(key) || {}) }));
  useEffect(() => writeStorage(key, val), [key, val]);
  return [val, setVal];
}

// sección con título pequeño; `plain` deja el contenido sin tarjeta agrupada
export const Section = ({ label, footnote, plain, children }) => (
  <section className="t3d-section">
    {label && <div className="t3d-section-label">{label}</div>}
    {plain ? children : <div className="t3d-group">{children}</div>}
    {footnote && <div className="t3d-footnote">{footnote}</div>}
  </section>
);

export const Row = ({ label, dot, detail, strong, children }) => (
  <div className="t3d-row">
    <span className="t3d-row-label">
      {dot && <span className="t3d-dot" style={{ background: dot }} />}
      {label}
    </span>
    {detail !== undefined && (
      <span className={`t3d-row-detail${strong ? ' t3d-row-strong' : ''}`}>{detail}</span>
    )}
    {children}
  </div>
);

export const RowButton = ({ children, onClick }) => (
  <button className="t3d-row t3d-row-button" onClick={onClick}>
    {children}
  </button>
);

export const Stats = ({ items }) => (
  <div className="t3d-stats">
    {items.map((it) => (
      <div className="t3d-stat" key={it.label}>
        <div className="t3d-stat-label">
          <span className="t3d-dot" style={{ background: it.color }} />
          {it.label}
        </div>
        <div className="t3d-stat-value">{it.value}</div>
      </div>
    ))}
  </div>
);

export function SliderRow({ label, value, unit = '', min, max, step, onChange }) {
  const p = ((value - min) / (max - min)) * 100;
  return (
    <div className="t3d-row t3d-slider">
      <div className="t3d-slider-top">
        <span>{label}</span>
        <span className="t3d-row-detail">
          {fmtNum(value)}
          {unit}
        </span>
      </div>
      <input
        className="t3d-range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ '--p': `${p}%` }}
      />
    </div>
  );
}

export const Segmented = ({ options, value, onChange, label }) => (
  <div className="t3d-seg" role="group" aria-label={label}>
    {options.map((o) => (
      <button key={o.value} aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
        {o.label}
      </button>
    ))}
  </div>
);

export const Switch = ({ checked, onChange, label }) => (
  <button
    className="t3d-switch"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    onClick={() => onChange(!checked)}
  />
);

export const Stepper = ({ value, min, max, onChange, label }) => (
  <div className="t3d-stepper" role="group" aria-label={label}>
    <button aria-label="Menos" disabled={value <= min} onClick={() => onChange(value - 1)}>
      −
    </button>
    <span aria-live="polite">{value}</span>
    <button aria-label="Más" disabled={value >= max} onClick={() => onChange(value + 1)}>
      +
    </button>
  </div>
);

export const NumberRow = ({ label, dot, value, step = 1, onChange }) => (
  <label className="t3d-row">
    <span className="t3d-row-label">
      {dot && <span className="t3d-dot" style={{ background: dot }} />}
      {label}
    </span>
    <input
      className="t3d-num"
      type="number"
      min="0"
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value) || 0)}
    />
    <span className="t3d-row-detail">€</span>
  </label>
);

// baldosa estilo Centro de control; `active` la convierte en interruptor
export const Tile = ({ icon, label, active, onClick }) => (
  <button
    className="t3d-tile"
    onClick={onClick}
    {...(active === undefined ? {} : { 'aria-pressed': active })}
  >
    <span className="t3d-tile-icon">
      <Ic size={14}>{icon}</Ic>
    </span>
    {label}
  </button>
);

// figura técnica acotada: cabecera (FIG. · escala), dibujo y cota inferior.
// El dibujo usa unidades del viewBox (w × h); la cota va de x0 a x1.
export const Figure = ({ fig, scale, w = 260, h, x0, x1, dim, children }) => {
  const y = h + 10;
  return (
    <figure className="t3d-fig">
      <figcaption className="t3d-fig-head">
        <span>{fig}</span>
        {scale && <span>{scale}</span>}
      </figcaption>
      <svg viewBox={`0 0 ${w} ${h + 28}`} role="img" aria-label={`${fig}: ${dim}`}>
        {children}
        <path className="t3d-fig-dim" d={`M${x0} ${y}H${x1}M${x0} ${y - 4}v8M${x1} ${y - 4}v8`} />
        <text className="t3d-fig-text" x={(x0 + x1) / 2} y={y + 15} textAnchor="middle">
          {dim}
        </text>
      </svg>
    </figure>
  );
};
