// Correo de la oficina (oficina@…). Nada sale sin que Dirección pulse «Enviar», y a quién se escribe lo decide él: el sistema no lo bloquea.
// El buzón se lee solo: si escribe un lead, aviso a Dirección y Paula prepara la respuesta; los boletines son para Sara.
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
import * as cuentas from './cuentasCorreo.js';
import { PRO, M } from './modulos.js';

export const activo = () => Boolean(cuentas.predeterminada());
const dominio = s => String(s || '').toLowerCase().replace(/^.*@/, '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
const limpiarDir = s => String(s || '').trim().toLowerCase();
const DOMINIOS_GENERICOS = new Set(['gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.es', 'yahoo.com', 'icloud.com', 'live.com', 'hotmail.es', 'outlook.es', 'msn.com', 'me.com', 'protonmail.com']);

// Lo último enviado en las pruebas, que no salen de verdad
let ultimoSimulado = null;
export const _ultimoEnvio = () => ultimoSimulado;
/** Por qué no ha salido, dicho para Dirección. */
export function motivoEnvio(e, c) {
  const m = String(e?.message || e);
  if (e?.code === 'EAUTH' || /\b535\b|invalid login|authentication/i.test(m)) return `No ha salido: el servidor de correo no acepta la contraseña de ${c.direccion}.`;
  if (['ETIMEDOUT', 'ESOCKET', 'ECONNECTION', 'EDNS', 'ECONNREFUSED'].includes(e?.code) || /timeout|ECONN|greeting/i.test(m)) return `No ha salido: no se puede conectar con el servidor de correo de ${c.direccion}.`;
  return `No ha salido: el servidor de correo dice «${m.slice(0, 200)}».`;
}

async function mandar(c, mensaje) {
  const info = await cuentas.transporte(c).sendMail({ from: { name: c.nombre, address: c.direccion }, ...mensaje }).catch(e => { throw new Error(motivoEnvio(e, c)); });
  if (process.env.CORREO_SIMULADO) ultimoSimulado = JSON.parse(info.message);
  if (info.rejected?.length && !info.accepted?.length) throw new Error(`El servidor de correo no lo ha aceptado: ${info.rejected.join(', ')}`);
  return info;
}

const dirValida = d => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d);

