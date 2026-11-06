// Secuencias de contacto. Javi prepara SOLO el primer contacto: notas, solicitud de conexión y, si hay
// teléfono, el guion de la llamada del día siguiente (no se espera a que acepte: la solicitud solo abre
// la puerta; el correo llega después de la llamada, si en ella acepta recibirlo, que es cuando es legal).
// Los mensajes siguientes se escriben cuando hacen falta: el mensaje 1 cuando Dirección confirma que ha
// aceptado, y cada seguimiento cuando llega su fecha sin respuesta. Así no se escribe nada que no
// se vaya a usar y cada texto sale con lo último que sabemos. Paula lleva las fechas (sin gastar IA).
import { q } from './db.js';
import { log, emitir } from './bus.js';
import * as empresas from './empresas.js';
import * as miEmpresa from './empresa.js';
import * as aprobaciones from './aprobaciones.js';
import * as tareas from './tareas.js';

const ZONA = 'Europe/Madrid';
export const hoy = () => new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export function sumarDias(n, desde = hoy()) {
  const d = new Date(desde + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
const fechaBonita = f => f ? new Date(String(f).slice(0, 10) + 'T12:00:00Z').toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }) : '';

// Valores por defecto de cada paso (Javi puede cambiar los días)
const TIPOS = {
  conexion:     { titulo: 'Solicitud de conexión', canal: 'linkedin', dias: 0 },
  mensaje1:     { titulo: 'Mensaje 1', canal: 'linkedin', dias: 0, tras_aceptar: true },
  seguimiento1: { titulo: 'Seguimiento 1', canal: 'linkedin', dias: 5 },
  seguimiento2: { titulo: 'Seguimiento 2', canal: 'linkedin', dias: 5 },
  llamada:      { titulo: 'Llamada', canal: 'telefono', dias: 1 },      // al día siguiente de la solicitud, sin esperar a que acepte
  carta:        { titulo: 'Carta', canal: 'carta', dias: 0 },           // no es un medio electrónico: vale en frío
  visita:       { titulo: 'Visita', canal: 'visita', dias: 0 },
  presentacion: { titulo: 'Pedir presentación', canal: 'presentacion', alternativo: true },
  otro:         { titulo: 'Paso', canal: 'linkedin', dias: 3 },
};
export const CLAVES = Object.keys(TIPOS);
const SIN_CARTAS = 'Las cartas en papel no se usan. Usa LinkedIn, teléfono o correo.';
const ORDEN = ['conexion', 'mensaje1', 'seguimiento1', 'seguimiento2', 'otro', 'carta', 'visita', 'llamada', 'presentacion'];
const DIAS_ACEPTACION = [3, 4];      // te pregunta si ha aceptado a los 3 días y otra vez a los 4 siguientes
const DIAS_CIERRE = 7;               // tras el último seguimiento, espera una semana antes de darlo por frío
// Lo que viene después de cada paso si aún no está escrito: Javi lo redacta cuando toca
const DESPUES = { mensaje1: 'seguimiento1', seguimiento1: 'seguimiento2' };
const ANTELACION = 1;                // Javi lo escribe un día antes de que toque, para que llegue a tiempo

const OK = { linkedin: '✅ Lo he enviado', telefono: '📞 Ya he llamado', visita: '🚶 Ya he ido', carta: '📮 La he enviado', email: '✅ Lo he enviado', whatsapp: '✅ Lo he enviado', presentacion: '✅ La he pedido' };
const RESPONDIDO = { r: 'respondido', t: '💬 Ha respondido', texto: 'Pega lo que te ha dicho (o un resumen) y Paula te prepara la contestación.' };

async function leerSec(id) { return (await q('SELECT * FROM secuencias WHERE id=$1', [id])).rows[0] || null; }
async function pasosDe(secId) { return (await q('SELECT * FROM pasos WHERE secuencia_id=$1 ORDER BY orden', [secId])).rows; }
const quien = (sec, emp) => sec.decisor || emp?.decisor || 'la gerencia';
// ¿Es la misma persona? Se comparan las dos primeras palabras del nombre: «Ana Pérez» = «Ana Pérez (gerente)»
const nombreCorto = t => empresas.normalizar(String(t || '').split('(')[0]).split(/\s+/).slice(0, 2).join(' ');
const mismaPersona = (a, b) => Boolean(nombreCorto(a)) && nombreCorto(a) === nombreCorto(b);
// El LinkedIn de la ficha es el de su decisor: solo vale para la secuencia si va dirigida a esa persona
export const perfilDe = (sec, emp) => sec.linkedin_url || (!sec.decisor || mismaPersona(sec.decisor, emp.decisor) ? emp.linkedin_url : null);

