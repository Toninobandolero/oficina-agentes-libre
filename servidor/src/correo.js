// Correo de la oficina (oficina@…). Nunca sale nada sin Dirección y nunca en frío (LSSI, art. 21):
// solo se escribe a quien ya nos ha escrito o a una empresa que ya está en conversación.
// El buzón se lee solo: si escribe un lead, aviso a Dirección y Paula prepara la respuesta; los boletines son para Sara.
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { q } from './db.js';
import { config } from './config.js';
import * as miEmpresa from './empresa.js';
import { log } from './bus.js';
import * as empresas from './empresas.js';
import * as aprobaciones from './aprobaciones.js';
import * as tareas from './tareas.js';
import * as telegram from './telegram.js';
import { AGENTES } from './agentes.js';

export const activo = () => Boolean(config.correo.usuario && config.correo.clave);
const EN_CONVERSACION = ['conversacion', 'reunion', 'propuesta', 'ganada'];
const dominio = s => String(s || '').toLowerCase().replace(/^.*@/, '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
const limpiarDir = s => String(s || '').trim().toLowerCase();
const DOMINIOS_GENERICOS = new Set(['gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.es', 'yahoo.com', 'icloud.com', 'live.com', 'hotmail.es', 'outlook.es', 'msn.com', 'me.com', 'protonmail.com']);

let transporte = null;
function smtp() {
  if (transporte) return transporte;
  if (process.env.CORREO_SIMULADO) return (transporte = nodemailer.createTransport({ jsonTransport: true }));
  const [host, puerto] = config.correo.smtp.split(':');
  transporte = nodemailer.createTransport({ host, port: Number(puerto || 465), secure: Number(puerto || 465) === 465, auth: { user: config.correo.usuario, pass: config.correo.clave } });
  return transporte;
}

/** ¿Podemos escribir a esta dirección? Solo si ya nos escribió o la empresa está en conversación. */
export async function puedeEscribir(para, empresa = null) {
  const dir = limpiarDir(para);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(dir)) return { ok: false, motivo: 'La dirección no es válida.' };
  const nos = (await q(`SELECT 1 FROM correos WHERE direccion='entrada' AND lower(de)=$1 LIMIT 1`, [dir])).rows.length;
  if (nos) return { ok: true, motivo: 'Nos ha escrito antes' };
  if (empresa && EN_CONVERSACION.includes(empresa.estado)) return { ok: true, motivo: 'La empresa está en conversación' };
  const form = (await q(`SELECT 1 FROM entradas WHERE lower(email)=$1 AND consentimiento LIMIT 1`, [dir]).catch(() => ({ rows: [] }))).rows.length;
  if (form) return { ok: true, motivo: 'Nos escribió desde el formulario de la web' };
  return { ok: false, motivo: 'No podemos escribirle en frío: la LSSI (art. 21) prohíbe las comunicaciones comerciales por correo sin consentimiento previo, también entre empresas. Solo a quien nos ha escrito o ya está en conversación con Dirección.' };
}

