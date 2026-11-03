// Contactos que llegan solos: el formulario de la web (diagnóstico gratis, calculadora o contacto).
// Quien rellena el formulario nos da su consentimiento: se le puede contestar por correo (no es «en frío»).
// Llega → empresa en «conversación» con su origen → aviso a Dirección → Nuria (diagnóstico) o Paula (contacto) preparan la respuesta.
import crypto from 'node:crypto';
import { q } from './db.js';
import { log } from './bus.js';
import * as empresas from './empresas.js';
import * as miEmpresa from './empresa.js';
import { config } from './config.js';
import * as tareas from './tareas.js';
import * as departamentos from './departamentos.js';
import * as telegram from './telegram.js';

export const TIPOS = ['contacto', 'diagnostico', 'calculadora', 'oficina'];   // oficina = lista de interesados, los que reciben el boletín (no entra en el embudo)
const ORIGEN_WEB = ['web', 'google', 'anuncio', 'redes', 'linkedin', 'gestoria', 'evento', 'recomendacion'];
const GENERICOS = /@(gmail|hotmail|outlook|yahoo|icloud|live|msn|me|protonmail)\./i;
const intentos = new Map();   // huella de IP → [instantes]

const texto = (v, n = 300) => (v == null ? '' : String(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n));
const huella = ip => crypto.createHash('sha256').update('acp:' + String(ip || '')).digest('hex').slice(0, 16);

/** Demasiados envíos desde la misma conexión: 5 por hora. */
function frenar(ip) {
  const h = huella(ip), ahora = Date.now();
  const lista = (intentos.get(h) || []).filter(t => ahora - t < 3_600_000);
  lista.push(ahora); intentos.set(h, lista);
  return lista.length > 5;
}

function limpiarDatos(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const j = JSON.stringify(x, (k, v) => typeof v === 'string' ? v.slice(0, 300) : v);
  return j.length <= 4000 ? JSON.parse(j) : null;
}

/** Valida lo que llega del formulario. Devuelve { ok, error?, datos? } */
export function validar(b = {}) {
  const d = {
    tipo: TIPOS.includes(b.tipo) ? b.tipo : 'contacto',
    nombre: texto(b.nombre, 80), empresa: texto(b.empresa, 120), email: texto(b.email, 120).toLowerCase(),
    telefono: texto(b.telefono, 30), sector: texto(b.sector, 80), mensaje: texto(b.mensaje, 3000),
    pagina: texto(b.pagina, 200), origen: ORIGEN_WEB.includes(b.origen) ? b.origen : 'web',
    datos: limpiarDatos(b.datos),
    consentimiento: b.consentimiento === true || b.consentimiento === 'true' || b.consentimiento === 'on',
  };
  if (d.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.email)) return { ok: false, error: 'Revisa el correo electrónico.' };
  if (!d.email && !d.telefono) return { ok: false, error: 'Déjanos un correo o un teléfono para poder contestarte.' };
  if (!d.nombre) return { ok: false, error: 'Dinos tu nombre.' };
  if (!d.consentimiento) return { ok: false, error: 'Necesitamos tu permiso para contestarte.' };
  return { ok: true, datos: d };
}

/** Busca la empresa por nombre o por el dominio del correo; si no existe, la crea. */
async function empresaDe(d) {
  const nombre = d.empresa || (d.email && !GENERICOS.test(d.email) ? d.email.split('@')[1].split('.')[0] : '') || `${d.nombre} (particular)`;
  const dom = d.email && !GENERICOS.test(d.email) ? d.email.split('@')[1] : null;
  const norm = empresas.normalizar(nombre);
  const ya = (await q(`SELECT * FROM empresas WHERE nombre_norm=$1 ${dom ? 'OR lower(web)=$2 OR lower(email) LIKE $3' : ''} LIMIT 1`, dom ? [norm, dom, `%@${dom}`] : [norm])).rows[0];
  if (ya) return { emp: ya, nueva: false };
  const r = await empresas.crear([{ nombre, web: dom, sector: d.sector || null, email: d.email || null, telefono: d.telefono || null,
    decisor: d.nombre, fuente: `Formulario de ${miEmpresa.web() || 'la web'}${d.pagina ? ' (' + d.pagina + ')' : ''}`, origen: d.origen, origen_detalle: d.pagina || d.tipo }]);
  return { emp: await empresas.leer(r.creadas[0].id), nueva: true };
}