/** Asunto corto por si LinkedIn lo pide. */
function asuntoPorDefecto(clave, emp) {
  const n = String(emp?.nombre || '').replace(/\s*\(.*$/, '').replace(/\s+(S\.?L\.?U?|S\.?A\.?)\.?$/i, '').trim();
  return ({ conexion: `Hola desde ${miEmpresa.nombre()}`, mensaje1: `Una idea para ${n}`, seguimiento1: `Sobre ${n}`, seguimiento2: `Último mensaje sobre ${n}` }[clave] || `Para ${n}`).slice(0, 80);
}

/** Javi guarda el primer contacto: queda como borrador y llega a tu mesa para que lo revises. */
export async function guardar({ autor, empresa_id, decisor, linkedin_url, notas, pasos, caduca = null }) {
  const emp = await empresas.leer(empresa_id);
  if (!emp) throw new Error(`No existe la empresa ${empresa_id}`);
  const limpios = (pasos || []).filter(p => p && String(p.texto || '').trim()).map(p => {
    const clave = CLAVES.includes(p.clave) ? p.clave : 'otro';
    const def = TIPOS[clave];
    const canal = p.canal || def.canal;
    // LinkedIn a veces pide asunto (InMail o mensaje a quien aún no es contacto): siempre lo dejamos preparado
    const asunto = canal === 'linkedin' ? (String(p.asunto || '').trim().slice(0, 80) || asuntoPorDefecto(clave, emp)) : null;
    return { clave, canal, asunto, titulo: p.titulo || def.titulo, texto: String(p.texto).trim(),
      dias: Number.isFinite(Number(p.dias)) ? Math.max(0, Math.min(60, Number(p.dias))) : (def.dias ?? 0),
      tras_aceptar: Boolean(def.tras_aceptar), alternativo: Boolean(def.alternativo) };
  });
  if (!limpios.length) throw new Error('La secuencia necesita al menos un paso con texto.');
  const EN_CONVERSACION = ['conversacion', 'reunion', 'propuesta', 'ganada'];
  const frio = limpios.filter(p => p.canal === 'whatsapp');   // el correo lo decide Dirección al pulsar «Enviar»
  if (limpios.some(p => p.canal === 'carta')) throw new Error(SIN_CARTAS);
  if (frio.length && !EN_CONVERSACION.includes(emp.estado)) {
    throw new Error('No se puede usar WhatsApp en frío (LSSI art. 21). Usa LinkedIn, teléfono, correo o presentación por un contacto.');
  }
  limpios.sort((a, b) => ORDEN.indexOf(a.clave) - ORDEN.indexOf(b.clave));
  // Solo el primer contacto (y la llamada del día siguiente, si la hay): lo demás se escribe cuando sepamos si contesta.
  // Si no hay LinkedIn (todo son planes B), el primero pasa a ser el principal.
  const principal = limpios.find(p => !p.alternativo) || { ...limpios[0], alternativo: false };
  const llamada = limpios.find(p => p.clave === 'llamada' && p !== principal);
  limpios.length = 0; limpios.push(principal, ...(llamada ? [llamada] : []));

  // Una versión nueva sustituye a la anterior que aún no habías empezado
  const viejas = (await q(`UPDATE secuencias SET estado='descartada', actualizada=now() WHERE empresa_id=$1 AND estado='borrador' RETURNING id`, [emp.id])).rows;
  // Lo que dejaste para más tarde sigue para más tarde, aunque se reescriba
  const pospuesta = viejas.length ? (await q(`SELECT max(pospuesta) AS p FROM aprobaciones WHERE estado='pendiente' AND ref = ANY($1)`, [viejas.map(v => `sec:${v.id}`)])).rows[0].p : null;
  for (const v of viejas) await aprobaciones.sustituir(`sec:${v.id}`);   // su aviso sale de tu mesa
  const sec = (await q(`INSERT INTO secuencias (empresa_id, autor, decisor, linkedin_url, notas) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [emp.id, autor, decisor || emp.decisor || null, linkedin_url || null, notas || null])).rows[0];
  for (const [i, p] of limpios.entries()) {
    await q(`INSERT INTO pasos (secuencia_id, orden, clave, canal, titulo, texto, dias, tras_aceptar, alternativo, asunto) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [sec.id, i + 1, p.clave, p.canal, p.titulo, p.texto, p.dias, p.tras_aceptar, p.alternativo, p.asunto]);
  }
  const campos = {};
  if (decisor && !emp.decisor) campos.decisor = decisor;
  // A la ficha solo va el enlace de su decisor: el de otra persona (una puerta de entrada) se queda en la secuencia
  if (linkedin_url && /^https?:\/\/([a-z]+\.)?linkedin\.com\//i.test(linkedin_url) && (!emp.decisor || !decisor || mismaPersona(decisor, emp.decisor))) campos.linkedin_url = linkedin_url;
  if (Object.keys(campos).length) await empresas.actualizar(emp.id, campos);

  const primero = limpios.find(p => !p.alternativo);
  const id = await aprobaciones.crear({
    agente: autor, tipo: 'mensaje', empresa_id: emp.id, ref: `sec:${sec.id}`, caduca,
    titulo: `ha preparado ${emp.interes || ['conversacion', 'reunion', 'propuesta', 'cliente'].includes(emp.estado) ? 'la llamada' : 'el primer contacto'} para ${quien(sec, emp)} (${emp.nombre})`,
    texto: await textoSecuencia(sec.id),
    opciones: [{ r: 'aprobada', t: primero.clave === 'conexion' ? '✅ He enviado la conexión' : (OK[primero.canal] || '✅ Hecho') + ` (${primero.titulo.toLowerCase()})` }, { r: 'cambios' }, { r: 'descartada', t: '✖ Esta empresa no' }],
  });
  if (pospuesta) { await q(`UPDATE aprobaciones SET pospuesta=$2 WHERE id=$1`, [id, pospuesta]); await emitir({ tipo: 'mesa_cambiada' }); }
  return { secuencia: sec.id, aprobacion: id, pasos: limpios.length };
}

/** Las secuencias que se escribieron enteras antes del cambio se quedan solo con el primer contacto. */
export async function recortarBorradores() {
  // Las de LinkedIn sin asunto (de antes del cambio) lo reciben por defecto
  const sinAsunto = (await q(`SELECT p.id, p.clave, s.id sec, s.empresa_id FROM pasos p JOIN secuencias s ON s.id=p.secuencia_id
                              WHERE s.estado IN ('borrador','activa') AND p.canal='linkedin' AND p.asunto IS NULL AND p.estado IN ('pendiente','programado','en_mesa')`)).rows;
  for (const p of sinAsunto) await q(`UPDATE pasos SET asunto=$2 WHERE id=$1`, [p.id, asuntoPorDefecto(p.clave, await empresas.leer(p.empresa_id))]);
  const tocadas = new Set(sinAsunto.map(p => p.sec));
  const secs = (await q(`SELECT s.id FROM secuencias s WHERE s.estado='borrador' AND ((SELECT count(*) FROM pasos p WHERE p.secuencia_id=s.id) > 1 OR s.id = ANY($1::int[]))`, [[...tocadas]])).rows;
  for (const { id } of secs) {
    const ps = await pasosDe(id);
    const primero = ps.find(p => !p.alternativo) || ps[0];
    if (ps.length > 1) await q(`DELETE FROM pasos WHERE secuencia_id=$1 AND id<>$2`, [id, primero.id]);
    await q(`UPDATE pasos SET alternativo=false, orden=1 WHERE id=$1`, [primero.id]);
    await q(`UPDATE aprobaciones SET texto=$2, titulo=replace(titulo, 'la secuencia de contacto', 'el primer contacto') WHERE ref=$1 AND estado='pendiente'`, [`sec:${id}`, await textoSecuencia(id)]);
  }
  return secs.length;
}

/** Texto completo de la secuencia, tal como lo ves en tu mesa y en Telegram. */
export async function textoSecuencia(secId) {
  const sec = await leerSec(secId); const ps = await pasosDe(secId);
  const cuando = p => p.clave === 'conexion' || ps.length === 1 ? 'ahora' : p.tras_aceptar ? 'cuando acepte' : p.alternativo ? 'plan B, si no hay respuesta'
    : p.clave === 'llamada' ? `${p.dias === 1 ? 'al día siguiente de la solicitud' : p.dias ? `${p.dias} días después de la solicitud` : 'el mismo día que la solicitud'}, sin esperar a que acepte` : `${p.dias} días después del anterior`;
  const partes = [];
  if (sec.notas) partes.push(`NOTAS PARA DIRECCIÓN (no se envían)\n${sec.notas.trim()}`);
  if (sec.linkedin_url) partes.push(`Perfil: ${sec.linkedin_url}`);
  for (const p of ps) {
    if (p.asunto) partes.push(`ASUNTO DE ${p.titulo.toUpperCase()} (solo si LinkedIn lo pide)\n${p.asunto}`);
    partes.push(`${p.titulo.toUpperCase()} · ${cuando(p)}\n${p.texto}`);
  }
  return partes.join('\n\n');
}

/** Has aprobado la secuencia y hecho el primer paso: empieza el reloj. */
export async function empezar(secId) {
  const sec = await leerSec(secId); if (!sec || sec.estado !== 'borrador') return;
  const ps = await pasosDe(secId);
  const primero = ps.find(p => !p.alternativo);
  await q(`UPDATE secuencias SET estado='activa', actualizada=now() WHERE id=$1`, [secId]);
  await q(`UPDATE secuencias SET estado='cerrada', actualizada=now() WHERE empresa_id=$1 AND id<>$2 AND estado IN ('activa','aparcada')`, [sec.empresa_id, secId]);
  await q(`UPDATE pasos SET estado='hecho', hecho=now() WHERE id=$1`, [primero.id]);
  await empresas.actualizar(sec.empresa_id, { estado: 'contactada', ultimo_contacto: hoy() });
  await programarSiguiente(secId, primero);
}

/** Decide qué viene después de un paso hecho (o saltado). */
async function programarSiguiente(secId, anterior) {
  const sec = await leerSec(secId); const emp = await empresas.leer(sec.empresa_id);
  const ps = await pasosDe(secId);
  const sig = ps.find(p => !p.alternativo && p.orden > anterior.orden && p.estado === 'pendiente');
  if (anterior.clave === 'conexion') {
    // Paula vigila si acepta (el mensaje 1 se escribe entonces) y, si Javi dejó guion, la llamada va al día siguiente sin esperar
    const f = sumarDias(DIAS_ACEPTACION[0]);
    await q(`UPDATE secuencias SET control='aceptacion', control_fecha=$2, control_veces=0, actualizada=now() WHERE id=$1`, [secId, f]);
    const ll = ps.find(p => p.clave === 'llamada' && p.estado === 'pendiente');
    if (!ll) { await empresas.actualizar(emp.id, { proximo_paso: `Comprobar si ${quien(sec, emp)} ha aceptado`, fecha_proximo_paso: f }); return; }
    const fl = sumarDias(ll.dias ?? 1);
    await q(`UPDATE pasos SET estado='programado', fecha=$2 WHERE id=$1`, [ll.id, fl]);
    await empresas.actualizar(emp.id, { proximo_paso: `Llamar a ${quien(sec, emp)} (sin esperar a que acepte)`, fecha_proximo_paso: fl });
    await log('paula', `te pone la llamada a ${quien(sec, emp)} (${emp.nombre}) para ${fl <= hoy() ? 'hoy' : 'mañana'}: no esperamos a que acepte la conexión.`, { empresa_id: emp.id });
    if (fl <= hoy()) await ponerEnMesa(ll.id);
    return;
  }
  // Llamada hecha sin hablar mientras la conexión sigue su curso: Paula seguirá preguntando si ha aceptado
  if (!sig && sec.control === 'aceptacion') return;
  if (!sig && DESPUES[anterior.clave] && !anterior.alternativo) {
    // El seguimiento se escribe cuando toca, si para entonces no ha contestado
    const clave = DESPUES[anterior.clave], dias = TIPOS[clave].dias;
    const f = sumarDias(Math.max(0, dias - ANTELACION));
    await q(`UPDATE secuencias SET control=$2, control_fecha=$3, actualizada=now() WHERE id=$1`, [secId, `redactar:${clave}`, f]);
    await empresas.actualizar(emp.id, { proximo_paso: `${TIPOS[clave].titulo} si no contesta`, fecha_proximo_paso: sumarDias(dias) });
    return;
  }
  if (!sig) {
    const f = sumarDias(DIAS_CIERRE);
    await q(`UPDATE secuencias SET control='cierre', control_fecha=$2, actualizada=now() WHERE id=$1`, [secId, f]);
    await empresas.actualizar(emp.id, { proximo_paso: 'Ver si ha respondido a la secuencia', fecha_proximo_paso: f });
    return;
  }
  if (sig.tras_aceptar) {
    const f = sumarDias(DIAS_ACEPTACION[0]);
    await q(`UPDATE secuencias SET control='aceptacion', control_fecha=$2, control_veces=0, actualizada=now() WHERE id=$1`, [secId, f]);
    await empresas.actualizar(emp.id, { proximo_paso: `Comprobar si ${quien(sec, emp)} ha aceptado`, fecha_proximo_paso: f });
    return;
  }
  const f = sumarDias(sig.dias || 0);
  await q(`UPDATE pasos SET estado='programado', fecha=$2 WHERE id=$1`, [sig.id, f]);
  await q(`UPDATE secuencias SET control=NULL, control_fecha=NULL, actualizada=now() WHERE id=$1`, [secId]);
  await empresas.actualizar(emp.id, { proximo_paso: sig.titulo, fecha_proximo_paso: f });
  if (f <= hoy()) await ponerEnMesa(sig.id);
}

/** Paula te deja un paso en la mesa con el texto listo. */
export async function ponerEnMesa(pasoId, aviso = '') {
  const p = (await q('SELECT * FROM pasos WHERE id=$1', [pasoId])).rows[0];
  if (!p || ['hecho', 'saltado', 'cancelado', 'en_mesa'].includes(p.estado)) return null;
  const sec = await leerSec(p.secuencia_id); const emp = await empresas.leer(sec.empresa_id);
  const hechos = (await pasosDe(sec.id)).filter(x => x.estado === 'hecho');
  const contexto = [aviso, hechos.length ? `Ya hecho: ${hechos.map(h => `${h.titulo.toLowerCase()} (${fechaBonita(h.hecho?.toISOString?.() ?? h.hecho)})`).join(', ')}.` : '',
    perfilDe(sec, emp) && p.canal === 'linkedin' ? `Perfil: ${perfilDe(sec, emp)}` : '',
    p.canal === 'telefono' ? (t => t && `A quién llamar: ${t}`)(await (await import('./contactos.js')).lineaTelefonos(emp.id)) : '',
    ['carta', 'visita'].includes(p.canal) && emp.direccion ? `Dirección: ${emp.direccion}` : '',
    p.canal === 'telefono' ? `Cuándo llamar: ${(await (await import('./horario.js')).consejoHora(emp.id)).texto}` : ''].filter(Boolean).join('\n');
  const opciones = [{ r: 'hecho', t: OK[p.canal] || '✅ Hecho' }, RESPONDIDO];
  if (p.canal === 'telefono') opciones.push({ r: 'no_localizado', t: '🔁 No lo he localizado' }, { r: 'perdida', t: '✖ No le interesa' });
  else opciones.push({ r: 'saltar', t: '⏭ Saltar este paso' });
  opciones.push({ r: 'parar', t: '🛑 Parar la secuencia' });
  const id = await aprobaciones.crear({
    agente: 'paula', tipo: 'paso', empresa_id: emp.id, ref: `paso:${p.id}`,
    titulo: `te recuerda: toca ${p.titulo.toLowerCase()} a ${quien(sec, emp)} (${emp.nombre})`,
    texto: [contexto && `CONTEXTO (no se envía)\n${contexto}`, p.asunto && `ASUNTO (solo si LinkedIn lo pide)\n${p.asunto}`, `${p.titulo.toUpperCase()}\n${p.texto}`].filter(Boolean).join('\n\n'), opciones,
  });
  await q(`UPDATE pasos SET estado='en_mesa', aprobacion_id=$2 WHERE id=$1`, [p.id, id]);
  return id;
}

/** Lo que antes te preguntaba Paula se decide solo: si acepta lo sabemos por el aviso de LinkedIn y, si no hay respuesta, se pasa a la llamada o se aparca. */
async function ponerControl(sec) {
  await q(`UPDATE secuencias SET control_fecha=NULL, actualizada=now() WHERE id=$1`, [sec.id]);
  const ctl = { ref: `ctl:${sec.id}` };
  if (sec.control === 'aceptacion') return resolver(ctl, 'aun_no');
  const emp = await empresas.leer(sec.empresa_id), ps = await pasosDe(sec.id);
  const puedeLlamar = ps.some(p => p.alternativo && p.estado === 'pendiente') || (emp.telefono && !ps.some(p => p.clave === 'llamada' && p.estado === 'hecho'));
  return resolver(ctl, puedeLlamar ? 'plan_b' : 'aparcar');
}

/** Javi escribe el siguiente paso con todo lo que ya se ha enviado. */
async function encargarPaso(sec, clave, motivo) {
  const emp = await empresas.leer(sec.empresa_id); const ps = await pasosDe(sec.id);
  const enviados = ps.filter(p => p.estado === 'hecho').map(p => `— ${p.titulo} (${fechaBonita(p.hecho?.toISOString?.() ?? p.hecho)}):\n${p.texto}`).join('\n\n');
  const guia = {
    mensaje1: 'El mensaje 1 tras aceptar: agradece en media línea, una sola idea concreta sacada del dossier y una pregunta pequeña. Con «asunto» corto por si LinkedIn lo pide.',
    seguimiento1: 'Seguimiento 1: no repitas el mensaje 1. Aporta algo nuevo y útil (un dato, un caso, una idea) y deja la puerta abierta. Breve.',
    seguimiento2: 'Seguimiento 2, el último: muy corto, sin presión, cierra con elegancia («si no es el momento, lo dejo aquí»).',
    llamada: 'Guion de llamada (plan B).',
  }[clave] || '';
  await q(`UPDATE secuencias SET control=$2, control_fecha=NULL, actualizada=now() WHERE id=$1`, [sec.id, `redactando:${clave}`]);
  await tareas.crear('javi', `${motivo}\n\nEscribe ahora el ${TIPOS[clave].titulo.toLowerCase()} para ${quien(sec, emp)} (${emp.nombre}) y entrégalo con anadir_paso (empresa_id «${emp.id}», clave «${clave}»). Llegará a la mesa de Dirección al momento.\n${guia}\n\n` +
    `Lo que ya le hemos enviado:\n${enviados || '(nada)'}\n\n${sec.notas ? `Tus notas de entonces: ${sec.notas}\n\n` : ''}Mira el dossier con leer_empresa por si hay algo nuevo.`,
    { empresa_id: emp.id, origen: 'secuencia' });
}

/** Javi entrega un paso que faltaba: va a tu mesa al momento. */
export async function anadirPaso({ empresa_id, clave, texto, asunto, canal }) {
  const emp = await empresas.leer(empresa_id);
  if (!emp) throw new Error(`No existe la empresa ${empresa_id}`);
  const sec = (await q(`SELECT * FROM secuencias WHERE empresa_id=$1 AND estado='activa' ORDER BY id DESC LIMIT 1`, [emp.id])).rows[0];
  if (!sec) throw new Error('Esta empresa no tiene una secuencia activa (puede que ya haya respondido o se haya parado). Avisa a Dirección con anotar.');
  if (!String(texto || '').trim()) throw new Error('Falta el texto.');
  clave = CLAVES.includes(clave) ? clave : 'otro';
  const def = TIPOS[clave]; canal = canal || def.canal;
  if (canal === 'carta') throw new Error(SIN_CARTAS);
  if (canal === 'whatsapp' && !['conversacion', 'reunion', 'propuesta', 'ganada'].includes(emp.estado)) throw new Error('No se puede usar WhatsApp en frío (LSSI art. 21). Usa LinkedIn, teléfono, correo o presentación.');
  const ps = await pasosDe(sec.id);
  const viejo = ps.find(p => p.clave === clave && ['pendiente', 'programado'].includes(p.estado));
  if (viejo) await q(`UPDATE pasos SET estado='cancelado' WHERE id=$1`, [viejo.id]);
  const orden = Math.max(0, ...ps.map(p => p.orden)) + 1;
  const asuntoF = canal === 'linkedin' ? (String(asunto || '').trim().slice(0, 80) || asuntoPorDefecto(clave, emp)) : null;
  const paso = (await q(`INSERT INTO pasos (secuencia_id, orden, clave, canal, titulo, texto, dias, tras_aceptar, alternativo, asunto, estado, fecha)
                        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'programado',$11) RETURNING *`,
    [sec.id, orden, clave, canal, def.titulo, String(texto).trim(), def.dias ?? 0, Boolean(def.tras_aceptar), Boolean(def.alternativo), asuntoF, hoy()])).rows[0];
  await q(`UPDATE secuencias SET control=NULL, control_fecha=NULL, actualizada=now() WHERE id=$1`, [sec.id]);
  await empresas.actualizar(emp.id, { proximo_paso: def.titulo, fecha_proximo_paso: hoy() });
  const aviso = { mensaje1: `${quien(sec, emp)} ha aceptado tu conexión. Ahora toca el mensaje 1.`, seguimiento1: 'No ha contestado al mensaje 1.', seguimiento2: 'Tampoco ha contestado al seguimiento 1. Este es el último.', llamada: 'No ha contestado por LinkedIn. Plan B: llamada.' }[clave] || '';
  const aprobacion = await ponerEnMesa(paso.id, aviso);
  await emitirCambio(emp.id);
  return { paso: paso.id, aprobacion };
}

/** Revisión diaria (y al momento cuando algo cambia): lo que toca hoy, a tu mesa. */
export async function revisar() {
  const d = hoy();
  const ps = (await q(`SELECT p.id FROM pasos p JOIN secuencias s ON s.id=p.secuencia_id
                        WHERE p.estado='programado' AND p.fecha <= $1 AND s.estado='activa' ORDER BY p.fecha, p.id`, [d])).rows;
  for (const p of ps) await ponerEnMesa(p.id);
  const cs = (await q(`SELECT * FROM secuencias WHERE estado='activa' AND control IS NOT NULL AND control_fecha <= $1`, [d])).rows;
  for (const s of cs) {
    if (String(s.control).startsWith('redactar:')) {
      const clave = s.control.split(':')[1];
      await encargarPaso(s, clave, clave === 'seguimiento1' ? 'Han pasado unos días desde el mensaje 1 y no ha contestado.' : 'Tampoco ha contestado al seguimiento 1.');
    } else if (!String(s.control).startsWith('redactando:')) await ponerControl(s);
  }
  const aparcadas = (await q(`SELECT s.* FROM secuencias s JOIN empresas e ON e.id=s.empresa_id
                               WHERE s.estado='aparcada' AND e.fecha_proximo_paso <= $1`, [d])).rows;
  for (const s of aparcadas) {
    await q(`UPDATE secuencias SET estado='cerrada', actualizada=now() WHERE id=$1`, [s.id]);
    await tareas.crear('javi', `Han pasado 3 meses desde que aparcamos el contacto con ${s.decisor || 'esta empresa'}. Prepara una secuencia nueva y corta para retomarlo, con un gancho distinto al de la vez anterior (mira el historial con leer_empresa).`, { empresa_id: s.empresa_id, origen: 'sistema' });
  }
  return ps.length + cs.length;
}

/** Lo que eliges en un paso o en una pregunta de Paula. Devuelve una frase para el registro. */
export async function resolver(ap, resultado, texto = '') {
  const [tipo, n] = String(ap.ref || '').split(':'); const refId = Number(n);
  let sec, paso;
  if (tipo === 'paso') { paso = (await q('SELECT * FROM pasos WHERE id=$1', [refId])).rows[0]; sec = paso && await leerSec(paso.secuencia_id); }
  else if (tipo === 'ctl') sec = await leerSec(refId);
  if (!sec) return;
  const emp = await empresas.leer(sec.empresa_id); const nombre = quien(sec, emp);
  const ps = await pasosDe(sec.id);

  if (resultado === 'respondido') {
    await q(`UPDATE secuencias SET estado='respondida', control=NULL, control_fecha=NULL, actualizada=now() WHERE id=$1`, [sec.id]);
    await q(`UPDATE pasos SET estado='cancelado' WHERE secuencia_id=$1 AND estado IN ('pendiente','programado')`, [sec.id]);
    if (paso) await q(`UPDATE pasos SET estado='hecho', hecho=coalesce(hecho, now()) WHERE id=$1 AND estado='en_mesa'`, [paso.id]);
    await empresas.actualizar(emp.id, { estado: 'conversacion', ultimo_contacto: hoy(), proximo_paso: 'Contestar a su respuesta', fecha_proximo_paso: hoy() });
    const enviados = ps.filter(p => p.estado === 'hecho' || p.id === paso?.id).map(p => `— ${p.titulo}:\n${p.texto}`).join('\n\n');
    await tareas.crear('paula', `${nombre} (${emp.nombre}) ha respondido a la secuencia de contacto.\n\nLo que ha dicho, según Dirección: «${texto}»\n\n` +
      `Lo que ya le habíamos enviado:\n${enviados}\n\n${sec.notas ? `Notas de Javi para Dirección: ${sec.notas}\n\n` : ''}` +
      'Clasifica la respuesta, actualiza la empresa y prepara la contestación con pedir_aprobacion (tipo respuesta).', { empresa_id: emp.id, origen: 'dueno' });
    return `ha marcado que ${nombre} (${emp.nombre}) ha respondido. Paula prepara la contestación.`;
  }
  if (resultado === 'parar') {
    await q(`UPDATE secuencias SET estado='cerrada', control=NULL, control_fecha=NULL, actualizada=now() WHERE id=$1`, [sec.id]);
    await q(`UPDATE pasos SET estado='cancelado' WHERE secuencia_id=$1 AND estado IN ('pendiente','programado','en_mesa')`, [sec.id]);
    await empresas.actualizar(emp.id, { proximo_paso: null, fecha_proximo_paso: null });
    return `ha parado la secuencia de contacto con ${emp.nombre}.`;
  }
  if (resultado === 'perdida') {
    await q(`UPDATE secuencias SET estado='cerrada', control=NULL, control_fecha=NULL, actualizada=now() WHERE id=$1`, [sec.id]);
    await q(`UPDATE pasos SET estado='cancelado' WHERE secuencia_id=$1 AND estado IN ('pendiente','programado','en_mesa')`, [sec.id]);
    if (paso) await q(`UPDATE pasos SET estado='hecho', hecho=now() WHERE id=$1`, [paso.id]);
    await empresas.actualizar(emp.id, { estado: 'perdida', proximo_paso: null, fecha_proximo_paso: null });
    return `ha dado por perdida ${emp.nombre}.`;
  }
  if (resultado === 'aparcar') {
    await q(`UPDATE secuencias SET estado='aparcada', control=NULL, control_fecha=NULL, actualizada=now() WHERE id=$1`, [sec.id]);
    await q(`UPDATE pasos SET estado='cancelado' WHERE secuencia_id=$1 AND estado IN ('pendiente','programado')`, [sec.id]);
    await empresas.actualizar(emp.id, { proximo_paso: 'Retomar el contacto', fecha_proximo_paso: sumarDias(90) });
    return `ha aparcado ${emp.nombre}: Javi preparará algo nuevo dentro de 3 meses.`;
  }
  if (tipo === 'ctl') {
    if (resultado === 'aceptado') {
      await q(`UPDATE secuencias SET control=NULL, control_fecha=NULL, actualizada=now() WHERE id=$1`, [sec.id]);
      const m1 = ps.find(p => p.tras_aceptar && p.estado === 'pendiente');
      if (m1) { await q(`UPDATE pasos SET estado='programado', fecha=$2 WHERE id=$1`, [m1.id, hoy()]); await ponerEnMesa(m1.id, `${nombre} ha aceptado tu conexión. Ahora toca el mensaje 1.`); }
      else {
        await encargarPaso(sec, 'mensaje1', `${nombre} (${emp.nombre}) ha aceptado la solicitud de conexión de Dirección en LinkedIn.`);
        await empresas.actualizar(emp.id, { proximo_paso: 'Javi prepara el mensaje 1', fecha_proximo_paso: hoy() });
        return `ha confirmado que ${nombre} (${emp.nombre}) ha aceptado la conexión. Javi escribe el mensaje 1.`;
      }
      return `ha confirmado que ${nombre} (${emp.nombre}) ha aceptado la conexión.`;
    }
    if (resultado === 'aun_no') {
      const veces = sec.control_veces + 1;
      if (veces < DIAS_ACEPTACION.length) {
        await q(`UPDATE secuencias SET control_veces=$2, control_fecha=$3, actualizada=now() WHERE id=$1`, [sec.id, veces, sumarDias(DIAS_ACEPTACION[veces])]);
        return `dice que ${nombre} aún no ha aceptado. Paula volverá a preguntar en ${DIAS_ACEPTACION[veces]} días.`;
      }
      const planB = ps.find(p => p.alternativo && p.estado === 'pendiente');
      await q(`UPDATE secuencias SET control=NULL, control_fecha=NULL, control_veces=$2, actualizada=now() WHERE id=$1`, [sec.id, veces]);
      if (!planB && emp.telefono && !ps.some(p => p.clave === 'llamada')) {
        await encargarPaso(sec, 'llamada', `${nombre} (${emp.nombre}) no ha aceptado la conexión en más de una semana. Tenemos su teléfono: ${emp.telefono}.`);
        return `dice que ${nombre} sigue sin aceptar. Javi prepara el guion de la llamada.`;
      }
      if (planB) {
        await q(`UPDATE pasos SET estado='programado', fecha=$2 WHERE id=$1`, [planB.id, hoy()]);
        await ponerEnMesa(planB.id, `${nombre} no ha aceptado la conexión en más de una semana. Toca el plan B.`);
        return `dice que ${nombre} sigue sin aceptar. Paula te pasa el plan B.`;
      }
      await q(`UPDATE secuencias SET control='cierre', control_fecha=$2 WHERE id=$1`, [sec.id, hoy()]);
      await ponerControl({ ...sec, control: 'cierre' });
      return `dice que ${nombre} sigue sin aceptar.`;
    }
    if (resultado === 'plan_b') {
      const planB = ps.find(p => p.alternativo && p.estado === 'pendiente');
      if (planB) { await q(`UPDATE pasos SET estado='programado', fecha=$2 WHERE id=$1`, [planB.id, hoy()]); await ponerEnMesa(planB.id); }
      else { await encargarPaso(sec, 'llamada', `${nombre} (${emp.nombre}) no ha contestado por LinkedIn y Dirección quiere llamar${emp.telefono ? ` (${emp.telefono})` : ''}.`); return `va a llamar a ${emp.nombre}. Javi prepara el guion.`; }
      return `va a probar el plan B con ${emp.nombre}.`;
    }
    return;
  }
  // Un paso concreto
  if (resultado === 'no_localizado') {
    const f = sumarDias(2);
    await q(`UPDATE pasos SET estado='programado', fecha=$2, aprobacion_id=NULL WHERE id=$1`, [paso.id, f]);
    await empresas.actualizar(emp.id, { proximo_paso: `Volver a llamar a ${nombre}`, fecha_proximo_paso: f });
    return `no ha localizado a ${nombre}. Paula te lo vuelve a poner en 2 días.`;
  }
  if (resultado === 'hecho' || resultado === 'saltar') {
    await q(`UPDATE pasos SET estado=$2, hecho=now() WHERE id=$1`, [paso.id, resultado === 'hecho' ? 'hecho' : 'saltado']);
    if (resultado === 'hecho') await empresas.actualizar(emp.id, { ultimo_contacto: hoy() });
    if (paso.alternativo) {
      // Tras el plan B, una semana y Paula pregunta qué hacemos
      await q(`UPDATE secuencias SET control='cierre', control_fecha=$2, actualizada=now() WHERE id=$1`, [sec.id, sumarDias(DIAS_CIERRE)]);
      await empresas.actualizar(emp.id, { proximo_paso: 'Ver si ha respondido', fecha_proximo_paso: sumarDias(DIAS_CIERRE) });
    } else await programarSiguiente(sec.id, paso);
    return resultado === 'hecho' ? `ha hecho «${paso.titulo.toLowerCase()}» con ${nombre} (${emp.nombre}).` : `se ha saltado «${paso.titulo.toLowerCase()}» con ${emp.nombre}.`;
  }
}

/** La secuencia de una empresa, para la ficha del panel. */
export async function deEmpresa(empresaId) {
  const sec = (await q(`SELECT * FROM secuencias WHERE empresa_id=$1 AND estado<>'descartada' ORDER BY id DESC LIMIT 1`, [empresaId])).rows[0];
  if (!sec) return null;
  return { ...sec, pasos: await pasosDe(sec.id) };
}

/** Si una secuencia se descarta o se rehace, su borrador deja de valer. */
export async function descartar(secId) {
  await q(`UPDATE secuencias SET estado='descartada', actualizada=now() WHERE id=$1 AND estado='borrador'`, [secId]);
}

export async function emitirCambio(empresaId) { await emitir({ tipo: 'secuencia', empresa_id: empresaId }); }