/** Un agente prepara un correo: queda como borrador en la mesa de Dirección con el botón «Enviar». */
export async function preparar({ agente, empresa_id = null, para, asunto, texto, en_respuesta_a = null, adjuntar_documento = null }) {
  if (!activo()) throw new Error('El correo de la oficina no está configurado.');
  const emp = empresa_id ? await empresas.leer(empresa_id) : null;
  const permiso = await puedeEscribir(para, emp);
  if (!permiso.ok) throw new Error(permiso.motivo);
  const previo = en_respuesta_a ? (await q(`SELECT * FROM correos WHERE id=$1`, [en_respuesta_a])).rows[0] : null;
  const asu = String(asunto || (previo ? `Re: ${String(previo.asunto || '').replace(/^re:\s*/i, '')}` : '')).slice(0, 200);
  if (!asu.trim() || !String(texto || '').trim()) throw new Error('El correo necesita asunto y texto.');
  const adjunto = adjuntar_documento ? await (await import('./documento.js')).deAprobacion(adjuntar_documento) : null;
  if (adjuntar_documento && !adjunto) throw new Error('No encuentro ese documento: usa el id de su tarjeta.');
  const r = await q(`INSERT INTO correos (direccion, de, para, asunto, texto, empresa_id, en_respuesta_a, adjunto) VALUES ('borrador',$1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [config.correo.usuario, limpiarDir(para), asu, String(texto).trim(), emp?.id ?? previo?.empresa_id ?? null, previo?.message_id ?? null, adjunto ? adjuntar_documento : null]);
  const id = r.rows[0].id;
  const apId = await aprobaciones.crear({
    agente, tipo: 'correo', empresa_id: emp?.id ?? previo?.empresa_id ?? null, ref: `correo:${id}`,
    titulo: `ha preparado un correo para ${para}${emp ? ` (${emp.nombre})` : ''}`,
    texto: `Para: ${para}\nAsunto: ${asu}${adjunto ? `\nAdjunto: ${adjunto.nombre}` : ''}\n\n${String(texto).trim()}\n\n${firma()}`,
    opciones: [{ r: 'enviar', t: '📧 Enviar' }, { r: 'cambios' }, { r: 'descartada', t: 'Descartar' }],
    importancia: previo ? 'alta' : null, motivo: previo ? 'Respuesta a un correo que nos han enviado' : null,
  });
  return { borrador: id, aprobacion: apId };
}

const firma = () => ['—', [miEmpresa.dueno(), config.correo.nombre || miEmpresa.nombre()].filter(Boolean).join(' · '), config.empresa.lema, miEmpresa.web()].filter(Boolean).join('\n');

/** Acuse automático a quien rellena el formulario de la web: ha pedido que le contestemos, así que sale solo y al momento.
 *  Es corto y personal; la respuesta de verdad (o el diagnóstico) la prepara el equipo y Dirección la aprueba. */
export async function acuse({ para, nombre, tipo, empresa_id = null }) {
  if (!activo() || !para) return null;
  const pila = String(nombre || '').trim().split(/\s+/)[0] || '';
  const asunto = tipo === 'diagnostico' ? 'Tu diagnóstico gratis: ya estamos con ello' : 'Hemos recibido tu mensaje';
  const texto = `Hola${pila ? ' ' + pila : ''}:\n\n` + (tipo === 'diagnostico'
    ? 'Gracias por pedir el diagnóstico. Lo estamos preparando con lo que nos has contado y te lo envío en menos de 48 horas laborables, en una página y sin compromiso.'
    : 'Gracias por escribirnos. Lo he recibido y te contesto personalmente en menos de 24 horas laborables.') +
    '\n\nSi prefieres que hablemos por teléfono, responde a este correo con un número y una hora que te venga bien.';
  const info = await smtp().sendMail({ from: { name: config.correo.nombre || miEmpresa.nombre(), address: config.correo.usuario }, to: para, subject: asunto, text: `${texto}\n\n${firma()}` });
  await q(`INSERT INTO correos (direccion, de, para, asunto, texto, empresa_id, message_id, enviado) VALUES ('salida',$1,$2,$3,$4,$5,$6, now())`,
    [config.correo.usuario, limpiarDir(para), asunto, texto, empresa_id, info.messageId || null]);
  await log('sistema', `ha enviado el acuse automático a ${para}: «${asunto}»`, { empresa_id });
  return info.messageId;
}

/** Un boletín a una persona de la lista, con su enlace de baja. Quién lo recibe lo decide boletin.js. */
export async function enviarBoletin({ para, asunto, texto, baja }) {
  const cuerpo = `${texto}\n\n${firma()}\n\nRecibes este correo porque te apuntaste en nuestra web. Para no recibir más: ${baja}`;
  const info = await smtp().sendMail({ from: { name: config.correo.nombre, address: config.correo.usuario }, to: para, subject: asunto, text: cuerpo,
    headers: { 'List-Unsubscribe': `<${baja}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } });
  await q(`INSERT INTO correos (direccion, de, para, asunto, texto, message_id, clase, enviado) VALUES ('salida',$1,$2,$3,$4,$5,'boletin', now())`,
    [config.correo.usuario, limpiarDir(para), asunto, texto, info.messageId || null]);
  return info;
}

/** Dirección ha pulsado «Enviar». */
/** El PDF que acompaña a un correo: se genera al enviar, así lleva lo último de la tarjeta. */
export async function adjuntos(b) {
  if (!b.adjunto) return [];
  const a = await (await import('./documento.js')).deAprobacion(b.adjunto);
  return a ? [{ filename: a.nombre, content: a.datos, contentType: 'application/pdf' }] : [];
}