const resumenCalculadora = x => {
  if (!x) return '';
  const partes = [];
  if (x.horas_semana) partes.push(`${x.horas_semana} h/semana en tareas repetitivas`);
  if (x.coste_anual) partes.push(`≈ ${Number(x.coste_anual).toLocaleString('es-ES')} €/año`);
  if (x.tareas) partes.push(`tareas: ${[].concat(x.tareas).join(', ')}`);
  return partes.join(' · ');
};

/** Recibe un envío del formulario. */
export async function recibir(b, ip) {
  if (b?.sitio_web) return { ok: true };                 // trampa para robots: se ignora sin decir nada
  if (frenar(ip)) return { ok: false, codigo: 429, error: `Has enviado varios formularios seguidos. Prueba dentro de un rato${config.empresa.correoContacto ? ` o escríbenos a ${config.empresa.correoContacto}` : ''}.` };
  const v = validar(b);
  if (!v.ok) return { ok: false, codigo: 400, error: v.error };
  const d = v.datos;
  const { emp, nueva } = await empresaDe(d);
  // Lista de espera de la oficina de agentes: se apunta y se te avisa; nadie le escribe ni entra en el embudo hasta que tú lo decidas
  if (d.tipo === 'oficina') {
    const campos = {};
    if (!emp.email && d.email) campos.email = d.email;
    if (!emp.telefono && d.telefono) campos.telefono = d.telefono;
    if (!emp.decisor) campos.decisor = d.nombre;
    if (Object.keys(campos).length) await empresas.actualizar(emp.id, campos);
    const r = await q(`INSERT INTO entradas (empresa_id, tipo, nombre, empresa, email, telefono, sector, mensaje, datos, pagina, origen, consentimiento, ip_hash)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [emp.id, d.tipo, d.nombre, d.empresa || null, d.email || null, d.telefono || null, d.sector || null, d.mensaje || null, d.datos, d.pagina || null, d.origen, d.consentimiento, huella(ip)]);
    const x = d.datos || {}, detalle = [x.opcion && `opción: ${x.opcion}`, x.departamentos && `departamentos: ${[].concat(x.departamentos).join(', ')}`].filter(Boolean).join(' · ');
    await telegram.avisar(`📝 Lista de interesados: ${d.nombre}${d.empresa ? ` · ${d.empresa}` : ''}${d.sector ? ` · ${d.sector}` : ''}\n${d.email ? `📧 ${d.email}\n` : ''}${d.telefono ? `📞 ${d.telefono}\n` : ''}${detalle ? detalle + '\n' : ''}${d.mensaje ? `💬 «${d.mensaje.slice(0, 400)}»\n` : ''}Está en la ficha de la empresa; nadie le escribe hasta que tú lo digas.`);
    await log('sistema', `ha apuntado a ${d.nombre}${d.empresa ? ` (${d.empresa})` : ''} en la lista de interesados${detalle ? ` (${detalle})` : ''}.`, { empresa_id: emp.id });
    return { ok: true, id: r.rows[0].id };
  }
  const campos = { estado: 'conversacion', ultimo_contacto: new Date().toISOString().slice(0, 10) };
  if (!emp.email && d.email) campos.email = d.email;
  if (!emp.telefono && d.telefono) campos.telefono = d.telefono;
  if (!emp.decisor) campos.decisor = d.nombre;
  if (!nueva && emp.origen === 'busqueda') campos.origen_detalle = `${emp.origen_detalle ? emp.origen_detalle + ' · ' : ''}también llegó por la web`;
  const e = await empresas.actualizar(emp.id, campos);
  const r = await q(`INSERT INTO entradas (empresa_id, tipo, nombre, empresa, email, telefono, sector, mensaje, datos, pagina, origen, consentimiento, ip_hash)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [e.id, d.tipo, d.nombre, d.empresa || null, d.email || null, d.telefono || null, d.sector || null, d.mensaje || null, d.datos, d.pagina || null, d.origen, d.consentimiento, huella(ip)]);
  const calc = resumenCalculadora(d.datos);
  const QUE = { diagnostico: 'pide el diagnóstico gratis', calculadora: 'ha usado la calculadora de horas', contacto: 'nos escribe' };
  const ficha = [`👤 ${d.nombre}${d.empresa ? ` · ${d.empresa}` : ''}${d.sector ? ` · ${d.sector}` : ''}`,
    d.email && `📧 ${d.email}`, d.telefono && `📞 ${d.telefono}`, calc && `⏱ ${calc}`, d.mensaje && `💬 «${d.mensaje.slice(0, 600)}»`].filter(Boolean).join('\n');
  await telegram.avisar(`🔔 Contacto nuevo desde la web: ${QUE[d.tipo]}\n\n${ficha}\n\n${d.tipo === 'diagnostico' ? 'Nuria prepara el diagnóstico y el correo; te lo deja en la mesa.' : 'Paula te prepara la respuesta y te la deja en la mesa.'}`);
  await log('sistema', `ha recibido un contacto desde la web: ${d.nombre}${d.empresa ? ` (${d.empresa})` : ''} ${QUE[d.tipo]}.`, { empresa_id: e.id });

  const contexto = `Datos del formulario (entrada ${r.rows[0].id}):\n${ficha}${d.datos ? `\nRespuestas: ${JSON.stringify(d.datos)}` : ''}\nPágina: ${d.pagina || '—'} · Origen: ${d.origen}\nHa dado su consentimiento para que le contestemos.`;
  const canalRespuesta = d.email
    ? `Contesta por correo con preparar_correo (para: ${d.email}, empresa_id ${e.id}).`
    : `No ha dejado correo: prepara con pedir_aprobacion (tipo 'respuesta') el guion de la llamada al ${d.telefono}.`;
  if (d.tipo === 'diagnostico' || d.tipo === 'calculadora') {
    await tareas.crear('nuria', `Ha llegado una petición de diagnóstico gratis desde la web de ${d.nombre}${d.empresa ? ` (${d.empresa})` : ''}. Es un contacto caliente: hazlo hoy.
Prepara el diagnóstico de una página según tu plantilla (si tiene web, léela primero) y ${canalRespuesta} El correo lleva el diagnóstico en el cuerpo y propone una llamada de 15 minutos.\n\n${contexto}`, { empresa_id: e.id, origen: 'web' });
  } else {
    await tareas.crear('paula', `Ha llegado un contacto desde la web de ${d.nombre}${d.empresa ? ` (${d.empresa})` : ''}. Es un contacto caliente: contesta hoy.
${canalRespuesta} Responde a lo que pregunta y propone una llamada de 15 minutos. Actualiza la empresa con proximo_paso y fecha.\n\n${contexto}`, { empresa_id: e.id, origen: 'web' });
  }
  if (nueva && departamentos.trabaja('mateo')) await tareas.crear('mateo', `Puntúa la empresa ${e.nombre} (id ${e.id}). Nos ha escrito por la web: averigua lo que puedas para la llamada.`, { empresa_id: e.id, origen: 'web', animar: false });
  return { ok: true, id: r.rows[0].id };
}

export async function recientes(limite = 20) {
  return (await q(`SELECT id, empresa_id, tipo, nombre, empresa, email, telefono, sector, left(coalesce(mensaje,''),300) AS mensaje, datos, pagina, origen, creada FROM entradas ORDER BY id DESC LIMIT $1`, [limite])).rows;
}
