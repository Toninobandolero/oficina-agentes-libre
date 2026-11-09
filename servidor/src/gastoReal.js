// Lo gastado de verdad en la cuenta de Claude este mes, con TODAS sus claves (la de la oficina y las que Dirección use aparte).
// Anthropic no da el saldo que queda; da el gasto de la organización (Admin API, cost_report). Créditos del plan − esto = lo que queda.
// Hace falta una clave de administrador (sk-ant-admin…): solo lee, no puede gastar. Se guarda cifrada.
import { ajuste, fijarAjuste } from './db.js';
import { cifrar, descifrar } from './ia.js';

const URL_COSTE = 'https://api.anthropic.com/v1/organizations/cost_report';
const cache = new Map();   // desde → { cuando, usd }: como mucho una consulta cada 5 minutos por fecha (Anthropic tarda unos 5 en reflejar el gasto)

/** Primer día del mes en curso (UTC, como agrupa Anthropic los días). */
const inicioMes = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();

const hoyUtc = () => new Date().toISOString().slice(0, 10);
async function pedir(clave, desde = inicioMes()) {
  let usd = 0, page = null;
  do {
    const p = new URLSearchParams({ starting_at: desde, limit: '31' });
    if (page) p.set('page', page);
    const r = await fetch(`${URL_COSTE}?${p}`, { headers: { 'x-api-key': clave, 'anthropic-version': '2026-10-21' }, signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? 'Anthropic no acepta esa clave de administrador.' : `Anthropic: ${j.error?.message || r.status}`);
    for (const b of j.data || []) for (const x of b.results || []) usd += Number(x.amount) / 100;   // viene en céntimos
    page = j.has_more ? j.next_page : null;
  } while (page);
  return Math.round(usd * 100) / 100;
}

/** Dirección pega la clave de administrador: se prueba antes de guardarla. */
export async function guardar(clave) {
  const k = String(clave || '').trim();
  if (!/^sk-ant-admin/.test(k)) throw new Error('La clave de administrador empieza por «sk-ant-admin». Créala en platform.claude.com › Settings › Admin keys.');
  await pedir(k);
  await fijarAjuste('anthropic_admin', { clave: cifrar(k) });
  cache.clear();
  return estado();
}
export async function quitar() { cache.clear(); await fijarAjuste('anthropic_admin', null); await fijarAjuste('saldo_claude', null); }

/** Lo gastado en toda la cuenta ($) desde una fecha (por defecto, el día 1 del mes), o null si no hay clave o no se puede leer ahora. */
export async function gastadoDesde(desde = inicioMes()) {
  const g = await ajuste('anthropic_admin', null);
  if (process.env.GASTO_REAL_SIMULADO) return g ? Number(process.env.GASTO_REAL_SIMULADO) : null;
  if (!g) return null;
  const c = cache.get(desde);
  if (c && Date.now() - c.cuando < 5 * 60_000) return c.usd;
  try { const usd = await pedir(descifrar(g.clave), desde); cache.set(desde, { cuando: Date.now(), usd }); return usd; }
  catch (e) { console.error('Gasto real de Claude:', e.message); return c?.usd ?? null; }
}
export const mesCuenta = () => gastadoDesde();

/** Dirección apunta el saldo que ve hoy en Billing: desde ahí se resta lo que se gaste en la cuenta (con todas sus claves).
 *  Lo ya gastado hoy antes de apuntarlo se guarda como base, porque Anthropic agrupa por días enteros. */
export async function fijarSaldo(usd) {
  const n = Number(String(usd ?? '').replace(',', '.'));
  if (usd === '' || usd == null) { await fijarAjuste('saldo_claude', null); return null; }
  if (!Number.isFinite(n) || n < 0 || n > 100000) throw new Error('Pon el saldo que ves en Billing, en dólares (por ejemplo 57,30).');
  const desde = hoyUtc() + 'T00:00:00Z';
  cache.delete(desde);
  const base = await gastadoDesde(desde);
  if (base == null) throw new Error('Primero pega la clave de administrador: sin ella no se puede saber lo que se gasta después.');
  await fijarAjuste('saldo_claude', { usd: Math.round(n * 100) / 100, desde, base, cuando: new Date().toISOString() });
  return saldo();
}
/** El saldo apuntado y lo que queda ahora: { apuntado, cuando, gastado, quedan } o null. */
export async function saldo() {
  const s = await ajuste('saldo_claude', null);
  if (!s) return null;
  const desde = await gastadoDesde(s.desde);
  if (desde == null) return null;
  const gastado = Math.max(0, Math.round((desde - s.base) * 100) / 100);
  return { apuntado: s.usd, cuando: s.cuando, gastado, quedan: Math.max(0, Math.round((s.usd - gastado) * 100) / 100) };
}
export async function estado() { return { conectado: Boolean(await ajuste('anthropic_admin', null)), mes_cuenta: await mesCuenta(), saldo: await saldo() }; }