/** Un agente prepara un correo: queda como borrador en la mesa de Dirección con el botón «Enviar». */
export async function preparar({ agente, empresa_id = null, para, asunto, texto, en_respuesta_a = null, adjuntar_documento = null }) {
  if (!activo()) throw new Error('El correo de la oficina no está configurado.');
  const emp = empresa_id ? await empresas.leer(empresa_id) : null;
  if (!dirValida(limpiarDir(para))) throw new Error('La dirección no es válida.');
  const previo = en_respuesta_a ? (await q(`SELECT * FROM correos WHERE id=$1`, [en_respuesta_a])).rows[0] : null;
  const asu = String(asunto || (previo ? `Re: ${String(previo.asunto || '').replace(/^re:\s*/i, '')}` : '')).slice(0, 200);
  if (!asu.trim() || !String(texto || '').trim()) throw new Error('El correo necesita asunto y texto.');
  const adjunto = adjuntar_documento ? await (await import('./documento.js')).deAprobacion(adjuntar_documento) : null;
  if (adjuntar_documento && !adjunto) throw new Error('No encuentro ese documento: usa el id de su tarjeta.');
  const r = await q(`INSERT INTO correos (direccion, de, para, asunto, texto, empresa_id, en_respuesta_a, adjunto) VALUES ('borrador',$1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [config.correo.usuario, limpiarDir(para), asu, String(texto).trim(), emp?.id ?? previo?.empresa_id ?? null, previo?.message_id ?? null, adjunto ? adjuntar_documento : null]);
  const id = r.rows[0].id;
  if (previo && emp && !previo.empresa_id) await q(`UPDATE correos SET empresa_id=$1, clase='lead' WHERE id=$2`, [emp.id, previo.id]);
  const apId = await aprobaciones.crear({
    agente, tipo: 'correo', empresa_id: emp?.id ?? previo?.empresa_id ?? null, ref: `correo:${id}`,
    titulo: `ha preparado un correo para ${para}${emp ? ` (${emp.nombre})` : ''}`,
    texto: `Para: ${para}\nAsunto: ${asu}${adjunto ? `\nAdjunto: ${adjunto.nombre}` : ''}\n\n${String(texto).trim()}\n\n${firma()}`,
    opciones: [{ r: 'enviar', t: '📧 Enviar' }, { r: 'fuera', t: 'Ya lo envié por otro lado' }, { r: 'cambios' }, { r: 'descartada', t: 'Descartar' }],
    importancia: previo ? 'alta' : null, motivo: previo ? 'Respuesta a un correo que nos han enviado' : null,
  });
  return { borrador: id, aprobacion: apId };
}

const firma = (c = cuentas.predeterminada()) => ['—', [miEmpresa.dueno(), c?.nombre || config.correo.nombre || miEmpresa.nombre()].filter(Boolean).join(' · '), config.empresa.lema, miEmpresa.web()].filter(Boolean).join('\n');

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
  const c = cuentas.predeterminada();
  const info = await mandar(c, { to: para, subject: asunto, text: `${texto}\n\n${firma(c)}` });
  await q(`INSERT INTO correos (direccion, de, para, asunto, texto, empresa_id, message_id, enviado) VALUES ('salida',$1,$2,$3,$4,$5,$6, now())`,
    [c.direccion, limpiarDir(para), asunto, texto, empresa_id, info.messageId || null]);
  await log('sistema', `ha enviado el acuse automático a ${para}: «${asunto}»`, { empresa_id });
  return info.messageId;
}

/** Un boletín a una persona de la lista, con su enlace de baja. Quién lo recibe lo decide boletin.js. */
export async function enviarBoletin({ para, asunto, texto, baja }) {
  const c = cuentas.predeterminada();
  const cuerpo = `${texto}\n\n${firma(c)}\n\nRecibes este correo porque te apuntaste en nuestra web. Para no recibir más: ${baja}`;
  const info = await mandar(c, { to: para, subject: asunto, text: cuerpo,
    headers: { 'List-Unsubscribe': `<${baja}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } });
  await q(`INSERT INTO correos (direccion, de, para, asunto, texto, message_id, clase, enviado) VALUES ('salida',$1,$2,$3,$4,$5,'boletin', now())`,
    [c.direccion, limpiarDir(para), asunto, texto, info.messageId || null]);
  return info;
}

/** Dirección ha pulsado «Enviar». */
const CID_LOGO = 'logo@oficina';

/** Cómo llegará, para verlo antes de enviar. */
export async function vista({ texto, cuenta }) {
  if (!PRO.correoDiseno) return null;
  const logo = (await import('./documento.js')).logoBuffer();
  const tipo = logo?.[0] === 0x89 ? 'image/png' : 'image/jpeg';
  return M.correoDiseno.html({ texto, firma: firma(cuentas.elegir(cuenta)), logo: logo ? `data:${tipo};base64,${logo.toString('base64')}` : '' });
}

/** Lo que dice una tarjeta que no se preparó como correo: quita las notas para Dirección y separa para quién, el asunto y el texto. */
export function partirTarjeta(texto) {
  let para = '', asunto = '', cur = null; const bloques = [];
  for (const l of String(texto || '').replace(/\r/g, '').split('\n')) {
    const t = l.trim();
    const mp = t.match(/^para:\s*(\S+@\S+)/i); if (mp) { para = mp[1]; continue; }
    const ma = t.match(/^asunto:\s*(.+)/i); if (ma) { asunto = ma[1]; continue; }
    if (/^LLAMADA\b/.test(t)) { cur = { titulo: 'LLAMADA', lineas: [] }; bloques.push(cur); continue; }
    const cab = t.replace(/\(.*?\)/g, '').trim();
    if (cab.length >= 4 && /^[A-ZÁÉÍÓÚÑÜ0-9 /·-]+$/.test(cab) && /[A-ZÁÉÍÓÚÑÜ]{3}/.test(cab)) { cur = { titulo: cab, lineas: [] }; bloques.push(cur); continue; }
    if (!cur) { cur = { titulo: '', lineas: [] }; bloques.push(cur); }
    cur.lineas.push(l);
  }
  const de = b => b.lineas.join('\n').trim();
  const delAsunto = bloques.find(b => /^ASUNTO/.test(b.titulo));
  if (delAsunto && !asunto) asunto = de(delAsunto).split('\n')[0];
  const utiles = bloques.filter(b => de(b) && !/NOTAS|CONTEXTO|ASUNTO|PARA DUENO|NO SE ENV|LLAMADA/.test(b.titulo));
  const deLlamada = bloques.some(b => /OBJETIVO|GUI[OÓ]N|APERTURA/.test(b.titulo));   // un guion es para Dirección: de ahí solo sale un correo si trae el suyo
  const elegido = utiles.find(b => /CORREO|E-?MAIL|RESPUESTA|MENSAJE/.test(b.titulo)) || (deLlamada ? null : utiles[0]);
  return { para, asunto, cuerpo: elegido ? de(elegido) : '' };
}

