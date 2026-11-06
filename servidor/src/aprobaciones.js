// La mesa de Dirección: todo lo que sale hacia fuera pasa por aquí.
import crypto from 'node:crypto';
import { q } from './db.js';
import { consejoHora, siguienteHueco } from './horario.js';
import { alResolverTarjeta, emitir, estado, estadoDe, log } from './bus.js';
import { AGENTES } from './agentes.js';
import * as empresas from './empresas.js';
import * as telegram from './telegram.js';
import * as aprendizajes from './aprendizajes.js';
import * as tareas from './tareas.js';
import * as memoria from './memoria.js';
import * as secuencias from './secuencias.js';
import * as prioridad from './prioridad.js';
import * as correo from './correo.js';
import { hoy as hoyMadrid } from './ausencia.js';
import * as linkedin from './linkedin.js';
import * as facebook from './facebook.js';
import * as disenio from './disenio.js';
import * as video from './video.js';
const RED = { linkedin: 'LinkedIn', facebook: 'Facebook' };
const publicador = canal => canal === 'facebook' ? facebook : linkedin;

const TIPOS = ['mensaje', 'respuesta', 'post', 'video', 'articulo', 'boletin', 'anuncio', 'propuesta', 'regla', 'paso', 'correo', 'otro'];
export const CANALES = ['linkedin', 'facebook', 'instagram', 'youtube', 'google', 'web', 'boletin', 'anuncios'];
const CONTENIDO = new Set(['post', 'video', 'articulo', 'boletin', 'anuncio']);
/** Un seguimiento no cae en sábado ni domingo: pasa al lunes. */
const laborable = dia => { const d = new Date(`${dia}T12:00:00Z`); while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
const sumarDias = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

/** Botones de un post de redes según lo que esté conectado. */
export async function opcionesPost(canal, { auto = false } = {}) {
  const li = (await linkedin.estado().catch(() => ({}))).conectado, fb = (await facebook.estado().catch(() => ({}))).conectado;
  if (canal === 'facebook') return [...(fb ? [{ r: 'publicar', t: auto ? '🚀 Publicar ya' : '🚀 Publicar en Facebook ya' }, { r: 'programar', t: '📅 Programar' }] : [{ r: 'aprobada', t: '✅ Ya lo he publicado' }]), { r: 'cambios' }, { r: 'descartada', t: 'Descartar' }];
  return [...(li ? [{ r: 'publicar', t: auto ? '🚀 Publicar ya' : '🚀 Publicar en LinkedIn ya' }, ...(fb ? [{ r: 'publicar_ambas', t: '🚀 LinkedIn + Facebook ya' }] : []), { r: 'programar', t: '📅 Programar' }] : [{ r: 'aprobada', t: '✅ Ya lo he publicado' }]),
    { r: 'cambios' }, { r: 'descartada', t: 'Descartar' }];
}

/** Al arrancar y al conectar o desconectar una red: los posts que ya estaban en la mesa estrenan los botones nuevos (programar, sin «Ya lo he publicado» si la red está conectada). */
export async function actualizarOpcionesPosts() {
  const r = (await q(`SELECT id, canal FROM aprobaciones WHERE estado='pendiente' AND tipo='post' AND canal IN ('linkedin','facebook') AND (opciones::text LIKE '%publicar%' OR opciones::text LIKE '%Ya lo he publicado%')`)).rows;
  const auto = { linkedin: await linkedin.autopublicar().catch(() => false), facebook: await facebook.autopublicar().catch(() => false) };
  for (const a of r) await q(`UPDATE aprobaciones SET opciones=$2 WHERE id=$1`, [a.id, JSON.stringify(await opcionesPost(a.canal, { auto: auto[a.canal] }))]);
  if (r.length) await emitir({ tipo: 'mesa_cambiada' });
  return r.length;
}

/** «2026-11-03T10:30» (hora de Madrid) → Date. */
export function deMadrid(txt) {
  const m = String(txt || '').match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return null;
  for (const off of ['+01:00', '+02:00']) {            // la que, vuelta a Madrid, da la misma hora
    const d = new Date(`${m[1]}T${m[2]}:${m[3]}:00${off}`);
    const v = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d).replace(' ', 'T');
    if (v === `${m[1]}T${m[2]}:${m[3]}`) return d;
  }
  return new Date(`${m[1]}T${m[2]}:${m[3]}:00+01:00`);
}
/** Cuándo sale por defecto: su día previsto a las 9:00 si aún no ha pasado; si no, el siguiente laborable a las 9:00. */
function cuandoPorDefecto(fecha_prevista) {
  const f = fecha_prevista ? isoFecha(fecha_prevista) : null;
  const d = f ? deMadrid(`${f}T09:00`) : null;
  return d && d > new Date(Date.now() + 5 * 60_000) ? d : deMadrid(`${siguienteLaborable()}T09:00`);
}

// Franjas recomendadas por red (hora de Madrid; 1 = lunes … 5 = viernes). Estudios generales (Sprout Social, Comscore España):
// martes a jueves es lo mejor y el fin de semana lo peor. LinkedIn y Facebook a horas distintas para no salir a la vez.
export const FRANJAS = {
  linkedin: { dias: [2, 4], hora: '10:00', reserva: [3], texto: 'martes y jueves a las 10:00' },
  facebook: { dias: [2, 4], hora: '13:00', reserva: [3], texto: 'martes y jueves a las 13:00' },
};
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/** Recomienda día y hora: la primera franja buena de esa red que esté libre (sin otro post de esa red ese día),
 *  a partir del día que propone el agente o de mañana. */
