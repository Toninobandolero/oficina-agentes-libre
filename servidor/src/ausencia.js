// Cuando Dirección duerme o está de vacaciones: lo que depende de él se frena, la investigación sigue,
// las secuencias se congelan y Telegram se calla (con resumen al despertar o al volver).
import { q, ajuste, fijarAjuste } from './db.js';
import { config } from './config.js';
import { emitir, log } from './bus.js';

const ZONA = 'Europe/Madrid';
export const REDACTORES = ['javi', 'alex', 'nuria', 'leo'];   // lo que escriben acaba en tu mesa
let ultimaActividad = 0;

/** Dirección acaba de escribir o pulsar algo: está despierto, se le contesta al momento durante 30 minutos. */
export const marcarActividad = () => { ultimaActividad = Date.now(); };
const activoAhora = () => Date.now() - ultimaActividad < 30 * 60_000;
export const olvidarActividad = () => { ultimaActividad = 0; };   // para las pruebas

function horaMadrid(d = new Date()) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: ZONA, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
}
export const hoy = () => new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export function esHoraDeDormir(h = horaMadrid()) {
  const { suenoDesde: a, suenoHasta: b } = config;
  return a <= b ? (h >= a && h < b) : (h >= a || h < b);
}

export async function vacaciones() {
  const v = await ajuste('vacaciones', null);
  return v && v.activa ? v : null;
}

export async function estado() {
  const v = await vacaciones();
  const durmiendo = esHoraDeDormir();
  const pend = (await q(`SELECT count(*)::int n FROM aprobaciones WHERE estado='pendiente' AND (pospuesta IS NULL OR pospuesta < now())`)).rows[0].n;   // lo dejado «para más tarde» no llena la mesa
  return {
    vacaciones: v, durmiendo, activo: activoAhora(),
    silencio: !activoAhora() && (durmiendo || Boolean(v)),
    mesa: { pendientes: pend, maximo: config.mesaMax, llena: pend >= config.mesaMax },
  };
}

/** Agentes que no deben empezar trabajo nuevo ahora (salvo encargos directos de Dirección). */
export async function frenados() {
  const e = await estado();
  // Si hoy ya se ha gastado la parte del presupuesto que le toca, el trabajo automático de todos espera a mañana
  const { ritmo } = await import('./presupuesto.js');
  const rt = await ritmo().catch(() => null);
  if (rt?.frenar) {
    const clave = 'ritmo_aviso:' + hoy();
    if (!(await ajuste(clave))) { await fijarAjuste(clave, true); await log('rafa', `para el trabajo automático hasta mañana: hoy ya se han gastado ${rt.hoy.toFixed(2)} € de IA y la parte del día era ${rt.cuota.toFixed(2)} €. Lo que pidas tú sigue funcionando.`); }
    return (await import('./agentes.js')).IDS;
  }
  if (!e.vacaciones && !e.mesa.llena) return [];
  return [...REDACTORES, ...(await import('./departamentos.js')).propios().flatMap(d => d.agentes)];   // los de los departamentos propios también dejan su trabajo en tu mesa
}

export async function irse(hasta = null) {
  const v = { activa: true, desde: hoy(), hasta: hasta || null };
  await fijarAjuste('vacaciones', v);
  await emitir({ tipo: 'ausencia', ...(await estado()) });
  await log('dueno', `se va de vacaciones${hasta ? ` hasta el ${new Date(hasta + 'T12:00:00Z').toLocaleDateString('es-ES', { day: 'numeric', month: 'long', timeZone: 'UTC' })}` : ''}. La investigación sigue; lo que depende de él, espera.`);
  return v;
}

/** Vuelve Dirección: las fechas de las secuencias se mueven los días que ha estado fuera. Devuelve el resumen. */
export async function volver() {
  const v = await vacaciones();
  if (!v) return null;
  const dias = Math.max(0, Math.round((new Date(hoy() + 'T12:00:00Z') - new Date(v.desde + 'T12:00:00Z')) / 86_400_000));
  if (dias > 0) {
    await q(`UPDATE pasos p SET fecha = fecha + $1::int FROM secuencias s WHERE s.id = p.secuencia_id AND s.estado = 'activa' AND p.estado = 'programado'`, [dias]);
    await q(`UPDATE secuencias SET control_fecha = control_fecha + $1::int WHERE estado = 'activa' AND control_fecha IS NOT NULL`, [dias]);
  }
  await fijarAjuste('vacaciones', { activa: false, ultima: v, vuelta: hoy() });
  const [emp, dos, mesa] = await Promise.all([
    q(`SELECT count(*)::int n FROM empresas WHERE creada::date >= $1::date`, [v.desde]),
    q(`SELECT count(*)::int n FROM empresas WHERE dossier IS NOT NULL AND actualizada::date >= $1::date`, [v.desde]),
    q(`SELECT count(*)::int n FROM aprobaciones WHERE estado='pendiente'`),
  ]);
  const resumen = { dias, empresas: emp.rows[0].n, dossiers: dos.rows[0].n, mesa: mesa.rows[0].n };
  await log('dueno', `ha vuelto de vacaciones (${dias} día${dias === 1 ? '' : 's'}). Las secuencias se han movido ${dias} días.`);
  await emitir({ tipo: 'ausencia', ...(await estado()), bienvenida: resumen });
  return resumen;
}

// ---- Cola de Telegram: lo que no se manda mientras duermes o estás fuera ----
export async function encolar(texto) {
  await q(`INSERT INTO telegram_cola (texto) VALUES ($1)`, [texto]);
}
/** Saca lo acumulado: avisos agrupados en un mensaje y las aprobaciones pendientes de enviar. */
export async function vaciarCola(telegram, { cabecera }) {
  const cola = (await q(`DELETE FROM telegram_cola RETURNING texto, creada`)).rows.sort((a, b) => a.creada - b.creada);
  const aps = (await q(`SELECT a.*, e.id AS e_id FROM aprobaciones a LEFT JOIN empresas e ON e.id = a.empresa_id
                         WHERE a.estado='pendiente' AND a.telegram_pendiente ORDER BY a.creada`)).rows;
  if (!cola.length && !aps.length) return 0;
  const MAX = 3500;
  let cuerpo = cola.map(c => '• ' + c.texto.replace(/\n{2,}/g, '\n')).join('\n\n');
  if (cuerpo.length > MAX) cuerpo = cuerpo.slice(0, MAX) + '\n[…] (el resto, en el panel)';
  await telegram.avisar(`${cabecera}\n\n${cuerpo || 'Nada nuevo salvo lo que hay en tu mesa.'}${aps.length ? `\n\n📝 Te dejo ${aps.length} cosa${aps.length === 1 ? '' : 's'} para tu mesa a continuación.` : ''}`, { ahora: true });
  return { cola: cola.length, aprobaciones: aps };
}