/** Lo que se rellena al pulsar «Enviar» en una tarjeta, venga de donde venga. */
export async function borradorDeTarjeta(id) {
  const ap = (await q(`SELECT * FROM aprobaciones WHERE id=$1 AND estado='pendiente'`, [id])).rows[0];
  if (!ap) return null;
  const emp = ap.empresa_id ? await empresas.leer(ap.empresa_id) : null;
  const [rt, rid] = String(ap.ref || '').split(':');
  const res = { para: '', asunto: '', texto: '', formato: 'diseno', cuenta: cuentas.predeterminada()?.id || null, adjunto: null };
  if (rt === 'correo') {
    const b = (await q(`SELECT * FROM correos WHERE id=$1 AND direccion='borrador'`, [Number(rid)])).rows[0];
    if (b) Object.assign(res, { para: b.para, asunto: b.asunto, texto: b.texto, formato: b.formato || 'diseno', cuenta: b.cuenta || res.cuenta, adjunto: b.adjunto });
  } else {
    const partes = partirTarjeta(ap.texto);
    // De un primer contacto se manda el mensaje, no el guion de la llamada que va en la misma tarjeta
    const paso = rt === 'paso' ? (await q(`SELECT asunto, texto FROM pasos WHERE id=$1 AND canal <> 'telefono'`, [Number(rid)])).rows[0]
      : rt === 'sec' ? (await q(`SELECT asunto, texto FROM pasos WHERE secuencia_id=$1 AND canal <> 'telefono' ORDER BY orden LIMIT 1`, [Number(rid)])).rows[0] : null;
    const documento = ap.tipo === 'propuesta' || ap.documento;
    const pila = String(emp?.decisor || '').trim().split(/\s+/)[0];
    Object.assign(res, { para: partes.para, asunto: paso?.asunto || partes.asunto, texto: documento ? textoDelDocumento(pila) : paso?.texto || partes.cuerpo || `Hola${pila ? ' ' + pila : ''}:\n\n`, adjunto: documento ? id : null });
    if (documento && !res.asunto) res.asunto = `Lo que hemos visto de ${emp?.nombre || 'vuestro negocio'}`;
  }
  return completarBorrador(res, ap, emp);
}
const textoDelDocumento = pila => `Hola${pila ? ' ' + pila : ''}:\n\nTe mando en una página lo que hemos visto de vuestro negocio.\n\n¿Te viene bien que lo comentemos 15 minutos esta semana?`;
async function completarBorrador(res, ap, emp) {
  // A quién: lo que dice la tarjeta manda; luego la persona de contacto y, por último, el correo general de la ficha. Dirección ve todas y elige
  const gente = emp ? await (await import('./contactos.js')).deEmpresa(emp.id) : [];
  const propias = new Set(cuentas.listar().map(c => c.direccion));
  res.direcciones = [...new Set([res.para, ...(String(ap.texto || '').match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/gi) || []), ...gente.map(c => c.email), emp?.email].filter(Boolean).map(limpiarDir))].filter(d => !propias.has(d));
  if (!res.para) res.para = res.direcciones[0] || '';
  if (!res.asunto && emp) res.asunto = `${cuentas.predeterminada()?.nombre || config.correo.nombre} · ${emp.nombre}`;
  const adjunto = res.adjunto ? await (await import('./documento.js')).deAprobacion(res.adjunto) : null;
  return { ...res, adjunto_nombre: adjunto?.nombre || null, cuentas: cuentas.listar() };
}