export async function enviarBorrador(id) {
  const b = (await q(`SELECT * FROM correos WHERE id=$1 AND direccion='borrador'`, [id])).rows[0];
  if (!b) throw new Error('Ese borrador ya no existe o ya se envió.');
  const emp = b.empresa_id ? await empresas.leer(b.empresa_id) : null;
  const permiso = await puedeEscribir(b.para, emp);
  if (!permiso.ok) throw new Error(permiso.motivo);
  const info = await smtp().sendMail({
    from: { name: config.correo.nombre || miEmpresa.nombre(), address: config.correo.usuario }, to: b.para, subject: b.asunto,
    text: `${b.texto}\n\n${firma()}`, attachments: await adjuntos(b),
    ...(b.en_respuesta_a ? { inReplyTo: b.en_respuesta_a, references: [b.en_respuesta_a] } : {}),
  });
  await q(`UPDATE correos SET direccion='salida', message_id=$2, enviado=now() WHERE id=$1`, [id, info.messageId || null]);
  if (emp) await empresas.actualizar(emp.id, { ultimo_contacto: new Date().toISOString().slice(0, 10) });
  await log('dueno', `ha enviado un correo a ${b.para}: «${b.asunto}»`, { empresa_id: b.empresa_id });
  return info.messageId;
}

/** Un correo que ha llegado: lo guarda, lo clasifica y avisa si es de un lead. Devuelve el id o null si ya estaba. */
export async function procesarEntrante(m) {
  const de = limpiarDir(m.from?.value?.[0]?.address);
  const nombre = m.from?.value?.[0]?.name || de;
  const mid = m.messageId || `${de}-${m.date?.toISOString?.() || Date.now()}`;
  if ((await q(`SELECT 1 FROM correos WHERE message_id=$1`, [mid])).rows.length) return null;
  const texto = String(m.text || '').replace(/\r/g, '').slice(0, 20000);
  // Avisos de LinkedIn (reenviados por Dirección): se leen aparte y nunca se tratan como un lead que escribe
  const avisos = await import('./avisosLinkedin.js');
  if (avisos.esAviso(m)) {
    const r = await q(`INSERT INTO correos (direccion, de, para, asunto, texto, message_id, clase, creada) VALUES ('entrada',$1,$2,$3,$4,$5,'linkedin',coalesce($6, now())) RETURNING id`,
      [de, config.correo.usuario, String(m.subject || '').slice(0, 300), texto, mid, m.date || null]);
    await avisos.procesar(m).catch(e => console.error('Aviso de LinkedIn:', e.message));
    return r.rows[0].id;
  }
  const cab = m.headers || new Map();
  const esBoletin = cab.has?.('list-unsubscribe') || cab.has?.('list-id') || /bulk|list/i.test(String(cab.get?.('precedence') || ''));
  // ¿Es de una empresa nuestra o responde a algo que enviamos?
  const respondeA = m.inReplyTo ? (await q(`SELECT empresa_id FROM correos WHERE message_id=$1`, [m.inReplyTo])).rows[0] : null;
  let emp = respondeA?.empresa_id ? await empresas.leer(respondeA.empresa_id) : null;
  if (!emp && de) emp = (await q(`SELECT * FROM empresas WHERE lower(email)=$1 LIMIT 1`, [de])).rows[0] || null;
  const dom = dominio(de);
  if (!emp && dom && !DOMINIOS_GENERICOS.has(dom)) emp = (await q(`SELECT * FROM empresas WHERE lower(regexp_replace(coalesce(web,''), '^(https?://)?(www\\.)?', '')) LIKE $1 LIMIT 1`, [dom + '%'])).rows[0] || null;
  if (!emp && de) {   // alguien a quien ya habíamos escrito
    const s = (await q(`SELECT empresa_id FROM correos WHERE direccion='salida' AND lower(para)=$1 AND empresa_id IS NOT NULL LIMIT 1`, [de])).rows[0];
    if (s) emp = await empresas.leer(s.empresa_id);
  }
  const clase = emp ? 'lead' : esBoletin ? 'boletin' : 'otro';
  const r = await q(`INSERT INTO correos (direccion, de, para, asunto, texto, message_id, en_respuesta_a, empresa_id, clase, creada)
                     VALUES ('entrada',$1,$2,$3,$4,$5,$6,$7,$8,coalesce($9, now())) RETURNING id`,
    [de, config.correo.usuario, String(m.subject || '').slice(0, 300), texto, mid, m.inReplyTo || null, emp?.id ?? null, clase, m.date || null]);
  const id = r.rows[0].id;
  if (clase === 'lead') {
    if (['contactada', 'dossier', 'puntuada', 'nueva'].includes(emp.estado)) await empresas.actualizar(emp.id, { estado: 'conversacion' });
    await empresas.actualizar(emp.id, { ultimo_contacto: new Date().toISOString().slice(0, 10), proximo_paso: 'Contestar a su correo', fecha_proximo_paso: new Date().toISOString().slice(0, 10) });
    await log('sistema', `📩 ${nombre} (${emp.nombre}) ha escrito por correo: «${String(m.subject || '').slice(0, 120)}»`, { empresa_id: emp.id });
    await telegram.avisar(`📩 ${nombre} (${emp.nombre}) ha escrito por correo:\n«${String(m.subject || '')}»\n\n${texto.slice(0, 800)}${texto.length > 800 ? '…' : ''}\n\nPaula te prepara la respuesta.`);
    await tareas.crear('paula', `${nombre} <${de}> (${emp.nombre}) nos ha escrito por correo.\nAsunto: «${m.subject || ''}»\n\n${texto.slice(0, 6000)}\n\n` +
      `Clasifícalo, actualiza la empresa y prepara la respuesta con preparar_correo (en_respuesta_a: ${id}). Si no hay que contestar por correo, dilo con anotar.`, { empresa_id: emp.id, origen: 'sistema' });
  } else if (clase === 'otro') {
    await log('sistema', `ha llegado un correo de ${nombre}: «${String(m.subject || '').slice(0, 120)}» (no es de ninguna empresa nuestra)`);
  }
  return id;
}