export async function sugerencia(canal, { fecha_prevista = null, excluir = null } = {}) {
  const red = canal === 'facebook' ? 'facebook' : 'linkedin', fr = FRANJAS[red];
  const ocupados = new Set((await q(`SELECT (coalesce(publicar_en, ((fecha_prevista + time '09:00') AT TIME ZONE 'Europe/Madrid')) AT TIME ZONE 'Europe/Madrid')::date::text d
                                      FROM aprobaciones WHERE estado IN ('programada','externa') AND id IS DISTINCT FROM $2 AND (canal=$1 OR tambien=$1)`, [red, excluir])).rows.map(r => r.d));
  const minimo = new Date(Date.now() + 30 * 60_000);
  const desde = fecha_prevista && isoFecha(fecha_prevista) > hoyMadrid() ? isoFecha(fecha_prevista) : hoyMadrid();
  for (const dias of [fr.dias, [...fr.dias, ...fr.reserva], [1, 2, 3, 4, 5]]) {
    const d = new Date(desde + 'T12:00:00Z');
    for (let i = 0; i < 28; i++, d.setUTCDate(d.getUTCDate() + 1)) {
      const dia = d.toISOString().slice(0, 10);
      if (!dias.includes(d.getUTCDay()) || ocupados.has(dia)) continue;
      const cuando = deMadrid(`${dia}T${fr.hora}`);
      if (cuando < minimo) continue;
      const pedido = fecha_prevista && dia === isoFecha(fecha_prevista);
      return { cuando: `${dia}T${fr.hora}`, motivo: `${pedido ? 'El día que propone el agente, a' : 'Primer hueco libre en'} la franja buena de ${RED[red]} (${fr.texto})${ocupados.size ? '; los días con otro post ya programado se saltan' : ''}.`, texto: `${DIAS[d.getUTCDay()]} ${Number(dia.slice(8))} a las ${fr.hora}` };
    }
  }
  return { cuando: `${siguienteLaborable()}T${fr.hora}`, motivo: 'Siguiente día laborable.', texto: '' };
}

function siguienteLaborable() {
  const d = new Date(hoyMadrid() + 'T12:00:00Z');
  do d.setUTCDate(d.getUTCDate() + 1); while ([0, 6].includes(d.getUTCDay()));
  return d.toISOString().slice(0, 10);
}
const isoFecha = d => d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : String(d).slice(0, 10);
const fechaValida = f => (/^\d{4}-\d{2}-\d{2}$/.test(String(f || '')) && !isNaN(new Date(f + 'T12:00:00Z'))) ? f : null;

/** Prioridad con la que se ve hoy una aprobación (sube sola con las fechas y la espera). */
export const prioridadDe = ap => prioridad.efectiva(ap, hoyMadrid());

export async function crear({ agente, tipo, titulo, texto, empresa_id = null, ref = null, opciones = null, caduca = null, importancia = null, motivo = null, canal = null, fecha_prevista = null, imagen = null, perfil_url = null, buscar = null }) {
  if (!TIPOS.includes(tipo)) tipo = 'otro';
  if (!CANALES.includes(canal)) canal = tipo === 'post' ? 'linkedin' : tipo === 'articulo' ? 'web' : tipo === 'boletin' ? 'boletin' : tipo === 'anuncio' ? 'anuncios' : null;
  let prevista = fechaValida(fecha_prevista);
  // Con la publicación automática, un post sin fecha sale el siguiente día laborable
  const red = canal === 'facebook' ? facebook : canal === 'linkedin' ? linkedin : null;
  const auto = tipo === 'post' && red && (await red.autopublicar()) && (await red.estado()).conectado;
  if (auto && (!prevista || prevista < hoyMadrid())) prevista = siguienteLaborable();
  // Un post se publica desde la mesa (ya o programado). «Ya lo he publicado» solo si esa red no está conectada
  if (tipo === 'post' && ['linkedin', 'facebook'].includes(canal) && !opciones) opciones = await opcionesPost(canal, { auto });
  if (tipo === 'boletin' && !opciones) opciones = await (await import('./boletin.js')).opciones();
  const id = crypto.randomBytes(5).toString('hex');
  const emp = empresa_id ? await empresas.leer(empresa_id) : null;
  const b = prioridad.base({ tipo, ref, empresa: emp, importancia, motivo });
  const cad = fechaValida(caduca);
  const perfil = /^https:\/\/([a-z]+\.)?linkedin\.com\//i.test(String(perfil_url || '')) ? String(perfil_url) : null;
  const fila = (await q(`INSERT INTO aprobaciones (id, agente, empresa_id, tipo, titulo, texto, ref, opciones, prioridad, prioridad_motivo, caduca, canal, fecha_prevista, perfil_url, buscar)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING creada`,
    [id, agente, emp ? emp.id : null, tipo, titulo, texto, ref, opciones ? JSON.stringify(opciones) : null, b.nivel, b.motivo, cad, canal, prevista, perfil, buscar ? String(buscar).slice(0, 120) : null])).rows[0];
  // Los posts de redes y de la ficha de Google llevan su imagen con el diseño de Dirección (titular del agente o, si no lo da, el gancho del post)
  let conImagen = false;
  if (tipo === 'post' && ['linkedin', 'facebook', 'instagram', 'google'].includes(canal) && imagen !== false) {
    try {
      const d = imagen?.titular ? { titular: String(imagen.titular).slice(0, 140), destacado: String(imagen.destacado || '').slice(0, 140) } : disenio.delTexto(texto);
      await q(`INSERT INTO imagenes (aprobacion_id, titular, destacado, png) VALUES ($1,$2,$3,$4) ON CONFLICT (aprobacion_id) DO UPDATE SET titular=EXCLUDED.titular, destacado=EXCLUDED.destacado, png=EXCLUDED.png`,
        [id, d.titular, d.destacado, disenio.png(d)]);
      conImagen = true;
    } catch (e) { console.error('Imagen del post:', e.message); }
  }
  // Un documento nuevo de la empresa deja atrás el anterior: en la mesa, solo la última versión
  if (tipo === 'propuesta' && emp) for (const v of (await q(`UPDATE aprobaciones SET estado='sustituida', resuelta=now() WHERE empresa_id=$1 AND tipo='propuesta' AND estado='pendiente' AND id<>$2 RETURNING id, telegram_msg_id`, [emp.id, id])).rows) {
    await emitir({ tipo: 'aprobacion_resuelta', id: v.id, resultado: 'sustituida' });
  }
  const doc_empresa = emp ? (await q(`SELECT id FROM aprobaciones WHERE empresa_id=$1 AND tipo='propuesta' AND estado NOT IN ('sustituida','superada') ORDER BY creada DESC LIMIT 1`, [emp.id])).rows[0]?.id ?? null : null;
  const prio = prioridadDe({ prioridad: b.nivel, prioridad_motivo: b.motivo, caduca: cad, creada: fila.creada, fecha_prevista: prevista });
  await emitir({ tipo: 'traspaso', de: agente, a: 'dueno', carga: true });
  await emitir({ tipo: 'aprobacion', id, agente, clase: tipo, doc_empresa, ref_tipo: String(ref || '').split(':')[0], categoria: emp?.categoria ?? null, puntuacion: emp?.puntuacion ?? null, empresa: emp?.nombre ?? null, linkedin_url: emp?.linkedin_url ?? null, linkedin_empresa: emp?.linkedin_empresa ?? null, decisor: emp?.decisor ?? null, telefono: emp?.telefono ?? null, empresa_id: emp?.id ?? null, perfil_url: perfil, buscar: buscar || null, titulo, texto, opciones, creada: fila.creada, prio, prioridad: b.nivel, prioridad_motivo: b.motivo, caduca: cad, canal, fecha_prevista: prevista, imagen: conImagen, video: tipo === 'video' ? video.ficha(texto) : undefined });
  await log(agente, `${titulo.replace(/\.$/, '')}. Está en tu mesa.`, { empresa_id: emp?.id, aprobacion_id: id });
  if (emp) await telegramDeEmpresa(emp.id);
  else if (prio.nivel <= 2) {
    const msgId = await telegram.enviarAprobacion({ id, tipo, titulo, texto, opciones, prio, canal, fecha_prevista: prevista, auto }, { nombreAgente: AGENTES[agente]?.nombre ?? agente });
    if (msgId === 'cola') await q('UPDATE aprobaciones SET telegram_pendiente=true WHERE id=$1', [id]);
    else if (msgId) await q('UPDATE aprobaciones SET telegram_msg_id=$2 WHERE id=$1', [id, msgId]);
  }
  return id;
}

