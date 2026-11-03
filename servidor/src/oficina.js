// La información común: todos los agentes pueden consultarla y ven una pizarra corta al empezar cada tarea. Las claves (ajustes) no pasan por aquí.
import { q, ajuste } from './db.js';
import * as busqueda from './busqueda.js';
import * as departamentos from './departamentos.js';

export const CONSULTAS = ['informes', 'actividad', 'trabajo', 'notas', 'aprendido', 'planes', 'reunion'];

/** Lo que todos tienen que saber antes de decidir. Corto, porque va en cada tarea. */
export async function pizarra() {
  const lineas = [];
  const obj = departamentos.trabaja('lucia') ? await busqueda.leer() : null;   // sin Investigación, nadie busca y no hay nada que contar
  if (obj?.cantidad === 0) lineas.push('Esta oficina no busca empresas nuevas: se trabaja con lo que hay y con lo que entra.');
  else if (obj) lineas.push(`Dirección quiere encontrar ${obj.cantidad} empresas ${obj.periodo === 'dia' ? 'al día' : 'a la semana'}; llevamos ${(await busqueda.progreso(obj)).encontradas}.`);
  const prioridades = (await ajuste('reunion_ultima', null))?.prioridades;
  if (prioridades?.length) lineas.push(`Prioridades de la última reunión: ${prioridades.join('; ')}.`);
  const planes = (await q(`SELECT texto FROM objetivos WHERE estado = 'en_marcha' ORDER BY id DESC LIMIT 3`)).rows;
  if (planes.length) lineas.push(`Planes en marcha: ${planes.map(p => p.texto.slice(0, 120)).join('; ')}.`);
  return lineas.length ? `## Pizarra de la oficina\n${lineas.map(l => `- ${l}`).join('\n')}` : '';
}

/** Consulta común bajo demanda. «texto» filtra; se devuelve recortado para que no encarezca la tarea. */
export async function consultar({ que, texto, limite } = {}) {
  const n = Math.min(Math.max(Number(limite) || 10, 1), 30);
  const f = texto ? `%${String(texto).slice(0, 80)}%` : null;
  switch (que) {
    case 'informes': return (await q(`SELECT id, agente, tipo, titulo, left(texto, 1500) AS texto, empresa_id, creada FROM informes WHERE $1::text IS NULL OR titulo ILIKE $1 OR texto ILIKE $1 ORDER BY id DESC LIMIT $2`, [f, n])).rows;
    case 'actividad': return (await q(`SELECT ts, datos->>'agente' AS agente, datos->>'texto' AS texto FROM eventos WHERE datos->>'tipo' = 'log' AND ($1::text IS NULL OR datos->>'texto' ILIKE $1) ORDER BY id DESC LIMIT $2`, [f, n])).rows;
    case 'trabajo': return (await q(`SELECT creado, autor, para, left(texto, 500) AS texto, empresa_id FROM chat WHERE canal = 'trabajo' AND ($1::text IS NULL OR texto ILIKE $1) ORDER BY id DESC LIMIT $2`, [f, n])).rows;
    case 'notas': return (await q(`SELECT agente, texto, creada FROM memoria WHERE activa AND ($1::text IS NULL OR texto ILIKE $1) ORDER BY creada DESC LIMIT $2`, [f, n])).rows;
    case 'aprendido': return (await q(`SELECT agente, tipo, texto, creada FROM aprendizajes WHERE activo AND tipo IN ('regla', 'correccion') AND ($1::text IS NULL OR texto ILIKE $1) ORDER BY id DESC LIMIT $2`, [f, n])).rows;
    case 'planes': return (await q(`SELECT id, texto, estado, resumen, medida, creado FROM objetivos WHERE $1::text IS NULL OR texto ILIKE $1 ORDER BY id DESC LIMIT $2`, [f, n])).rows;
    case 'reunion': { const r = await ajuste('reunion_ultima', null); return r ? { fecha: r.fecha, resumen: r.resumen, prioridades: r.prioridades, informe_id: r.informe_id } : { nota: 'Aún no ha habido reunión.' }; }
    default: throw new Error(`Elige qué consultar: ${CONSULTAS.join(', ')}.`);
  }
}
