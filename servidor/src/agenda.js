import crypto from 'node:crypto';
// Agenda general de la oficina: un solo calendario con posts, eventos, seguimientos, pasos de las secuencias,
// reuniones de equipo y recordatorios. Cada cosa sale de su sitio; aquí solo se juntan por días.
import { q, ajuste, fijarAjuste } from './db.js';
import { config } from './config.js';
import { emitir, log } from './bus.js';
import * as aprobaciones from './aprobaciones.js';
import { T } from './en.js';

export const TIPOS = ['post', 'evento', 'seguimiento', 'paso', 'llamada', 'reunion', 'recordatorio'];
const madridDia = d => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(d);
const madridHora = () => new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' }).format(new Date());

export async function entre(desde, hasta, tipos = TIPOS) {
  const quiero = new Set(tipos.filter(t => TIPOS.includes(t)));
  const out = [];
  if (quiero.has('post')) for (const x of await aprobaciones.calendario(desde, hasta)) out.push({ tipo: 'post', ...x });
  if (quiero.has('evento')) {
    for (const e of (await q(`SELECT id, nombre, fecha::text AS dia, lugar, web, estado, notas FROM alianzas WHERE tipo='evento' AND fecha BETWEEN $1 AND $2 AND estado <> 'descartada'`, [desde, hasta])).rows)
      out.push({ tipo: 'evento', id: `ev${e.id}`, dia: e.dia, titulo: e.nombre, detalle: [e.lugar, e.estado === 'apuntado' ? 'Vas a ir' : e.estado === 'asistido' ? 'Fuiste' : 'Por decidir'].filter(Boolean).join(' · '), enlace: e.web || null, estado: e.estado });
  }
  if (quiero.has('seguimiento')) {
    for (const e of (await q(`SELECT id, nombre, proximo_paso, fecha_proximo_paso::text AS dia, estado FROM empresas WHERE fecha_proximo_paso BETWEEN $1 AND $2 AND estado NOT IN ('ganada','perdida','descartada')
                               AND NOT EXISTS (SELECT 1 FROM recordatorios r WHERE r.clase='llamada' AND r.empresa_id=empresas.id AND r.dia=empresas.fecha_proximo_paso)`, [desde, hasta])).rows)
      out.push({ tipo: 'seguimiento', id: `emp:${e.id}`, empresa_id: e.id, dia: e.dia, titulo: `${e.nombre}: ${e.proximo_paso || 'seguimiento'}`, detalle: `Estado: ${e.estado}` });
  }
  if (quiero.has('paso')) {
    for (const p of (await q(`SELECT p.id, p.titulo, p.clave, p.canal, p.estado, p.fecha::text AS dia, e.id AS empresa_id, e.nombre FROM pasos p JOIN secuencias s ON s.id=p.secuencia_id JOIN empresas e ON e.id=s.empresa_id
                               WHERE p.fecha BETWEEN $1 AND $2 AND p.estado IN ('programado','en_mesa','hecho') AND s.estado IN ('activa','respondida')`, [desde, hasta])).rows)
      out.push({ tipo: 'paso', id: `paso:${p.id}`, empresa_id: p.empresa_id, dia: p.dia, titulo: `${p.nombre}: ${p.titulo || p.clave}`, detalle: `${p.canal} · ${p.estado === 'hecho' ? 'hecho' : p.estado === 'en_mesa' ? 'en tu mesa' : 'programado'}`, estado: p.estado });
  }
  if (quiero.has('reunion')) {
    const d = new Date(desde + 'T12:00:00Z'), fin = new Date(hasta + 'T12:00:00Z');
    for (; d <= fin; d.setUTCDate(d.getUTCDate() + 1)) if (d.getUTCDay() === config.reunionDia)
      out.push({ tipo: 'reunion', id: `reu:${d.toISOString().slice(0, 10)}`, dia: d.toISOString().slice(0, 10), hora: config.reunionHora, titulo: 'Reunión de equipo', detalle: 'Cada agente cuenta lo que lleva; Máximo deja el acta' });
  }
  if (quiero.has('recordatorio') || quiero.has('llamada')) {
    for (const r of (await q(`SELECT id, dia::text AS dia, hora, texto, hecho, creado_por, clase, empresa_id, telefono, detalle FROM recordatorios WHERE dia BETWEEN $1 AND $2`, [desde, hasta])).rows) {
      const tipo = r.clase === 'llamada' ? 'llamada' : 'recordatorio';
      if (!quiero.has(tipo)) continue;
      const quien = r.creado_por !== 'dueno' ? `Lo apuntó ${r.creado_por === 'lola' ? 'Lola' : (r.creado_por.charAt(0).toUpperCase() + r.creado_por.slice(1))}` : '';
      out.push({ tipo, id: `rec:${r.id}`, rid: r.id, dia: r.dia, hora: r.hora, titulo: r.texto, estado: r.hecho ? 'hecho' : 'pendiente',
        detalle: [r.detalle, quien].filter(Boolean).join(' · '), empresa_id: r.empresa_id || undefined, telefono: r.telefono || undefined });
    }
  }
  return out.sort((a, b) => String(a.dia).localeCompare(String(b.dia)) || String(a.hora || '99').localeCompare(String(b.hora || '99')));
}