/** Manda a Telegram las aprobaciones que se guardaron mientras Dirección dormía o estaba fuera. */
export async function enviarPendientesTelegram() {
  const r = await q(`SELECT * FROM aprobaciones WHERE estado='pendiente' AND telegram_pendiente ORDER BY creada`);
  for (const ap of r.rows.filter(a => !a.empresa_id)) {
    const msgId = await telegram.enviarAprobacion({ ...ap, prio: prioridadDe(ap) }, { nombreAgente: AGENTES[ap.agente]?.nombre ?? ap.agente, ahora: true });
    await q('UPDATE aprobaciones SET telegram_pendiente=false, telegram_msg_id=$2 WHERE id=$1', [ap.id, typeof msgId === 'number' ? msgId : null]);
  }
  for (const e of new Set(r.rows.map(a => a.empresa_id).filter(Boolean))) await telegramDeEmpresa(e, { ahora: true });
  return r.rows.length;
}

// A Telegram solo llega lo que no puede esperar: un cliente esperando o algo que solo Dirección decide. Los contactos del día, en el modo rápido
const avisaYa = a => { const n = prioridadDe(a).nivel; return n === 1 || (n === 2 && !['sec', 'paso'].includes(String(a.ref || '').split(':')[0]) && !['mensaje', 'correo'].includes(a.tipo)); };

/** Telegram, igual que la mesa: un solo mensaje por empresa, con lo más importante y, a igualdad, lo último. */
export async function telegramDeEmpresa(empresa_id, { ahora = false } = {}) {
  if (!empresa_id || !telegram.activo()) return;
  const abiertas = (await q(`SELECT * FROM aprobaciones WHERE empresa_id=$1 AND estado='pendiente' ORDER BY creada`, [empresa_id])).rows;
  const nivel = a => prioridadDe(a).nivel;
  const importante = abiertas.filter(a => !(a.pospuesta && new Date(a.pospuesta) > new Date()) && avisaYa(a));
  const principal = importante.reduce((m, a) => !m || nivel(a) < nivel(m) || (nivel(a) === nivel(m) && a.creada >= m.creada) ? a : m, null);   // en orden y con >=: dos en el mismo milisegundo, gana la última
  for (const a of abiertas) if (a !== principal && (a.telegram_msg_id || a.telegram_pendiente)) {
    await telegram.retirar(a.telegram_msg_id);
    await q(`UPDATE aprobaciones SET telegram_msg_id=NULL, telegram_pendiente=false WHERE id=$1`, [a.id]);
  }
  if (!principal || principal.telegram_msg_id || (principal.telegram_pendiente && !ahora)) return;
  const msgId = await telegram.enviarAprobacion({ ...principal, prio: prioridadDe(principal) }, { nombreAgente: AGENTES[principal.agente]?.nombre ?? principal.agente, empresa: await empresas.leer(empresa_id), ahora });
  await q(`UPDATE aprobaciones SET telegram_pendiente=$2, telegram_msg_id=$3 WHERE id=$1`, [principal.id, msgId === 'cola', typeof msgId === 'number' ? msgId : null]);
}

// Lo que sale de la mesa sale también de Telegram, y si queda algo de esa empresa, llega lo siguiente
alResolverTarjeta(async ({ id, resultado }) => {
  const a = (await q(`SELECT empresa_id, telegram_msg_id FROM aprobaciones WHERE id=$1`, [id])).rows[0];
  if (!a) return;
  if (['superada', 'sustituida'].includes(resultado) && a.telegram_msg_id) {
    await telegram.retirar(a.telegram_msg_id);
    await q(`UPDATE aprobaciones SET telegram_msg_id=NULL WHERE id=$1`, [id]);
  }
  await telegramDeEmpresa(a.empresa_id);
});

/** Lo que quedó en Telegram de antes de esta regla: mensajes de tarjetas ya retiradas y varios de una misma empresa. */
export async function ponerTelegramAlDia() {
  if (!telegram.activo()) return;
  for (const a of (await q(`SELECT id, telegram_msg_id FROM aprobaciones WHERE estado IN ('superada','sustituida') AND telegram_msg_id IS NOT NULL LIMIT 50`)).rows) {
    await telegram.retirar(a.telegram_msg_id);
    await q(`UPDATE aprobaciones SET telegram_msg_id=NULL WHERE id=$1`, [a.id]);
  }
  for (const { empresa_id } of (await q(`SELECT empresa_id FROM aprobaciones WHERE estado='pendiente' AND empresa_id IS NOT NULL AND (telegram_msg_id IS NOT NULL OR telegram_pendiente) GROUP BY 1 HAVING count(*) > 1`)).rows) await telegramDeEmpresa(empresa_id);
}

