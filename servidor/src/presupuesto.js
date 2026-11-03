// Control de gasto de la API de Claude. Si se llega al tope mensual, el equipo se pausa solo.
import { q, ajuste, fijarAjuste } from './db.js';
import { config } from './config.js';

export class PresupuestoAgotado extends Error {}

/** Registra el coste de una llamada en USD (OpenRouter lo devuelve en usage.cost; con Anthropic se calcula con sus precios, en llm.js). */
export async function registrar(agente, tareaId, modelo, usd, uso = {}, busquedas = 0) {
  const coste = Number.isFinite(usd) && usd > 0 ? usd : estimar(uso);
  await q(`INSERT INTO gasto (agente, tarea_id, modelo, tokens_in, tokens_out, busquedas, usd, proveedor) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [agente, tareaId, modelo, uso.prompt_tokens || 0, uso.completion_tokens || 0, busquedas, coste, uso.proveedor || null]);
  return coste;
}
// Si no llegara el coste, se estima por lo alto (como un modelo caro)
const estimar = (uso = {}) => ((uso.prompt_tokens || 0) * 5 + (uso.completion_tokens || 0) * 25) / 1e6;

// ---------- Presupuesto ----------
// Dirección elige un tope por semana o por mes (por defecto, PRESUPUESTO_EUR al mes), puede darle un empujón al periodo
// en curso (+10 €, +25 €…) o dejar una semana a 0 (vacaciones). Y el modo turbo: el equipo trabaja sin topes diarios
// (buscar, puntuar y preparar dossiers) mientras quede presupuesto. Todo se cambia desde el panel o por Telegram.
const TZ = 'Europe/Madrid';
export async function ajustes() {
  const a = await ajuste('presupuesto', null);
  return { modo: a?.modo === 'semanal' ? 'semanal' : 'mensual', eur: Number.isFinite(Number(a?.eur)) ? Number(a.eur) : config.presupuestoEur,
    extras: a?.extras || {}, fijo: a?.fijo || {}, turbo: Boolean(a?.turbo),
    creditos: Number(a?.creditos) || 0 };   // créditos de API de Claude que trae el plan cada mes ($, como los enseña platform.claude.com); 0 = sin apuntar
}
const partes = (d = new Date()) => Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(d).map(x => [x.type, x.value]));
/** Clave del periodo en curso: «2026-10» (mes) o «2026-10-26» (semana: el lunes en que empieza). */
export function periodo(modo, d = new Date()) {
  const p = partes(d);
  if (modo !== 'semanal') return `${p.year}-${p.month}`;
  const dia = new Date(`${p.year}-${p.month}-${p.day}T12:00:00Z`), dow = (dia.getUTCDay() + 6) % 7;   // lunes = 0
  dia.setUTCDate(dia.getUTCDate() - dow);
  return dia.toISOString().slice(0, 10);
}
const desdeSql = modo => modo === 'semanal' ? `date_trunc('week', now() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}'` : `date_trunc('month', now() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}'`;

/** Lo gastado en el periodo en curso y su tope (se llama gastoMes por compatibilidad: puede ser la semana). */
export async function gastoMes() {
  const a = await ajustes(), per = periodo(a.modo);
  // Por proveedor: lo de Claude sale de los créditos de API del plan; lo de OpenRouter es pago por uso (lo antiguo, sin proveedor, era OpenRouter)
  const r = await q(`SELECT coalesce(proveedor,'openrouter') AS p, coalesce(sum(usd),0)::float AS usd FROM gasto WHERE ts >= ${desdeSql(a.modo)} GROUP BY 1`);
  const usd = Object.fromEntries(r.rows.map(x => [x.p, x.usd]));
  const r2 = n => Math.round(n * 100) / 100;
  const por_proveedor = Object.fromEntries(r.rows.map(x => [x.p, r2(x.usd * config.usdEur)]));
  // Los créditos de Claude del plan ($ al mes) ya están pagados: lo que Claude gasta de ahí no es gasto, se descuenta de los créditos.
  // Al tope solo va lo que se paga de verdad: OpenRouter y lo de Claude que pase de los créditos. (La API no da el saldo: se resta.)
  // ponytail: créditos por mes natural, y en modo semanal la semana dispone de todo lo que quede del mes; prorratear si Dirección usa el semanal
  let creditos_claude = null, cubierto = 0;
  if (a.creditos) {
    const mes = (await q(`SELECT coalesce(sum(usd),0)::float AS usd FROM gasto WHERE proveedor='anthropic' AND ts >= ${desdeSql('mensual')}`)).rows[0].usd;
    const del_periodo = Math.max(0, a.creditos - (mes - (usd.anthropic || 0)));   // lo que le queda al periodo: lo gastado antes en el mes ya se lo comió
    cubierto = Math.min(usd.anthropic || 0, del_periodo) * config.usdEur;
    creditos_claude = { total: a.creditos, gastado: r2(mes), quedan: r2(Math.max(0, a.creditos - mes)), del_periodo: r2(del_periodo * config.usdEur) };
  }
  const eur = Object.values(usd).reduce((n, x) => n + x, 0) * config.usdEur - cubierto;
  const base = Number.isFinite(Number(a.fijo[per])) ? Number(a.fijo[per]) : a.eur;
  const extra = Number(a.extras[per] || 0);
  return { eur: r2(eur), limite: r2(base + extra), base, extra, modo: a.modo, periodo: a.modo === 'semanal' ? 'semana' : 'mes', clave: per, turbo: a.turbo, por_proveedor, creditos_claude };
}

/** Cambia el presupuesto: { modo, eur } (lo normal), { extra: 10 } (empujón al periodo en curso),
 *  { esteperiodo: 0 } (tope solo para este periodo, p. ej. vacaciones) o { turbo: true|false }. */
export async function cambiar(c = {}) {
  const a = await ajustes();
  const n = v => { const x = Number(String(v).replace(',', '.')); if (!Number.isFinite(x) || x < 0 || x > 5000) throw new Error('Pon una cantidad entre 0 y 5000.'); return Math.round(x * 100) / 100; };
  if (c.modo) a.modo = c.modo === 'semanal' ? 'semanal' : 'mensual';
  if (c.eur !== undefined && c.eur !== '') a.eur = n(c.eur);
  const per = periodo(a.modo);
  if (c.extra !== undefined) a.extras = { ...a.extras, [per]: Math.round(((Number(a.extras[per]) || 0) + n(c.extra)) * 100) / 100 };
  if (c.esteperiodo !== undefined) { const f = { ...a.fijo }; if (c.esteperiodo === null || c.esteperiodo === '') delete f[per]; else f[per] = n(c.esteperiodo); a.fijo = f; }
  if (c.turbo !== undefined) a.turbo = Boolean(c.turbo);
  if (c.creditos !== undefined) a.creditos = c.creditos === '' || c.creditos === null ? 0 : n(c.creditos);
  // Solo se guardan los periodos recientes
  const recientes = o => Object.fromEntries(Object.entries(o).sort().slice(-12));
  await fijarAjuste('presupuesto', { ...a, extras: recientes(a.extras), fijo: recientes(a.fijo) });
  ritmoCache = { t: 0, v: null };
  const g = await gastoMes();
  // Si el equipo estaba parado por el presupuesto y ahora hay margen, vuelve a trabajar
  await revisarPausa();
  return g;
}

/** Si el equipo se paró por el presupuesto y ya hay margen (empieza otra semana o mes, o Dirección lo ha subido), sigue solo. */
export async function revisarPausa() {
  const motor = await import('./motor.js');
  if (!(await motor.estaPausado()) || !/presupuesto/i.test(String(await ajuste('pausa_motivo', '')))) return false;
  const g = await gastoMes();
  if (g.eur >= g.limite) return false;
  await motor.reanudar();
  return true;
}

/** Lanza PresupuestoAgotado si se ha llegado al tope. Devuelve true la primera vez que se pasa del 80 %. */
export async function comprobar() {
  const { eur, limite, periodo: per, clave: cl } = await gastoMes();
  if (eur >= limite) throw new PresupuestoAgotado(`Presupuesto ${per === 'semana' ? 'de la semana' : 'del mes'} agotado: ${eur.toFixed(2)} € de ${limite} €`);
  if (eur >= limite * 0.8) {
    const clave = 'aviso80:' + cl;
    if (!(await ajuste(clave))) { await fijarAjuste(clave, true); return true; }
  }
  return false;
}

/** Consumo de hoy, esta semana (desde el lunes) y este mes, con el reparto por agente y por proveedor. En euros. */
export async function resumen() {
  const dia = `date_trunc('day', now() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}'`, sem = desdeSql('semanal'), mes = desdeSql('mensual');
  const r = await q(`SELECT (ts >= ${dia}) AS hoy, (ts >= ${sem}) AS semana, (ts >= ${mes}) AS mes,
                            coalesce(agente, 'sistema') AS agente, coalesce(proveedor, 'otro') AS proveedor,
                            sum(usd)::float AS usd, count(*)::int AS llamadas
                       FROM gasto WHERE ts >= least(${sem}, ${mes}) GROUP BY 1, 2, 3, 4, 5`);
  const vacio = () => ({ eur: 0, llamadas: 0, por_agente: {}, por_proveedor: {} });
  const out = { hoy: vacio(), semana: vacio(), mes: vacio() };
  for (const f of r.rows) {
    const eur = f.usd * config.usdEur;
    for (const k of ['hoy', 'semana', 'mes']) {
      if (!f[k]) continue;
      const x = out[k];
      x.eur += eur; x.llamadas += f.llamadas;
      x.por_agente[f.agente] = (x.por_agente[f.agente] || 0) + eur;
      x.por_proveedor[f.proveedor] = (x.por_proveedor[f.proveedor] || 0) + eur;
    }
  }
  const r3 = n => Math.round(n * 1000) / 1000;
  for (const x of Object.values(out)) {
    x.eur = r3(x.eur);
    for (const o of [x.por_agente, x.por_proveedor]) for (const k of Object.keys(o)) o[k] = r3(o[k]);
  }
  return out;
}

export async function porAgenteMes() {
  const r = await q(`SELECT agente, round(sum(usd)::numeric * $1, 2)::float AS eur, sum(busquedas)::int AS busquedas
                       FROM gasto WHERE ts >= date_trunc('month', now()) GROUP BY agente ORDER BY eur DESC`, [config.usdEur]);
  return r.rows;
}

/** Gasto por día (hora de Madrid) de los últimos «dias», con el reparto por agente. En euros. */
export async function porDia(dias = 31) {
  const n = Math.max(1, Math.min(120, Number(dias) || 31));
  const r = await q(`SELECT to_char(ts AT TIME ZONE 'Europe/Madrid', 'YYYY-MM-DD') AS dia, coalesce(agente, 'sistema') AS agente,
                            sum(usd)::float AS usd, count(*)::int AS llamadas, coalesce(sum(busquedas),0)::int AS busquedas
                       FROM gasto WHERE ts >= (date_trunc('day', now() AT TIME ZONE 'Europe/Madrid') - ($1::int - 1) * interval '1 day') AT TIME ZONE 'Europe/Madrid'
                      GROUP BY 1, 2 ORDER BY 1`, [n]);
  const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const lista = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(hoy + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - i);
    lista.push({ dia: d.toISOString().slice(0, 10), eur: 0, llamadas: 0, busquedas: 0, agentes: {} });
  }
  const idx = Object.fromEntries(lista.map((x, i) => [x.dia, i]));
  for (const f of r.rows) {
    const x = lista[idx[f.dia]]; if (!x) continue;
    const eur = f.usd * config.usdEur;
    x.eur += eur; x.llamadas += f.llamadas; x.busquedas += f.busquedas;
    x.agentes[f.agente] = Math.round(((x.agentes[f.agente] || 0) + eur) * 1000) / 1000;
  }
  for (const x of lista) x.eur = Math.round(x.eur * 1000) / 1000;
  return lista;
}