let leyendo = false, ultimaLectura = 0;
/** Lee lo nuevo del buzón (como mucho cada 5 minutos). */
export async function revisarBuzon({ forzar = false } = {}) {
  if (!activo() || process.env.CORREO_SIMULADO || leyendo) return 0;
  if (!forzar && Date.now() - ultimaLectura < 5 * 60_000) return 0;
  leyendo = true; ultimaLectura = Date.now();
  const [host, puerto] = config.correo.imap.split(':');
  const cliente = new ImapFlow({ host, port: Number(puerto || 993), secure: true, auth: { user: config.correo.usuario, pass: config.correo.clave }, logger: false });
  let n = 0;
  try {
    await cliente.connect();
    const cerrojo = await cliente.getMailboxLock('INBOX');
    try {
      const nuevos = await cliente.search({ seen: false });
      for (const uid of (nuevos || []).slice(0, 30)) {
        const msg = await cliente.fetchOne(uid, { source: true });
        if (!msg?.source) continue;
        if (await procesarEntrante(await simpleParser(msg.source))) n++;
        await cliente.messageFlagsAdd(uid, ['\\Seen']);
      }
    } finally { cerrojo.release(); }
    await cliente.logout();
  } catch (e) {
    console.error('Correo (IMAP):', e.message);
  } finally { leyendo = false; }
  return n;
}

/** Para Sara: los boletines de los últimos días. */
export async function boletines(dias = 7, limite = 15) {
  const r = await q(`SELECT de, asunto, left(texto, 1500) AS texto, creada FROM correos WHERE direccion='entrada' AND clase='boletin'
                      AND creada > now() - ($1 || ' days')::interval ORDER BY creada DESC LIMIT $2`, [String(dias), limite]);
  return r.rows;
}

export async function deEmpresa(empresaId) {
  return (await q(`SELECT id, direccion, de, para, asunto, left(texto, 4000) AS texto, coalesce(enviado, creada) AS fecha FROM correos
                    WHERE empresa_id=$1 AND direccion <> 'borrador' ORDER BY coalesce(enviado, creada)`, [empresaId])).rows;
}

export const nombreAgente = id => AGENTES[id]?.nombre ?? id;