/** Quita de la mesa (y de Telegram) una aprobación que ha quedado sustituida por otra versión. */
export async function sustituir(ref) {
  const r = await q(`UPDATE aprobaciones SET estado='sustituida', resuelta=now() WHERE ref=$1 AND estado='pendiente' RETURNING *`, [ref]);
  for (const ap of r.rows) await emitir({ tipo: 'aprobacion_resuelta', id: ap.id, resultado: 'sustituida' });
}

/** Se ha hecho fuera de sus opciones (un correo enviado desde la tarjeta): sale de la mesa sin más. */
export async function darPorHecha(id) {
  const ap = (await q(`UPDATE aprobaciones SET estado='aprobada', resuelta=now() WHERE id=$1 AND estado='pendiente' RETURNING *`, [id])).rows[0];
  if (!ap) return null;
  await emitir({ tipo: 'aprobacion_resuelta', id, resultado: 'aprobada' });
  await telegram.marcarResuelta(ap.telegram_msg_id, 'aprobada', '✅ Hecho');
  return ap;
}

export async function pendientes() {
  const r = await q(`SELECT * FROM aprobaciones WHERE estado='pendiente' ORDER BY creada`);
  return r.rows;
}

const NIVEL = { urgente: 1, importante: 2, normal: 3, puede_esperar: 4 };
/** El gerente reordena la mesa. Lo urgente no se queda pospuesto. */
export async function priorizar(id, nivel, motivo) {
  if (!NIVEL[nivel]) throw new Error(`El nivel tiene que ser uno de estos: ${Object.keys(NIVEL).join(', ')}.`);
  const m = String(motivo || '').trim().slice(0, 200);
  if (!m) throw new Error('Di por qué, en una frase: Dirección lo ve en la tarjeta.');
  const ap = (await q(`UPDATE aprobaciones SET prioridad=$2, prioridad_motivo=$3, pospuesta = CASE WHEN $2 = 1 THEN NULL ELSE pospuesta END WHERE id=$1 AND estado='pendiente' RETURNING *`, [id, NIVEL[nivel], m])).rows[0];
  if (!ap) throw new Error('Esa tarjeta ya no está en la mesa de Dirección. Míralo con ver_mesa.');
  await emitir({ tipo: 'mesa_cambiada' });
  return ap;
}

/** Opción elegida que necesita que escribas algo (p. ej. qué te ha respondido). */
export const PIDE_TEXTO = new Set(['respondido', 'responder']);

export const textoCuando = d => new Date(d).toLocaleString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' });