/** Ritmo de gasto: lo que queda del mes repartido entre los días que faltan. Si hoy ya se ha gastado la parte de hoy,
 *  el trabajo automático espera a mañana (lo que pide Dirección, las respuestas a leads y las secuencias siguen). */
let ritmoCache = { t: 0, v: null };
export async function ritmo() {
  if (Date.now() - ritmoCache.t < 60_000 && ritmoCache.v) return ritmoCache.v;
  const g = await gastoMes();
  const r = await q(`SELECT
      coalesce(sum(usd) FILTER (WHERE ts >= date_trunc('day', now() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}'), 0)::float AS hoy,
      coalesce(sum(usd) FILTER (WHERE ts < date_trunc('day', now() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}'), 0)::float AS antes
    FROM gasto WHERE ts >= ${desdeSql(g.modo)}`);
  const ahora = new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
  const quedan = g.modo === 'semanal' ? 7 - ((ahora.getDay() + 6) % 7) : new Date(ahora.getFullYear(), ahora.getMonth() + 1, 0).getDate() - ahora.getDate() + 1;
  const hoy = r.rows[0].hoy * config.usdEur, antes = r.rows[0].antes * config.usdEur;
  // Se reparte por días todo lo que hay: el dinero del periodo más los créditos de Claude que le quedan (así los 100 $ del plan duran el mes)
  const cuota = Math.max(0, (g.limite + (g.creditos_claude?.del_periodo || 0) - antes) / quedan);
  // En turbo no hay cupo diario: se trabaja hasta agotar el presupuesto del periodo
  const v = { hoy: Math.round(hoy * 100) / 100, cuota: Math.round(cuota * 100) / 100, frenar: !g.turbo && hoy >= cuota, quedan, turbo: g.turbo, periodo: g.periodo };
  ritmoCache = { t: Date.now(), v };
  return v;
}

