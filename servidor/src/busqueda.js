// Cuántas empresas nuevas quiere encontrar Dirección y cuánto cuesta. Sin objetivo, Lucía busca cuando la cola se vacía; con 0, no busca.
import { q, ajuste, fijarAjuste } from './db.js';
import { config } from './config.js';
import * as presupuesto from './presupuesto.js';

const TZ = 'Europe/Madrid';
const SEMANAS_MES = 52 / 12, DIAS_LABORABLES = 5;
// Referencia hasta tener datos propios: la medición del 28-oct-2026 ($ por empresa o por tarea) y un 60 % de A y B supuesto.
const REFERENCIA = { lucia: 0.0245, mateo: 0.0445, carmen: 0.054, javi: 0.07, pct_ab: 0.6 };
const MIN_MUESTRAS = 5;
const inicioDe = unidad => `date_trunc('${unidad}', now() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}'`;

export async function leer() {
  const o = await ajuste('objetivo_empresas', null);
  return Number.isInteger(o?.cantidad) ? { cantidad: o.cantidad, periodo: o.periodo === 'dia' ? 'dia' : 'semana' } : null;
}

/** { cantidad, periodo: 'semana' | 'dia' }. Vacío quita el objetivo; 0 significa que esta oficina no busca. */
export async function fijar({ cantidad, periodo } = {}) {
  if (cantidad === '' || cantidad == null) { await fijarAjuste('objetivo_empresas', null); return null; }
  const n = Number(cantidad);
  if (!Number.isInteger(n) || n < 0 || n > 500) throw new Error('Pon un número entero de empresas entre 0 y 500.');
  await fijarAjuste('objetivo_empresas', { cantidad: n, periodo: periodo === 'dia' ? 'dia' : 'semana' });
  return leer();
}

/** Lo que cuesta de verdad cada eslabón en esta oficina (60 días). Lo que aún no tiene muestras sale de la referencia. */
async function costes() {
  const t = await q(`SELECT t.agente, avg(x.usd)::float AS usd, count(*)::int AS n
      FROM (SELECT tarea_id, sum(usd) AS usd FROM gasto WHERE tarea_id IS NOT NULL GROUP BY 1) x JOIN tareas t ON t.id = x.tarea_id
     WHERE t.estado = 'hecha' AND t.creada > now() - interval '60 days'
       AND ((t.agente = 'mateo' AND t.instruccion LIKE 'Puntúa la empresa%') OR (t.agente = 'carmen' AND t.instruccion LIKE 'Prepara el dossier%')
            OR (t.agente = 'javi' AND t.instruccion LIKE 'Prepara el primer contacto%'))
     GROUP BY 1`);
  const o = (await q(`SELECT (SELECT coalesce(sum(usd), 0) FROM gasto WHERE agente = 'lucia' AND ts > now() - interval '60 days')::float AS lucia_usd,
      (SELECT count(*) FROM empresas WHERE origen = 'busqueda' AND creada > now() - interval '60 days')::int AS encontradas,
      (SELECT count(*) FROM empresas WHERE categoria IS NOT NULL AND creada > now() - interval '60 days')::int AS puntuadas,
      (SELECT count(*) FROM empresas WHERE categoria IN ('A', 'B') AND creada > now() - interval '60 days')::int AS ab`)).rows[0];
  const propios = Object.fromEntries(t.rows.filter(x => x.n >= MIN_MUESTRAS).map(x => [x.agente, x.usd]));
  if (o.encontradas >= MIN_MUESTRAS && o.lucia_usd > 0) propios.lucia = o.lucia_usd / o.encontradas;
  if (o.puntuadas >= MIN_MUESTRAS) propios.pct_ab = o.ab / o.puntuadas;
  const n = Object.keys(propios).length;
  return { ...REFERENCIA, ...propios, base: n === 0 ? 'referencia' : n === Object.keys(REFERENCIA).length ? 'oficina' : 'mezcla' };
}

const MARGEN = { referencia: 2, mezcla: 1.5, oficina: 1.25 };
const r2 = n => Math.round(n * 100) / 100;

/** Coste al mes y trabajo en la mesa de Dirección. Es una estimación: no cuenta seguimientos, respuestas, lo fijo de la oficina ni a Lola. */
export async function estimar({ cantidad, periodo } = {}) {
  const n = Number(cantidad);
  if (!Number.isFinite(n) || n < 0) throw new Error('Pon un número de empresas.');
  const c = await costes();
  const semana = periodo === 'dia' ? n * DIAS_LABORABLES : n;
  const eurEmpresa = (c.lucia + c.mateo + c.pct_ab * (c.carmen + c.javi)) * config.usdEur;
  const eurMes = semana * SEMANAS_MES * eurEmpresa;
  const g = await presupuesto.gastoMes();
  const presupuestoMes = (g.modo === 'semanal' ? g.base * SEMANAS_MES : g.base) + (g.creditos_claude?.total || 0) * config.usdEur;
  const maximo = eurMes * MARGEN[c.base];
  return { empresas_semana: semana, empresas_mes: Math.round(semana * SEMANAS_MES), eur_empresa: r2(eurEmpresa), eur_mes_min: r2(eurMes), eur_mes_max: r2(maximo),
    base: c.base, pct_ab: Math.round(c.pct_ab * 100), contactos_semana: Math.round(semana * c.pct_ab), contactos_dia: r2(semana * c.pct_ab / DIAS_LABORABLES),
    presupuesto_mes: r2(presupuestoMes), cabe: maximo <= presupuestoMes };
}

/** Cuántas lleva y cuántas tocaría llevar hoy. Con objetivo semanal se reparte de lunes a viernes para no gastarlo todo el lunes. */
export async function progreso(obj) {
  const unidad = obj.periodo === 'dia' ? 'day' : 'week';
  const encontradas = (await q(`SELECT count(*)::int n FROM empresas WHERE origen = 'busqueda' AND creada >= ${inicioDe(unidad)}`)).rows[0].n;
  const dow = (await q(`SELECT extract(isodow FROM now() AT TIME ZONE '${TZ}')::int d`)).rows[0].d;
  const meta = obj.periodo === 'dia' ? obj.cantidad : Math.ceil(obj.cantidad * Math.min(dow, DIAS_LABORABLES) / DIAS_LABORABLES);
  return { encontradas, meta_hoy: meta, falta_hoy: Math.max(0, meta - encontradas) };
}

/** Lo que se le pide a la cadena al día con este objetivo (0 sin objetivo). */
export const porDia = obj => !obj ? 0 : obj.periodo === 'dia' ? obj.cantidad : Math.ceil(obj.cantidad / DIAS_LABORABLES);

export async function estado() {
  const objetivo = await leer();
  return { objetivo, progreso: objetivo?.cantidad ? await progreso(objetivo) : null, estimacion: objetivo ? await estimar(objetivo) : null };
}