export async function resolver(id, resultado, texto = '') {
  const previa = (await q(`SELECT * FROM aprobaciones WHERE id=$1`, [id])).rows[0];
  if (!previa || previa.estado !== 'pendiente') return null;
  // Un guion no se da por hecho sin vídeo: aprobarlo sin él (o «Generar vídeo» de Telegram) lo genera y la tarjeta sigue en la mesa
  if (previa.tipo === 'video' && (resultado === 'generar' || (resultado === 'aprobada' && !(await video.hayVideo(id))))) {
    await video.generar(id, { porTelegram: true });
    return { ...previa, generando: true };
  }
  const validas = previa.opciones ? previa.opciones.map(o => o.r).filter(r => r !== 'cambios') : ['aprobada', 'descartada'];
  if (!validas.includes(resultado)) throw new Error('Resultado no válido');
  if (PIDE_TEXTO.has(resultado) && !String(texto).trim()) return { pideTexto: true, ...previa };
  // Correo: primero se envía; si falla, sigue en la mesa y Dirección ve el motivo
  const [rt, rid] = String(previa.ref || '').split(':');
  if (rt === 'correo' && resultado === 'enviar') await correo.enviarBorrador(Number(rid));
  if (rt === 'chat' && resultado === 'enviar') await (await import('./chats.js')).enviarBorrador(Number(rid));
  if (previa.tipo === 'boletin' && resultado === 'enviar') await (await import('./boletin.js')).lanzar(previa);
  if (rt === 'correo' && resultado === 'fuera') await q(`UPDATE correos SET direccion='salida', clase='fuera', enviado=now() WHERE id=$1 AND direccion='borrador'`, [Number(rid)]);
  if (rt === 'correo' && resultado === 'descartada') await q(`UPDATE correos SET direccion='descartado' WHERE id=$1 AND direccion='borrador'`, [Number(rid)]);
  // Posts: «publicar» sale ya; «programar» lo deja con día y hora (el planificador lo publica a su hora)
  let estadoFinal = resultado === 'fuera' ? 'aprobada' : resultado, enlace = null, programadaPara = null;
  if (resultado === 'publicar_ambas') await q(`UPDATE aprobaciones SET tambien='facebook' WHERE id=$1`, [id]);
  if (resultado === 'programar') {
    const [cuando, extra] = String(texto || '').split('|');
    programadaPara = cuando ? deMadrid(cuando) : deMadrid((await sugerencia(previa.canal, { fecha_prevista: previa.fecha_prevista, excluir: id })).cuando);
    if (!programadaPara) throw new Error('La fecha no es válida.');
    if (programadaPara < new Date(Date.now() + 2 * 60_000)) throw new Error('Elige una hora que aún no haya pasado (al menos dentro de unos minutos).');
    const red = previa.canal === 'facebook' ? 'facebook' : 'linkedin';
    if (!(await publicador(red).estado()).conectado) throw new Error(`${RED[red]} no está conectado: conéctalo desde «Tu mesa».`);
    const fecha = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(programadaPara);
    await q(`UPDATE aprobaciones SET publicar_en=$2, fecha_prevista=$3, tambien=$4 WHERE id=$1`, [id, programadaPara, fecha, extra === 'ambas' && red === 'linkedin' ? 'facebook' : null]);
    estadoFinal = 'programada';
  }
  if (resultado === 'publicar' || resultado === 'publicar_ambas') {
    const redes = [previa.canal === 'facebook' ? 'facebook' : 'linkedin', ...(resultado === 'publicar_ambas' ? ['facebook'] : [])];
    for (const red of redes) if (!(await publicador(red).estado()).conectado) throw new Error(`${RED[red]} no está conectado: conéctalo desde «Tu mesa».`);
    const img = await imagenDe(id);
    const enlaces = [];
    for (const red of redes) enlaces.push((await publicador(red).publicar(linkedin.textoDelPost(previa.texto), img)).url);
    enlace = enlaces[0]; estadoFinal = 'publicada';
    if (enlaces[1]) await log('dueno', `ha publicado también en Facebook: ${previa.titulo}`, { aprobacion_id: id, url: enlaces[1] });
  }
  const r = await q(`UPDATE aprobaciones SET estado=$2, resuelta=now(), enlace=coalesce($3, enlace) WHERE id=$1 AND estado='pendiente' RETURNING *`, [id, estadoFinal, enlace]);
  const ap = r.rows[0];
  if (!ap) return null;                                     // ya estaba resuelta
  const etiqueta = previa.opciones?.find(o => o.r === resultado)?.t;
  await emitir({ tipo: 'aprobacion_resuelta', id, resultado });
  if (rt === 'plan') (await import('./objetivos.js')).alResolver(Number(rid), resultado).catch(e => console.error('Objetivo:', e.message));
  // Si la habías pospuesto con fecha, su recordatorio del calendario queda hecho
  await q(`UPDATE recordatorios SET hecho=now() WHERE aprobacion_id=$1 AND hecho IS NULL`, [id]).catch(() => {});
  await telegram.marcarResuelta(ap.telegram_msg_id, resultado, etiqueta);
  const [refTipo, refId] = String(ap.ref || '').split(':');
  if (refTipo === 'paso' || refTipo === 'ctl') {
    const frase = await secuencias.resolver(ap, resultado, String(texto).trim());
    if (frase) await log('dueno', frase);
    if (ap.empresa_id) await secuencias.emitirCambio(ap.empresa_id);
    await liberar(ap.agente);
    return ap;
  }
  if (refTipo === 'atasco') {
    const atascos = await import('./atascos.js');
    if (resultado === 'responder') await tareas.crear(ap.agente, `Estabas atascado («${ap.titulo.replace(/^está atascado y te necesita: /, '')}»). Dirección te contesta: «${String(texto).trim()}». Sigue con lo que tenías pendiente.`, { empresa_id: ap.empresa_id, origen: 'dueno' });
    if (resultado === 'descartada') await tareas.crear(ap.agente, `Dirección dice que dejes lo que te tenía atascado («${ap.titulo.replace(/^está atascado y te necesita: /, '')}») y sigas con otra cosa.`, { origen: 'dueno', tipo: 'pregunta' });
    await atascos.resolver(ap.agente, resultado === 'responder' ? `Dirección: ${String(texto).trim().slice(0, 200)}` : resultado);
    await estado(ap.agente, 'inactivo', 'Esperando trabajo', 'zz');
    await log('dueno', resultado === 'responder' ? `le ha contestado a ${AGENTES[ap.agente]?.nombre ?? ap.agente} lo que necesitaba.` : `ha desatascado a ${AGENTES[ap.agente]?.nombre ?? ap.agente}.`);
    return ap;
  }
  if (refTipo === 'sec') {
    if (resultado === 'aprobada') await secuencias.empezar(Number(refId));
    else {
      // «Esta empresa no»: se cierra, para que no vuelva a prepararse otro primer contacto
      await secuencias.descartar(Number(refId));
      if (ap.empresa_id) await empresas.actualizar(ap.empresa_id, { estado: 'descartada', proximo_paso: null, fecha_proximo_paso: null });
    }
    if (ap.empresa_id) await secuencias.emitirCambio(ap.empresa_id);
  }
  const emp = ap.empresa_id ? await empresas.leer(ap.empresa_id) : null;
  const de = emp ? ` para ${emp.nombre}` : '';

  if (estadoFinal === 'programada') {
    await log('dueno', `ha programado en ${RED[ap.canal] || 'LinkedIn'}${ap.tambien === 'facebook' ? ' y Facebook' : ''} para el ${textoCuando(ap.publicar_en || cuandoPorDefecto(ap.fecha_prevista))}: ${ap.titulo}`, { aprobacion_id: ap.id });
    await emitir({ tipo: 'calendario' });
  } else if (resultado === 'aprobada' || resultado === 'publicar' || resultado === 'publicar_ambas') {
    if (ap.tipo === 'mensaje' && emp && refTipo === 'sec') {
      await log('dueno', `ha enviado la solicitud de conexión${de}. En 3 días Paula le pregunta si ha aceptado; entonces Javi escribe el mensaje 1.`);
    } else if (ap.tipo === 'mensaje' && emp) {
      await empresas.actualizar(emp.id, { estado: 'contactada', ultimo_contacto: sumarDias(0), proximo_paso: 'Seguimiento 1', fecha_proximo_paso: laborable(sumarDias(5)) });
      await log('dueno', `ha enviado el mensaje${de}. Seguimiento programado en 5 días.`);
    } else if (CONTENIDO.has(ap.tipo)) {
      await memoria.publicar({ aprobacion_id: ap.id, agente: ap.agente, titulo: ap.titulo, texto: ap.texto, canal: ap.canal || 'linkedin', formato: ap.tipo, enlace });
      const QUE = { post: enlace ? `ha publicado en ${RED[ap.canal] || 'LinkedIn'}` : 'ha publicado', video: 'ha publicado el vídeo', articulo: 'ha aprobado el artículo', boletin: 'ha aprobado el boletín', anuncio: 'ha aprobado el anuncio' };
      await log('dueno', `${QUE[ap.tipo]}: ${ap.titulo}. ${AGENTES[ap.agente]?.nombre ?? ap.agente} lo tendrá en cuenta para no repetirse.`, { aprobacion_id: ap.id, url: enlace });
    } else if (ap.tipo === 'regla' && ap.ref) {
      const rg = await aprendizajes.activar(Number(ap.ref));
      await log('dueno', `ha aprobado la regla${rg?.agente ? ' para ' + (AGENTES[rg.agente]?.nombre ?? rg.agente) : ''}: «${rg?.texto ?? ap.texto}»`);
    } else if (ap.tipo === 'propuesta' && emp) {
      await empresas.actualizar(emp.id, { estado: 'propuesta', proximo_paso: 'Seguimiento de la propuesta', fecha_proximo_paso: laborable(sumarDias(5)) });
      await log('dueno', `ha aprobado la propuesta${de}.`);
    } else {
      await log('dueno', `ha aprobado: ${ap.titulo}`);
    }
  } else if (resultado === 'enviar') {
    // El envío ya lo ha contado quien envía. Del boletín, Álex tiene que saber que ha salido para no repetirse
    if (ap.tipo === 'boletin') await memoria.publicar({ aprobacion_id: ap.id, agente: ap.agente, titulo: ap.titulo, texto: ap.texto, canal: 'boletin', formato: 'boletin' });
  } else {
    await log('dueno', `ha descartado: ${ap.titulo}`);
  }
  await liberar(ap.agente);
  return ap;
}

