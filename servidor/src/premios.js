// Premio del mes: puntos por trabajo que Dirección aprueba y, sobre todo, por contactos que avanzan de verdad.
//  · Trabajo aprobado: 1 punto · Un «gracias» de Dirección: 3
//  · Empresa que pasa a conversación: 5 a cada agente que trabajó en ella · reunión o propuesta: 10 · cliente: 30
//  · Leo se lleva los contactos que llegan por la web, Google o anuncios; Marta los de gestorías, asociaciones y eventos.
import { q } from './db.js';
import { AGENTES, IDS } from './agentes.js';
import * as departamentos from './departamentos.js';

const PUNTOS_ETAPA = { conversacion: 5, reunion: 10, propuesta: 10, ganada: 30 };
const DUENO_ORIGEN = { web: 'leo', google: 'leo', anuncio: 'leo', redes: 'alex', gestoria: 'marta', asociacion: 'marta', evento: 'marta' };

export const mesDe = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit' }).format(d);
const limites = mes => {
  const [y, m] = mes.split('-').map(Number);
  return [`${mes}-01`, m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`];
};

/** Clasificación de un mes: [{ agente, puntos, motivos:{aprobados, gracias, avances} }] */
export async function clasificacion(mes = mesDe()) {
  const [desde, hasta] = limites(mes);
  const tabla = Object.fromEntries(IDS.filter(departamentos.trabaja).map(id => [id, { agente: id, puntos: 0, aprobados: 0, gracias: 0, avances: 0 }]));
  const sumar = (id, campo, n, pts) => { if (!tabla[id]) return; tabla[id][campo] += n; tabla[id].puntos += pts; };
  const rango = `>= ($1::date AT TIME ZONE 'Europe/Madrid') AND %s < ($2::date AT TIME ZONE 'Europe/Madrid')`;
  const en = col => `${col} ${rango.replace('%s', col)}`;
  const [apr, gr, av] = await Promise.all([
    q(`SELECT agente, count(*)::int n FROM aprobaciones WHERE estado NOT IN ('pendiente','descartada','cambios','sustituida') AND ${en('resuelta')} GROUP BY agente`, [desde, hasta]),
    q(`SELECT agente, count(*)::int n FROM aprendizajes WHERE tipo='gracias' AND ${en('creada')} GROUP BY agente`, [desde, hasta]),
    q(`SELECT DISTINCT ON (datos->>'empresa_id', datos->>'estado') datos->>'empresa_id' AS empresa_id, datos->>'estado' AS estado, e.origen
         FROM eventos ev JOIN empresas e ON e.id = ev.datos->>'empresa_id'
        WHERE datos->>'tipo' = 'avance' AND ${en('ts')}`, [desde, hasta]),
  ]);
  for (const r of apr.rows) sumar(r.agente, 'aprobados', r.n, r.n);
  for (const r of gr.rows) sumar(r.agente, 'gracias', r.n, r.n * 3);
  for (const a of av.rows) {
    const pts = PUNTOS_ETAPA[a.estado] || 0;
    if (!pts) continue;
    const quienes = new Set((await q(`SELECT DISTINCT agente FROM tareas WHERE empresa_id=$1 AND estado='hecha'`, [a.empresa_id])).rows.map(r => r.agente));
    if (DUENO_ORIGEN[a.origen]) quienes.add(DUENO_ORIGEN[a.origen]);
    for (const id of quienes) sumar(id, 'avances', 1, pts);
  }
  return Object.values(tabla).filter(t => t.puntos > 0).sort((a, b) => b.puntos - a.puntos || b.avances - a.avances);
}

/** El ganador del mes pasado, si ya se entregó. */
export async function ultimo() {
  return (await q(`SELECT * FROM premios ORDER BY mes DESC LIMIT 1`)).rows[0] || null;
}

/** Entrega el premio de un mes (una sola vez). Devuelve el ganador o null si nadie sumó puntos. */
export async function entregar(mes) {
  if ((await q(`SELECT 1 FROM premios WHERE mes=$1`, [mes])).rows.length) return null;
  const tabla = await clasificacion(mes);
  if (!tabla.length) return null;
  const g = tabla[0];
  await q(`INSERT INTO premios (mes, agente, puntos, detalle) VALUES ($1,$2,$3,$4) ON CONFLICT (mes) DO NOTHING`, [mes, g.agente, g.puntos, JSON.stringify(tabla.slice(0, 5))]);
  return { mes, ...g, nombre: AGENTES[g.agente]?.nombre ?? g.agente, podio: tabla.slice(0, 3) };
}

export const mesAnterior = (d = new Date()) => {
  const [y, m] = mesDe(d).split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};