/** «Enviar» desde cualquier tarjeta: sale por la cuenta elegida y la tarjeta se da por hecha. Si no se puede enviar, sigue en la mesa y se dice por qué. */
const documentoDe = async id => (await q(`SELECT * FROM aprobaciones WHERE id=$1 AND (documento IS NOT NULL OR tipo='propuesta')`, [id])).rows[0];
/** El PDF de una empresa se puede mandar en cualquier momento, aunque su tarjeta ya se resolviera. La tarjeta no se toca. */
export async function borradorDeDocumento(id) {
  const ap = await documentoDe(id);
  if (!ap) return null;
  const emp = ap.empresa_id ? await empresas.leer(ap.empresa_id) : null;
  return completarBorrador({ para: '', asunto: `Lo que hemos visto de ${emp?.nombre || 'vuestro negocio'}`, texto: textoDelDocumento(String(emp?.decisor || '').trim().split(/\s+/)[0]), formato: 'diseno', cuenta: cuentas.predeterminada()?.id || null, adjunto: id }, ap, emp);
}
export async function enviarDocumento(id, { para, asunto, texto, formato, cuenta } = {}) {
  const ap = await documentoDe(id);
  if (!ap) throw new Error('Ese documento ya no existe.');
  if (!activo()) throw new Error('No hay ninguna cuenta de correo conectada: añádela en Configuración › Conexiones.');
  const dir = limpiarDir(para), asu = String(asunto || '').trim().slice(0, 200), cuerpo = String(texto || '').trim();
  if (!dir || !asu || !cuerpo) throw new Error('El correo necesita dirección, asunto y texto.');
  const fmt = formato === 'texto' ? 'texto' : 'diseno', cta = cuentas.elegir(cuenta)?.id;
  const nuevo = (await q(`INSERT INTO correos (direccion, de, para, asunto, texto, empresa_id, adjunto, formato, cuenta) VALUES ('borrador',$1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [cuentas.elegir(cuenta).direccion, dir, asu, cuerpo, ap.empresa_id, id, fmt, cta])).rows[0].id;
  try { await enviarBorrador(nuevo); }
  catch (e) { await q(`UPDATE correos SET direccion='descartado' WHERE id=$1`, [nuevo]); await log('sistema', `no ha podido enviar el PDF a ${dir}. ${e.message}`, { empresa_id: ap.empresa_id || undefined }); throw e; }
}
export async function enviarDesdeTarjeta(id, { para, asunto, texto, formato, cuenta, cerrar = false } = {}) {
  const ap = (await q(`SELECT * FROM aprobaciones WHERE id=$1 AND estado='pendiente'`, [id])).rows[0];
  if (!ap) throw new Error('Esa tarjeta ya no está en la mesa.');
  if (!activo()) throw new Error('No hay ninguna cuenta de correo conectada: añádela en Configuración › Conexiones.');
  const dir = limpiarDir(para), asu = String(asunto || '').trim().slice(0, 200), cuerpo = String(texto || '').trim();
  if (!dir || !asu || !cuerpo) throw new Error('El correo necesita dirección, asunto y texto.');
  const fmt = formato === 'texto' ? 'texto' : 'diseno', cta = cuentas.elegir(cuenta)?.id;
  const [rt, rid] = String(ap.ref || '').split(':');
  if (rt === 'correo') {
    await q(`UPDATE correos SET para=$2, asunto=$3, texto=$4, formato=$5, cuenta=$6 WHERE id=$1 AND direccion='borrador'`, [Number(rid), dir, asu, cuerpo, fmt, cta]);
    const hecha = await aprobaciones.resolver(id, 'enviar');
    await limpiarTrasEnviar(ap);
    return hecha;
  }
  const adjunto = ap.tipo === 'propuesta' || ap.documento ? id : null;
  const nuevo = (await q(`INSERT INTO correos (direccion, de, para, asunto, texto, empresa_id, adjunto, formato, cuenta) VALUES ('borrador',$1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [cuentas.elegir(cuenta).direccion, dir, asu, cuerpo, ap.empresa_id, adjunto, fmt, cta])).rows[0].id;
  try { await enviarBorrador(nuevo); }
  catch (e) { await q(`UPDATE correos SET direccion='descartado' WHERE id=$1`, [nuevo]); await log('sistema', `no ha podido enviar el correo a ${dir}. ${e.message}`, { empresa_id: ap.empresa_id || undefined }); throw e; }
  // Ya ha salido: la tarjeta se va siempre. Si es un paso de una secuencia, esta sigue su curso
  // «Correo y cerrar»: se le escribe y no se insiste más
  const hecho = cerrar && ap.opciones?.some(o => o.r === 'descartada') ? 'descartada' : ap.opciones ? ap.opciones.find(o => ['hecho', 'aprobada'].includes(o.r))?.r : 'aprobada';
  if (hecho) { const hecha = await aprobaciones.resolver(id, hecho); if (!['paso', 'ctl', 'sec'].includes(rt)) await limpiarTrasEnviar(ap); return hecha; }
  const hecha = await aprobaciones.darPorHecha(id);
  await limpiarTrasEnviar(ap);
  return hecha;
}

/** Lo que estaba preparado antes para esta empresa ya no vale: se le acaba de escribir. */
async function limpiarTrasEnviar(ap) {
  if (ap.empresa_id) await (await import('./mesaViva.js')).ocurrio(ap.empresa_id, { que: 'tu correo', excepto: ap.id });
}

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
  if (!dirValida(limpiarDir(b.para))) throw new Error('La dirección no es válida.');
  const c = cuentas.elegir(b.cuenta);
  if (!c) throw new Error('No hay ninguna cuenta de correo conectada: añádela en Configuración › Conexiones.');
  const conDiseno = PRO.correoDiseno && b.formato !== 'texto', logoAdjunto = (await import('./documento.js')).logoBuffer();
  const info = await mandar(c, {
    to: b.para, subject: b.asunto, text: `${b.texto}\n\n${firma(c)}`,
    ...(conDiseno ? { html: M.correoDiseno.html({ texto: b.texto, firma: firma(c), logo: logoAdjunto ? `cid:${CID_LOGO}` : '' }) } : {}),
    attachments: [...await adjuntos(b), ...(conDiseno && logoAdjunto ? [{ filename: 'logo.jpg', content: logoAdjunto, cid: CID_LOGO }] : [])],
    ...(b.en_respuesta_a ? { inReplyTo: b.en_respuesta_a, references: [b.en_respuesta_a] } : {}),
  });
  await q(`UPDATE correos SET direccion='salida', de=$3, message_id=$2, enviado=now() WHERE id=$1`, [id, info.messageId || null, c.direccion]);
  if (emp) await empresas.actualizar(emp.id, { ultimo_contacto: new Date().toISOString().slice(0, 10), estado: 'contactada' }, { desdeAgente: true });   // el estado solo avanza, nunca retrocede
  await log('dueno', `ha enviado un correo a ${b.para}: «${b.asunto}»`, { empresa_id: b.empresa_id });
  return info.messageId;
}