/** La llamada de Dirección ya resolvió la tarjeta (lo dice la transcripción): se cierra sin que tenga que marcar nada. */
export async function cerrarPorLlamada(id) {
  const ap = (await q(`UPDATE aprobaciones SET estado='llamada', resuelta=now() WHERE id=$1 AND estado='pendiente' RETURNING *`, [id])).rows[0];
  if (!ap) return null;
  await emitir({ tipo: 'aprobacion_resuelta', id, resultado: 'llamada' });
  await telegram.marcarResuelta(ap.telegram_msg_id, 'llamada', '📞 Resuelto por teléfono').catch(() => {});
  await liberar(ap.agente);
  return ap;
}

// Si el agente ya no tiene nada en tu mesa, vuelve a estar libre
async function liberar(agente) {
  const quedan = await q(`SELECT count(*)::int n FROM aprobaciones WHERE agente=$1 AND estado='pendiente'`, [agente]);
  if (!quedan.rows[0].n && estadoDe(agente)?.estado === 'esperando') await estado(agente, 'inactivo', 'Esperando trabajo', 'zz');
}

/** Publica los posts programados cuya hora ya ha llegado (se mira cada minuto). Devuelve cuántos se han publicado. */
export async function publicarProgramadas() {
  // Programados por Dirección (a su hora; los antiguos sin hora, a las 9:00 de su día) y, con la publicación automática,
  // los posts de LinkedIn que siguen en la mesa y ya les toca. Si falla, se reintenta a las 3 horas.
  // Los posts que Dirección programó fuera (en LinkedIn o Facebook) pasan a «publicados» al llegar su hora: así Álex sabe que ya salieron
  const fuera = (await q(`UPDATE aprobaciones SET estado='publicada', resuelta=publicar_en WHERE estado='externa' AND publicar_en <= now() RETURNING *`)).rows;
  for (const ap of fuera) {
    await memoria.publicar({ aprobacion_id: ap.id, agente: 'dueno', titulo: ap.titulo, texto: ap.texto || ap.titulo, canal: ap.canal, formato: 'post', enlace: null }).catch(() => {});
    await emitir({ tipo: 'calendario' });
  }
  const auto = await linkedin.autopublicar(), autoFb = await facebook.autopublicar().catch(() => false);
  const r = await q(`SELECT * FROM aprobaciones WHERE canal IN ('linkedin','facebook') AND tipo='post'
                       AND coalesce(publicar_en, ((fecha_prevista + time '09:00') AT TIME ZONE 'Europe/Madrid')) <= now()
                       AND (fallo_pub IS NULL OR fallo_pub < now() - interval '3 hours')
                       AND (estado='programada' OR (estado='pendiente' AND fecha_prevista IS NOT NULL AND ((canal='linkedin' AND $1) OR (canal='facebook' AND $2)))) ORDER BY 1`, [auto, autoFb]);
  let n = 0;
  for (const ap of r.rows) {
    try {
      const red = ap.canal === 'facebook' ? 'facebook' : 'linkedin';
      const img = await imagenDe(ap.id);
      const { url } = await publicador(red).publicar(linkedin.textoDelPost(ap.texto), img);
      if (ap.tambien === 'facebook' && red !== 'facebook') {
        try { const fb = await facebook.publicar(linkedin.textoDelPost(ap.texto), img); await log('dueno', `ha publicado también en Facebook (programado): ${ap.titulo}`, { aprobacion_id: ap.id, url: fb.url }); }
        catch (e) { await log('sistema', `no ha podido publicar en Facebook «${ap.titulo}»: ${e.message}`, { aprobacion_id: ap.id }); }
      }
      await q(`UPDATE aprobaciones SET estado='publicada', enlace=$2, resuelta=coalesce(resuelta, now()), publicar_en=coalesce(publicar_en, now()), fallo_pub=NULL WHERE id=$1`, [ap.id, url]);
      await emitir({ tipo: 'calendario' });
      if (ap.estado === 'pendiente') {
        await emitir({ tipo: 'aprobacion_resuelta', id: ap.id, resultado: 'publicada' });
        await telegram.marcarResuelta(ap.telegram_msg_id, 'publicada', `🚀 Publicado solo en ${RED[red]}`);
        await liberar(ap.agente);
      }
      await memoria.publicar({ aprobacion_id: ap.id, agente: ap.agente, titulo: ap.titulo, texto: ap.texto, canal: red, formato: 'post', enlace: url });
      await log(ap.estado === 'pendiente' ? 'alex' : 'dueno', `${ap.estado === 'pendiente' ? `ha publicado en ${RED[red]} (automático)` : `ha publicado en ${RED[red]} (programado)`}: ${ap.titulo}`, { aprobacion_id: ap.id, url });
      await telegram.avisar(`🚀 Publicado en ${RED[red]}: ${ap.titulo}\n${url}`);
      n++;
    } catch (e) {
      await log('sistema', `no ha podido publicar en ${RED[ap.canal] || 'LinkedIn'} «${ap.titulo}»: ${e.message}`, { aprobacion_id: ap.id });
      await q(`UPDATE aprobaciones SET fallo_pub=now() WHERE id=$1`, [ap.id]);
      await telegram.avisar(`⚠️ No se ha podido publicar en ${RED[ap.canal] || 'LinkedIn'} «${ap.titulo}»: ${e.message}\nLo intento otra vez dentro de 3 horas. Lo ves en el calendario de publicaciones.`);
    }
  }
  return n;
}

