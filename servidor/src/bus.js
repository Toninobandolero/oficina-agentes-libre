// Bus de eventos: guarda lo importante en la base de datos y lo emite al panel por SSE.
import { q } from './db.js';
import { efectiva as _efectiva } from './prioridad.js';

const clientes = new Set();
const agentes = {};            // estado vivo de cada agente
let embudoPrevio = {};
const PERSISTENTES = new Set(['log', 'traspaso', 'aprobacion', 'aprobacion_resuelta', 'cliente', 'avance', 'premio']);

export function suscribir(res) {
  clientes.add(res);
  res.on('close', () => clientes.delete(res));
}

/** ¿Hay algún panel abierto ahora mismo? (para no repetirte por Telegram lo que ya estás viendo) */
export const panelAbierto = () => clientes.size > 0;

export async function emitir(ev) {
  ev.ts = ev.ts || new Date().toISOString();
  if (ev.tipo === 'estado') agentes[ev.agente] = { estado: ev.estado, tarea: ev.tarea, icono: ev.icono };
  if (PERSISTENTES.has(ev.tipo)) {
    try { await q('INSERT INTO eventos(datos) VALUES ($1)', [ev]); } catch (e) { console.error('No se pudo guardar el evento', e.message); }
  }
  const linea = `data: ${JSON.stringify(ev)}\n\n`;
  for (const c of clientes) { try { c.write(linea); } catch { clientes.delete(c); } }
}

/** Línea de actividad. extra: { empresa_id, informe_id } para que el panel enlace la ficha o el informe. */
export const log = (agente, texto, extra = {}) => emitir({ tipo: 'log', agente, texto, ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v != null)) });

/** Guarda un informe o una respuesta larga para poder abrirlo desde la actividad. Devuelve su id. */
export async function guardarInforme({ agente, tipo = 'informe', titulo = null, texto, empresa_id = null }) {
  const r = await q(`INSERT INTO informes (agente, tipo, titulo, texto, empresa_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [agente, tipo, titulo, texto, empresa_id]);
  return r.rows[0].id;
}
export const estado = (agente, est, tarea, icono) => {
  const previo = agentes[agente] || {};
  return emitir({ tipo: 'estado', agente, estado: est, tarea: tarea ?? previo.tarea ?? '', icono: icono ?? previo.icono ?? 'zz' });
};
export const estadoDe = id => agentes[id];

export async function calcularEmbudo() {
  const r = await q(`SELECT
      count(*)::int                                   AS universo,
      count(*) FILTER (WHERE etapa_max >= 1)::int     AS puntuadas,
      count(*) FILTER (WHERE etapa_max >= 2)::int     AS dossier,
      count(*) FILTER (WHERE etapa_max >= 3)::int     AS contactadas,
      count(*) FILTER (WHERE etapa_max >= 4)::int     AS conversacion,
      count(*) FILTER (WHERE etapa_max >= 5)::int     AS reunion,
      count(*) FILTER (WHERE etapa_max >= 6)::int     AS propuesta,
      count(*) FILTER (WHERE etapa_max >= 7)::int     AS ganadas
    FROM empresas`);
  return r.rows[0];
}

export async function emitirEmbudo() {
  const e = await calcularEmbudo();
  for (const [etapa, valor] of Object.entries(e)) {
    if (embudoPrevio[etapa] !== valor) await emitir({ tipo: 'embudo', etapa, valor });
  }
  embudoPrevio = e;
}

const prioridadEfectiva = r => _efectiva(r, new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()));

export async function snapshot(extra = {}) {
  const [embudo, pend, logs] = await Promise.all([
    calcularEmbudo(),
    q(`SELECT a.id, a.agente, a.tipo AS clase, a.titulo, a.texto, a.opciones, a.creada, a.prioridad, a.prioridad_motivo, a.caduca, a.canal, a.fecha_prevista, a.pospuesta, a.perfil_url, a.buscar,
              EXISTS (SELECT 1 FROM imagenes i WHERE i.aprobacion_id = a.id) AS imagen,
              e.nombre AS empresa, e.linkedin_url, e.linkedin_empresa, e.decisor, a.empresa_id,
              coalesce(nullif(e.telefono, ''), (SELECT c.telefono FROM contactos c WHERE c.empresa_id = e.id AND NOT c.borrado AND c.telefono IS NOT NULL ORDER BY c.preferente DESC, c.id LIMIT 1)) AS telefono
         FROM aprobaciones a LEFT JOIN empresas e ON e.id = a.empresa_id
        WHERE a.estado = 'pendiente' ORDER BY a.creada`),
    q(`SELECT datos FROM eventos WHERE datos->>'tipo' = 'log' ORDER BY id DESC LIMIT 40`),
  ]);
  embudoPrevio = embudo;
  return {
    tipo: 'snapshot',
    agentes: agentes,
    embudo,
    aprobaciones: pend.rows.map(r => ({ ...r, prio: prioridadEfectiva(r) })),
    logs: logs.rows.map(r => r.datos).reverse(),
    ...extra,
  };
}