/** Un correo que ha llegado: lo guarda, lo clasifica y avisa si es de un lead. Devuelve el id o null si ya estaba. */
export async function procesarEntrante(m, cuenta = null) {
  if (PRO.vigilante && String(m.subject || '').startsWith(M.vigilante.PRUEBA_CORREO)) { await M.vigilante.correoRecibido(m.subject); return null; }   // la prueba del día: ha vuelto
  const de = limpiarDir(m.from?.value?.[0]?.address);
  const nombre = m.from?.value?.[0]?.name || de;
  const mid = m.messageId || `${de}-${m.date?.toISOString?.() || Date.now()}`;
  if ((await q(`SELECT 1 FROM correos WHERE message_id=$1`, [mid])).rows.length) return null;
  const texto = String(m.text || '').replace(/\r/g, '').slice(0, 20000);
  // Avisos de LinkedIn (reenviados por Dirección): se leen aparte y nunca se tratan como un lead que escribe
  const avisos = await import('./avisosLinkedin.js');
  if (avisos.esAviso(m)) {
    const r = await q(`INSERT INTO correos (direccion, de, para, asunto, texto, message_id, clase, creada) VALUES ('entrada',$1,$2,$3,$4,$5,'linkedin',coalesce($6, now())) RETURNING id`,
      [de, cuenta?.direccion || config.correo.usuario, String(m.subject || '').slice(0, 300), texto, mid, m.date || null]);
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
  // Avisos automáticos (no-reply, la centralita…): nadie los contesta; lo demás de un desconocido lo revisa Paula
  const automatico = /^(no-?reply|noreply|mailer-daemon|postmaster|notifica|notification|bounce|alert)/i.test(de) || /@zadarma\./i.test(de) || cab.has?.('auto-submitted') && cab.get('auto-submitted') !== 'no';
  const clase = emp ? 'lead' : esBoletin ? 'boletin' : automatico ? 'aviso' : 'otro';
  if (emp) await (await import('./mesaViva.js')).ocurrio(emp.id, { cuando: new Date(), que: 'su correo' });
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
  } else if (clase === 'otro') {   // alguien que no tenemos: puede ser un cliente nuevo, así que Paula lo mira
    await log('sistema', `ha llegado un correo de ${nombre}: «${String(m.subject || '').slice(0, 120)}» (no es de ninguna empresa nuestra; lo revisa Paula)`);
    await tareas.crear('paula', `Ha llegado un correo de alguien que no tenemos en la oficina: ${nombre} <${de}>.\nAsunto: «${m.subject || ''}»\n\n${texto.slice(0, 6000)}\n\n` +
      `Decide qué es. Si es un posible cliente o alguien que nos pide algo: créalo con guardar_empresas (origen «otro», con su correo) y prepara la respuesta con preparar_correo (en_respuesta_a: ${id}, empresa_id: el de la empresa creada). ` +
      `Si es publicidad, spam, un aviso o no pide nada: déjalo dicho con anotar en una línea y no hagas nada más.`, { origen: 'sistema' });
  }
  return id;
}