export async function recordar({ dia, hora, texto, creado_por = 'dueno', clase = null, empresa_id = null, telefono = null, detalle = null, aprobacion_id = null }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dia || ''))) throw new Error(T('Elige el día.'));
  const h = /^\d{2}:\d{2}$/.test(String(hora || '')) ? hora : null;
  const t = String(texto || '').trim();
  if (!t) throw new Error(T('Escribe qué hay que recordar.'));
  // Una sola llamada pendiente por empresa: si ya hay una apuntada (de Paula, de Máximo o tuya) en estos días, se pone al día esa y no se añade otra
  if (clase === 'llamada' && empresa_id && creado_por !== 'dueno') {   // las tuyas se respetan siempre
    const ya = (await q(`SELECT id, detalle FROM recordatorios WHERE clase='llamada' AND empresa_id=$1 AND hecho IS NULL AND creado_por <> 'dueno' AND dia BETWEEN ($2::date - 3) AND ($2::date + 3) ORDER BY creado DESC LIMIT 1`, [empresa_id, dia])).rows[0];
    if (ya) {
      const det = [ya.detalle, detalle].filter(Boolean).filter((x, i, l) => l.indexOf(x) === i).join(' · ').slice(-600);
      await q(`UPDATE recordatorios SET dia=$2, hora=coalesce($3, hora), texto=$4, telefono=coalesce($5, telefono), detalle=$6, avisado=NULL WHERE id=$1`, [ya.id, dia, h, t.slice(0, 500), telefono ? String(telefono).slice(0, 30) : null, det || null]);
      await emitir({ tipo: 'calendario' });
      return ya.id;
    }
  }
  if (!clase && (await q(`SELECT 1 FROM recordatorios WHERE dia=$1 AND texto=$2 AND hecho IS NULL`, [dia, t.slice(0, 500)])).rows.length) return null;
  const r = (await q(`INSERT INTO recordatorios (dia, hora, texto, creado_por, clase, empresa_id, telefono, detalle, aprobacion_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [dia, h, t.slice(0, 500), creado_por, clase === 'llamada' ? 'llamada' : null, empresa_id || null, telefono ? String(telefono).slice(0, 30) : null, detalle ? String(detalle).slice(0, 600) : null, aprobacion_id || null])).rows[0];
  await emitir({ tipo: 'calendario' });
  return r.id;
}
/** Cambia el día o la hora (p. ej. una llamada que Dirección prefiere devolver más tarde). Vuelve a avisar a la nueva hora. */
/** El aviso de una tarjeta pospuesta y la tarjeta van juntos: lo que se hace en el calendario se hace también en la mesa.
 *  cuando = SQL de la nueva fecha (r. es el aviso) o NULL para que vuelva ya a la mesa. */
async function conSuTarjeta(id, cuando) {
  const r = await q(`UPDATE aprobaciones a SET pospuesta=${cuando} FROM recordatorios r WHERE r.id=$1 AND a.id=r.aprobacion_id AND a.estado='pendiente' RETURNING a.id, a.pospuesta`, [id]);
  for (const a of r.rows) await emitir({ tipo: 'aprobacion_pospuesta', id: a.id, pospuesta: a.pospuesta });
}

export async function mover(id, { dia, hora }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dia || ''))) throw new Error(T('Elige el día.'));
  await q(`UPDATE recordatorios SET dia=$2, hora=$3, avisado=NULL WHERE id=$1`, [id, dia, /^\d{2}:\d{2}$/.test(String(hora || '')) ? hora : null]);
  await conSuTarjeta(id, `(r.dia + coalesce(r.hora, '09:00')::time) AT TIME ZONE 'Europe/Madrid'`);
  await emitir({ tipo: 'calendario' });
}
/** Marcar hecho una llamada desde el calendario también quita su recado de la mesa (y al revés: ver aprobaciones.resolver). */
export async function marcarHecho(id, hecho = true, { desdeMesa = false } = {}) {
  await q(`UPDATE recordatorios SET hecho=${hecho ? 'now()' : 'NULL'} WHERE id=$1`, [id]);
  if (hecho && !desdeMesa) await conSuTarjeta(id, 'NULL');
  // Hecha la llamada de ese día, no queda otro aviso igual para la misma empresa
  if (hecho) await q(`UPDATE recordatorios o SET hecho=now() FROM recordatorios r WHERE r.id=$1 AND r.clase='llamada' AND r.empresa_id IS NOT NULL AND o.empresa_id=r.empresa_id AND o.dia=r.dia AND o.clase='llamada' AND o.hecho IS NULL`, [id]);
  await emitir({ tipo: 'calendario' });
  if (hecho && !desdeMesa) {
    const ap = (await q(`SELECT id FROM aprobaciones WHERE ref=$1 AND estado='pendiente'`, [`voz:${id}`])).rows[0];
    if (ap) await aprobaciones.resolver(ap.id, 'aprobada').catch(e => console.error('Recado (mesa):', e.message));
  }
}
export async function borrar(id) { await conSuTarjeta(id, 'NULL'); await q(`DELETE FROM recordatorios WHERE id=$1`, [id]); await emitir({ tipo: 'calendario' }); }

/** Cada vuelta del planificador: los recordatorios que llegan a su hora (o a las 9:00 si son de todo el día) avisan a Dirección. */
export async function avisarRecordatorios() {
  const hoy = madridDia(new Date()), ahora = madridHora();
  // Llamadas repetidas a la misma empresa el mismo día (de antes de juntarlas): se queda la última apuntada
  await q(`UPDATE recordatorios r SET hecho=now() WHERE r.hecho IS NULL AND r.clase='llamada' AND r.empresa_id IS NOT NULL AND r.creado_por <> 'dueno'
    AND EXISTS (SELECT 1 FROM recordatorios o WHERE o.id<>r.id AND o.hecho IS NULL AND o.clase='llamada' AND o.creado_por <> 'dueno' AND o.empresa_id=r.empresa_id AND o.dia=r.dia AND (o.creado, o.id) > (r.creado, r.id))`);
  const r = (await q(`SELECT * FROM recordatorios WHERE avisado IS NULL AND hecho IS NULL AND (dia < $1 OR (dia = $1 AND coalesce(hora, '09:00') <= $2))`, [hoy, ahora])).rows;
  for (const x of r) {
    await q(`UPDATE recordatorios SET avisado=now() WHERE id=$1`, [x.id]);
    const llamada = x.clase === 'llamada';
    // Que salte en el panel, no solo en la actividad: con su botón de llamar
    await emitir({ tipo: 'aviso_agenda', id: x.id, clase: llamada ? 'llamada' : 'recordatorio', hora: x.hora, titulo: x.texto, detalle: x.detalle || null, empresa_id: x.empresa_id || null, telefono: x.telefono || null });
    await log('sistema', `${llamada ? T('te recuerda que toca devolver una llamada') : T('te recuerda')}${x.hora ? ` (${x.hora})` : ''}: ${x.texto}${x.telefono ? ` · ${x.telefono}` : ''}`, { empresa_id: x.empresa_id || undefined });
    try { (await import('./telegram.js')).avisar(`${llamada ? '📞 Toca devolver la llamada' : '⏰ Recordatorio'}${x.hora ? ` · ${x.hora}` : ''}\n${x.texto}${x.telefono ? `\nTel: ${x.telefono}` : ''}${x.detalle ? `\n\n${String(x.detalle).slice(0, 500)}` : ''}`); } catch {}
  }
  return r.length;
}

// ---------- Suscripción para el móvil (iCalendar) ----------
// Una dirección secreta que el calendario del móvil (iPhone, Google Calendar, Outlook) consulta cada poco.
// Solo lectura. Se puede cambiar la dirección (y la anterior deja de funcionar) desde el panel.
export async function tokenIcs(nuevo = false) {
  let t = await ajuste('ics_token', null);
  if (!t || nuevo) { t = crypto.randomBytes(18).toString('base64url'); await fijarAjuste('ics_token', t); }
  return t;
}
export async function tokenValido(t) { const g = await ajuste('ics_token', null); return Boolean(g) && typeof t === 'string' && t.length === g.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(g)); }
const escIcs = s => String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
const plegar = l => { const out = []; let x = l; while (Buffer.byteLength(x) > 74) { let n = 74; while (Buffer.byteLength(x.slice(0, n)) > 74) n--; out.push(x.slice(0, n)); x = ' ' + x.slice(n); } out.push(x); return out.join('\r\n'); };
const ICONO = { post: '📣', evento: '🎟', seguimiento: '🔁', paso: '✉️', llamada: '📞', reunion: '🗣', recordatorio: '⏰' };
export async function ics(tipos = TIPOS) {
  const hoy = new Date(), desde = new Date(hoy - 30 * 864e5).toISOString().slice(0, 10), hasta = new Date(+hoy + 180 * 864e5).toISOString().slice(0, 10);
  const items = await entre(desde, hasta, tipos);
  const sello = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const l = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Oficina de agentes//Agenda//ES', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:Oficina de agentes', 'X-WR-TIMEZONE:Europe/Madrid', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H',
    'BEGIN:VTIMEZONE', 'TZID:Europe/Madrid', 'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST', 'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET', 'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD', 'END:VTIMEZONE'];
  for (const x of items) {
    if (!x.dia) continue;
    const d = String(x.dia).replace(/-/g, '');
    const titulo = x.tipo === 'post' ? `${x.canal === 'facebook' ? 'Facebook' : 'LinkedIn'}: ${String(x.titulo).replace(/^ha (preparado|rehecho) /, '')}` : x.titulo;
    const estado = x.tipo === 'post' ? ({ programada: 'programado', publicada: 'publicado', pendiente: 'propuesto, en tu mesa', externa: 'programado por ti en la red' })[x.estado] || x.estado : x.detalle || '';
    l.push('BEGIN:VEVENT', `UID:${x.tipo}-${x.id}@oficina-agentes`, `DTSTAMP:${sello}`);
    if (x.hora && /^\d{2}:\d{2}$/.test(x.hora)) {
      const h = x.hora.replace(':', '');
      const fin = new Date(`${x.dia}T${x.hora}:00Z`); fin.setUTCMinutes(fin.getUTCMinutes() + (x.tipo === 'reunion' ? 45 : x.tipo === 'llamada' ? 15 : 30));
      l.push(`DTSTART;TZID=Europe/Madrid:${d}T${h}00`, `DTEND;TZID=Europe/Madrid:${fin.toISOString().slice(0, 10).replace(/-/g, '')}T${fin.toISOString().slice(11, 16).replace(':', '')}00`);
    } else {
      const sig = new Date(x.dia + 'T12:00:00Z'); sig.setUTCDate(sig.getUTCDate() + 1);
      l.push(`DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${sig.toISOString().slice(0, 10).replace(/-/g, '')}`);
    }
    l.push(plegar(`SUMMARY:${escIcs(`${ICONO[x.tipo] || ''} ${titulo}`.trim())}`));
    const desc = [x.tipo === 'llamada' && x.telefono ? `Tel: ${x.telefono}` : '', estado].filter(Boolean).join('\n');
    if (desc) l.push(plegar(`DESCRIPTION:${escIcs(desc)}`));
    // Las llamadas y recordatorios con hora avisan en el móvil 10 minutos antes
    if (x.hora && ['llamada', 'recordatorio'].includes(x.tipo) && x.estado !== 'hecho')
      l.push('BEGIN:VALARM', 'ACTION:DISPLAY', plegar(`DESCRIPTION:${escIcs(titulo)}`), 'TRIGGER:-PT10M', 'END:VALARM');
    if (x.enlace && /^https?:\/\//.test(x.enlace)) l.push(plegar(`URL:${x.enlace}`));
    if (x.tipo === 'evento' && x.detalle) l.push(plegar(`LOCATION:${escIcs(String(x.detalle).split(' · ')[0])}`));
    l.push('END:VEVENT');
  }
  l.push('END:VCALENDAR');
  return l.join('\r\n') + '\r\n';
}