/** Dirección pide cambios: se guarda como aprendizaje y el mismo agente lo rehace. */
export async function pedirCambios(id, comentario) {
  const r = await q(`UPDATE aprobaciones SET estado='cambios', resuelta=now() WHERE id=$1 AND estado='pendiente' RETURNING *`, [id]);
  const ap = r.rows[0];
  if (!ap) return null;
  await emitir({ tipo: 'aprobacion_resuelta', id, resultado: 'cambios' });
  await telegram.marcarResuelta(ap.telegram_msg_id, 'cambios');
  await aprendizajes.nuevaCorreccion(ap.agente, `${comentario} (sobre: ${ap.titulo})`);
  const esSecuencia = String(ap.ref || '').startsWith('sec:');
  const esCorreo = String(ap.ref || '').startsWith('correo:');
  const esPlan = String(ap.ref || '').startsWith('plan:');
  if (esCorreo) await q(`UPDATE correos SET direccion='descartado' WHERE id=$1 AND direccion='borrador'`, [Number(ap.ref.split(':')[1])]);
  if (esSecuencia) await secuencias.descartar(Number(ap.ref.split(':')[1]));
  await log('dueno', `ha pedido cambios a ${AGENTES[ap.agente]?.nombre ?? ap.agente}: «${comentario.slice(0, 160)}»`);
  await tareas.crear(ap.agente,
    `Dirección ha pedido cambios en un trabajo tuyo. Rehazlo aplicando su corrección y vuelve a entregarlo con ${esPlan ? `proponer_plan (objetivo_id ${ap.ref.split(':')[1]})` : esSecuencia ? 'guardar_secuencia' : esCorreo ? 'preparar_correo' : 'pedir_aprobacion'}. Si su corrección vale también para próximos trabajos, guárdala antes con aprender, en una frase que se entienda sin contexto; si solo vale para este, no guardes nada.\n\nCorrección de Dirección: «${comentario}»\n\nTrabajo anterior (${ap.tipo}) — ${ap.titulo}:\n${ap.texto}`,
    { empresa_id: ap.empresa_id, origen: 'dueno', objetivo_id: esPlan ? Number(ap.ref.split(':')[1]) : null });
  return ap;
}

export async function porMensajeTelegram(msgId) {
  const r = await q(`SELECT id FROM aprobaciones WHERE telegram_msg_id=$1`, [msgId]);
  return r.rows[0]?.id ?? null;
}

/** Imagen del post (si tiene), lista para subirla a la red. */
export async function imagenDe(id) {
  const r = (await q(`SELECT titular, destacado, png FROM imagenes WHERE aprobacion_id=$1`, [id])).rows[0];
  return r ? { png: r.png, alt: [r.titular, r.destacado].filter(Boolean).join(' ') } : null;
}