let leyendo = false, ultimaLectura = 0;
/** Lee lo nuevo del buzón (como mucho cada 5 minutos). */
export async function revisarBuzon({ forzar = false } = {}) {
  if (!activo() || process.env.CORREO_SIMULADO || leyendo) return 0;
  if (!forzar && Date.now() - ultimaLectura < 5 * 60_000) return 0;
  leyendo = true; ultimaLectura = Date.now();
  let n = 0;
  try {
    for (const c of cuentas.queLeen()) {
      const [host, puerto] = String(c.imap).split(':');
      const cliente = new ImapFlow({ host, port: Number(puerto || 993), secure: true, auth: { user: c.direccion, pass: c.clave }, logger: false });
      try {
        await cliente.connect();
        const cerrojo = await cliente.getMailboxLock('INBOX');
        try {
          const nuevos = await cliente.search({ seen: false });
          for (const uid of (nuevos || []).slice(0, 30)) {
            const msg = await cliente.fetchOne(uid, { source: true });
            if (!msg?.source) continue;
            if (await procesarEntrante(await simpleParser(msg.source), c)) n++;
            await cliente.messageFlagsAdd(uid, ['\\Seen']);
          }
        } finally { cerrojo.release(); }
        await cliente.logout();
      } catch (e) { console.error(`Correo (IMAP, ${c.direccion}):`, e.message); }
    }
  } finally { leyendo = false; }
  return n;
}

/** Para Sara: los boletines de los últimos días. */
export async function boletines(dias = 7, limite = 15) {
  const r = await q(`SELECT de, asunto, left(texto, 1500) AS texto, creada FROM correos WHERE direccion='entrada' AND clase='boletin'
                      AND creada > now() - ($1 || ' days')::interval ORDER BY creada DESC LIMIT $2`, [String(dias), limite]);
  return r.rows;
}

/** La bandeja del panel: lo que ha llegado (y lo que se ha enviado) con lo que ha hecho la oficina con cada uno. */
export async function bandeja(limite = 60) {
  return (await q(`SELECT c.id, c.direccion, c.de, c.para, c.asunto, left(c.texto, 4000) AS texto, c.clase, c.empresa_id, e.nombre AS empresa,
                          coalesce(c.enviado, c.creada) AS fecha
                     FROM correos c LEFT JOIN empresas e ON e.id = c.empresa_id
                    WHERE c.direccion IN ('entrada', 'salida') ORDER BY coalesce(c.enviado, c.creada) DESC LIMIT $1`, [limite])).rows;
}

export async function deEmpresa(empresaId) {
  return (await q(`SELECT id, direccion, de, para, asunto, adjunto, left(texto, 4000) AS texto, coalesce(enviado, creada) AS fecha FROM correos
                    WHERE empresa_id=$1 AND direccion <> 'borrador' ORDER BY coalesce(enviado, creada)`, [empresaId])).rows;
}

export const nombreAgente = id => AGENTES[id]?.nombre ?? id;