/** Lo que suele costar un encargo (antes de hacerlo): mediana y rango de las últimas tareas de ese agente y tipo.
 *  Con pocas muestras suyas, se usa lo del equipo. Devuelve euros. */
export async function costeTipico(agente, tipo = 'trabajo') {
  const sql = (porAgente) => `SELECT sum(g.usd)::float AS usd FROM gasto g JOIN tareas t ON t.id = g.tarea_id
      WHERE ${porAgente ? 't.agente=$2 AND ' : ''}t.tipo=$1 AND t.estado='hecha' AND t.creada > now() - interval '60 days'
      GROUP BY t.id ORDER BY max(t.creada) DESC LIMIT 40`;
  let v = (await q(sql(true), [tipo, agente])).rows.map(x => x.usd).filter(x => x > 0), base = 'suyo';
  if (v.length < 3) { v = (await q(sql(false), [tipo])).rows.map(x => x.usd).filter(x => x > 0); base = 'equipo'; }
  if (!v.length) return { eur: null, muestras: 0 };
  v.sort((a, b) => a - b);
  const p = f => v[Math.min(v.length - 1, Math.round(f * (v.length - 1)))] * config.usdEur;
  const r = n => Math.round(n * 1000) / 1000;
  return { eur: r(p(0.5)), min: r(p(0.2)), max: r(p(0.8)), muestras: v.length, base };
}
/** Las estimaciones de todo el equipo de una vez (para el panel). */
export async function costesTipicos() {
  const { IDS } = await import('./agentes.js');
  const out = {};
  for (const id of IDS) out[id] = { trabajo: await costeTipico(id, 'trabajo'), pregunta: await costeTipico(id, 'pregunta') };
  return out;
}