// ---------- Calendario de publicaciones ----------
/** Lo programado, lo publicado y lo que Álex propone (en la mesa con fecha) entre dos días. */
export async function calendario(desde, hasta) {
  const r = await q(`SELECT id, agente, canal, tambien, estado, titulo, enlace, fecha_prevista::text AS fecha_prevista, fallo_pub,
                            ref='externo' AS externo, texto,
                            CASE WHEN estado IN ('programada','externa') THEN coalesce(publicar_en, ((fecha_prevista + time '09:00') AT TIME ZONE 'Europe/Madrid'))
                                 WHEN estado='publicada' THEN coalesce(publicar_en, resuelta) END AS cuando
                       FROM aprobaciones
                      WHERE tipo='post' AND canal IN ('linkedin','facebook','instagram')
                        AND (estado IN ('programada','publicada','externa') OR (estado='pendiente' AND fecha_prevista IS NOT NULL))
                        AND coalesce((CASE WHEN estado IN ('programada','externa') THEN coalesce(publicar_en, ((fecha_prevista + time '09:00') AT TIME ZONE 'Europe/Madrid')) WHEN estado='publicada' THEN coalesce(publicar_en, resuelta) END AT TIME ZONE 'Europe/Madrid')::date, fecha_prevista) BETWEEN $1::date AND $2::date
                      ORDER BY 1`, [desde, hasta]);
  const conImg = new Set((await q(`SELECT aprobacion_id FROM imagenes WHERE aprobacion_id = ANY($1::text[])`, [r.rows.map(x => x.id)])).rows.map(x => x.aprobacion_id));
  return r.rows.map(x => ({ ...x, texto: x.externo ? x.texto : undefined, imagen: conImg.has(x.id), dia: x.cuando ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(new Date(x.cuando)) : x.fecha_prevista,
    hora: x.cuando ? new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' }).format(new Date(x.cuando)) : null }));
}

/** Cambia el día y la hora de un post programado. */
export async function reprogramar(id, cuando, ambas) {
  const ap = (await q(`SELECT * FROM aprobaciones WHERE id=$1`, [id])).rows[0];
  if (!ap || ap.estado !== 'programada') throw new Error('Ese post ya no está programado.');
  const d = deMadrid(cuando);
  if (!d || d < new Date(Date.now() + 2 * 60_000)) throw new Error('Elige un día y una hora que aún no hayan pasado.');
  const fecha = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(d);
  await q(`UPDATE aprobaciones SET publicar_en=$2, fecha_prevista=$3, fallo_pub=NULL, tambien=$4 WHERE id=$1`, [id, d, fecha, ambas === undefined ? ap.tambien : (ambas && ap.canal === 'linkedin' ? 'facebook' : null)]);
  await log('dueno', `ha movido al ${textoCuando(d)} la publicación «${ap.titulo}».`, { aprobacion_id: id });
  await emitir({ tipo: 'calendario' });
}

/** Deja de estar programado y vuelve a la mesa de Dirección. */
export async function desprogramar(id) {
  const r = await q(`UPDATE aprobaciones SET estado='pendiente', resuelta=NULL, publicar_en=NULL, fallo_pub=NULL WHERE id=$1 AND estado='programada' RETURNING *`, [id]);
  if (!r.rows[0]) throw new Error('Ese post ya no está programado.');
  await log('dueno', `ha quitado del calendario «${r.rows[0].titulo}»: vuelve a su mesa.`, { aprobacion_id: id });
  await emitir({ tipo: 'calendario' }); await emitir({ tipo: 'mesa_cambiada' });
}

/** Dirección apunta un post que ya tiene programado fuera (en LinkedIn o Facebook): ocupa su hueco en el calendario
 *  y Álex lo tiene en cuenta (ni ese día ni ese tema). La oficina no lo publica. */
export async function apuntarExterno({ canal, cuando, titulo, texto }) {
  const red = ['linkedin', 'facebook', 'instagram'].includes(canal) ? canal : 'linkedin';
  const d = deMadrid(cuando);
  if (!d) throw new Error('Pon el día y la hora a la que lo tienes programado.');
  const t = String(titulo || '').trim() || String(texto || '').trim().split('\n')[0].slice(0, 90);
  if (!t) throw new Error('Pon un título o pega el texto del post.');
  const id = crypto.randomBytes(5).toString('hex');
  const fecha = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(d);
  await q(`INSERT INTO aprobaciones (id, agente, tipo, titulo, texto, ref, canal, fecha_prevista, publicar_en, estado, resuelta)
           VALUES ($1,'dueno','post',$2,$3,'externo',$4,$5,$6,$7,$8)`,
    [id, t.slice(0, 160), String(texto || '').trim() || t, red, fecha, d, d > new Date() ? 'externa' : 'publicada', d > new Date() ? null : d]);
  if (d <= new Date()) await memoria.publicar({ aprobacion_id: id, agente: 'dueno', titulo: t, texto: String(texto || '').trim() || t, canal: red, formato: 'post' });
  await log('dueno', `ha apuntado en el calendario un post que tiene programado en ${RED[red] || red} para el ${textoCuando(d)}: ${t.slice(0, 120)}`);
  await emitir({ tipo: 'calendario' });
  return id;
}
export async function quitarExterno(id) {
  const r = await q(`DELETE FROM aprobaciones WHERE id=$1 AND ref='externo' RETURNING titulo`, [id]);
  if (!r.rows[0]) throw new Error('Ese post no está apuntado como externo.');
  await q(`DELETE FROM publicaciones WHERE aprobacion_id=$1`, [id]).catch(() => {});
  await emitir({ tipo: 'calendario' });
}

/** «Más tarde» con fecha: la tarjeta baja al fondo hasta ese momento y queda apuntada en el calendario (te avisa a esa hora). */
export async function posponer(id, { dias = 7, hasta = null, llamada = false } = {}) {
  const ap = (await q(`SELECT a.*, e.nombre AS empresa, e.telefono AS tel FROM aprobaciones a LEFT JOIN empresas e ON e.id=a.empresa_id WHERE a.id=$1`, [id])).rows[0];
  if (!ap || ap.estado !== 'pendiente') throw Object.assign(new Error('Ya no está en la mesa.'), { status: 409 });
  const agenda = await import('./agenda.js');
  if (hasta) {
    const m = String(hasta).match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
    if (!m) throw new Error('Elige el día y la hora.');
    const cuando = (await q(`SELECT ($1::timestamp AT TIME ZONE 'Europe/Madrid') AS t`, [`${m[1]} ${m[2]}`])).rows[0].t;
    if (new Date(cuando) <= new Date()) throw new Error('Esa fecha ya ha pasado.');
    const r = (await q(`UPDATE aprobaciones SET pospuesta=$2 WHERE id=$1 AND estado='pendiente' RETURNING pospuesta`, [id, cuando])).rows[0];
    const previo = (await q(`SELECT id FROM recordatorios WHERE aprobacion_id=$1 AND hecho IS NULL ORDER BY id DESC LIMIT 1`, [id])).rows[0];
    const texto = `${llamada ? 'Llamar: ' : ''}${ap.empresa ? ap.empresa + ' · ' : ''}${String(ap.titulo).replace(/\.$/, '')}`;
    if (previo) await agenda.mover(previo.id, { dia: m[1], hora: m[2] });
    else await agenda.recordar({ dia: m[1], hora: m[2], texto, creado_por: 'dueno', clase: llamada ? 'llamada' : null, empresa_id: ap.empresa_id, telefono: llamada ? ap.tel : null, aprobacion_id: id });
    await emitir({ tipo: 'aprobacion_pospuesta', id, pospuesta: r.pospuesta });
    return { ok: true, pospuesta: r.pospuesta, calendario: true };
  }
  const d = Math.max(0, Math.min(60, Number(dias ?? 7)));
  const r = (await q(`UPDATE aprobaciones SET pospuesta = CASE WHEN $2::int = 0 THEN NULL ELSE now() + make_interval(days => $2::int) END WHERE id=$1 AND estado='pendiente' RETURNING pospuesta`, [id, d])).rows[0];
  if (d === 0) await q(`UPDATE recordatorios SET hecho=now() WHERE aprobacion_id=$1 AND hecho IS NULL`, [id]);
  await emitir({ tipo: 'aprobacion_pospuesta', id, pospuesta: r.pospuesta });
  return { ok: true, pospuesta: r.pospuesta };
}

/** Cuándo conviene retomarla: para llamadas, el mejor hueco según el sector de la empresa; si no, el siguiente día laborable por la mañana. */
export async function sugerirCuando(id) {
  const ap = (await q(`SELECT a.empresa_id, e.sector FROM aprobaciones a LEFT JOIN empresas e ON e.id=a.empresa_id WHERE a.id=$1`, [id])).rows[0];
  if (!ap) throw Object.assign(new Error('Ya no está en la mesa.'), { status: 404 });
  const consejo = await consejoHora(ap.empresa_id);
  const ahora = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', hourCycle: 'h23' }).format(new Date());
  const h = siguienteHueco(ap.sector, Number(ahora) < 14 ? '10:00' : '16:00');
  return { dia: h.dia, hora: h.hora, consejo: consejo.texto, sector: consejo.sector };
}
