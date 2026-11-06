// Bot de Telegram: avisos, aprobaciones con botones y comandos sencillos.
// Solo atiende al chat configurado en TELEGRAM_CHAT_ID.
import { config } from './config.js';

// El bot de la oficina (el que habla contigo). Del .env o, si no, configurado desde el panel y vinculado con /start <código>
import crypto from 'node:crypto';
import { ajuste, fijarAjuste } from './db.js';
const cfg = { token: config.telegramToken, chat: config.telegramChatId, user: config.telegramUserId, env: Boolean(config.telegramToken && config.telegramChatId), usuario: null };
let codigoVinculo = null;
const apiUrl = () => `https://api.telegram.org/bot${cfg.token}`;
export const activo = () => Boolean(cfg.token && cfg.chat);
export const _fijarBot = (token, chat, user = cfg.user) => { cfg.token = token; cfg.chat = chat; cfg.user = user; };   // para las pruebas
const claveC = () => crypto.createHash('sha256').update('acp-telegram:' + config.claveCifrado).digest();
const cifrarT = t => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', claveC(), iv); const d = Buffer.concat([c.update(t, 'utf8'), c.final()]); return [iv, c.getAuthTag(), d].map(b => b.toString('base64')).join('.'); };
const descifrarT = s => { const [iv, tag, d] = s.split('.').map(x => Buffer.from(x, 'base64')); const c = crypto.createDecipheriv('aes-256-gcm', claveC(), iv); c.setAuthTag(tag); return Buffer.concat([c.update(d), c.final()]).toString('utf8'); };

/** Al arrancar: si no hay bot en el .env, el que se configuró desde el panel. */
export async function cargar() {
  if (cfg.env) return;
  const g = await ajuste('telegram_oficina', null);
  if (g?.token) { try { cfg.token = descifrarT(g.token); cfg.chat = g.chat || ''; cfg.user = g.user || g.chat || ''; cfg.usuario = g.usuario || null; } catch { console.error('No se pudo leer el bot de la oficina'); } }
}
async function getMe() {
  if (!cfg.token) return null;
  try { const j = await (await fetch(`${apiUrl()}/getMe`)).json(); if (j.ok) cfg.usuario = j.result.username; return j.ok ? j.result : null; } catch { return null; }
}
export async function estado() {
  if (cfg.token && !cfg.usuario) await getMe();
  return { conectado: activo(), configurado: Boolean(cfg.token), usuario: cfg.usuario, desde_env: cfg.env,
    vincular: !activo() && cfg.token && codigoVinculo ? `https://t.me/${cfg.usuario}?start=${codigoVinculo}` : null };
}
/** Desde el panel: Dirección pega el token de su bot; luego lo vincula abriendo el enlace y pulsando «Iniciar». */
export async function configurar(token) {
  if (cfg.env) throw new Error('El bot de la oficina ya está configurado en el servidor.');
  const tk = String(token || '').trim();
  if (!/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(tk)) throw new Error('El token no parece válido: cópialo entero del mensaje de @BotFather.');
  const viejo = cfg.token; cfg.token = tk;
  if (!(await getMe())) { cfg.token = viejo; throw new Error('Telegram no reconoce ese token.'); }
  cfg.chat = ''; cfg.user = '';
  codigoVinculo = crypto.randomBytes(6).toString('hex');
  await fijarAjuste('telegram_oficina', { token: cifrarT(tk), usuario: cfg.usuario });
  escuchar();
  return estado();
}
export async function prueba() {
  if (!activo()) throw new Error('El bot de la oficina no está conectado.');
  await llamar('sendMessage', { chat_id: cfg.chat, text: '✅ La oficina está conectada contigo. Aquí te llegarán los avisos y lo que haya que aprobar.' });
}

let manejadorBoton = async () => {};
let manejadorComando = async () => {};
let manejadorRespuesta = async () => {};
export const alResponder = fn => { manejadorRespuesta = fn; };
let manejadorLibre = async () => {};
export const alEscribir = fn => { manejadorLibre = fn; };
export const alPulsar = fn => { manejadorBoton = fn; };
export const alComando = fn => { manejadorComando = fn; };

const html = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function llamar(metodo, cuerpo) {
  if (!activo()) return null;
  try {
    const r = await fetch(`${apiUrl()}/${metodo}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });
    const j = await r.json();
    if (!j.ok) console.error(`Telegram ${metodo}:`, j.description);
    return j.result;
  } catch (e) { console.error(`Telegram ${metodo}:`, e.message); return null; }
}

// Modo ausencia: si Dirección duerme o está de vacaciones, los avisos se guardan para el resumen
let politica = { silencio: async () => false, encolar: async () => {} };
export const fijarPolitica = p => { politica = p; };

export async function avisar(texto, { ahora = false } = {}) {
  if (!activo()) return null;
  if (!ahora && await politica.silencio()) { await politica.encolar(texto); return 'cola'; }
  return llamar('sendMessage', { chat_id: cfg.chat, text: texto, disable_web_page_preview: true });
}

const ETIQUETA_OK = { mensaje: '✅ Lo he enviado', respuesta: '✅ Lo he enviado', post: '✅ Lo he publicado', articulo: '✅ Publicar', boletin: '✅ Aprobar', anuncio: '✅ Aprobar', propuesta: '✅ Aprobar', regla: '✅ Guardar regla', otro: '✅ Aprobar' };

const CANAL = { linkedin: 'LinkedIn', instagram: 'Instagram', youtube: 'YouTube Shorts', google: 'Google Business', web: 'Web', boletin: 'Boletín', anuncios: 'Anuncios' };
const fechaCorta = f => new Date(String(f).slice(0, 10) + 'T12:00:00Z').toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

/** Parte un texto en bloques «TÍTULO + cuerpo»; las notas para Dirección no son para copiar. */
export function bloques(t) {
  const out = []; let cur = null;
  for (const l of String(t || '').replace(/\r/g, '').split('\n')) {
    const cab = l.trim().split(' · ')[0].replace(/\(.*?\)/g, '').trim();
    if (cab.length >= 4 && /^[A-ZÁÉÍÓÚÑÜ0-9 \/-]+$/.test(cab) && /[A-ZÁÉÍÓÚÑÜ]{3}/.test(cab)) { cur = { titulo: l.trim(), lineas: [] }; out.push(cur); continue; }
    if (/^-{3,}\s*$/.test(l.trim())) { cur = { titulo: 'Notas', lineas: [], notas: true }; out.push(cur); continue; }
    if (!cur) { cur = { titulo: '', lineas: [] }; out.push(cur); }
    cur.lineas.push(l);
  }
  return out.map(b => { const cuerpo = b.lineas.join('\n').trim(); return { titulo: b.titulo, cuerpo, copiar: Boolean(cuerpo) && !b.notas && !/^NOTAS|no se env/i.test(b.titulo) }; }).filter(b => b.cuerpo || b.titulo);
}

/** Envía una aprobación con el texto en bloque copiable y botones. Devuelve el id del mensaje. */
export async function enviarAprobacion(ap, { nombreAgente, empresa, ahora = false }) {
  if (!activo()) return null;
  if (!ahora && await politica.silencio()) return 'cola';
  const max = 3500;
  const cuerpo = ap.texto.length > max ? ap.texto.slice(0, max) + '\n[…] (completo en el panel)' : ap.texto;
  const conCambios = !ap.opciones || ap.opciones.some(o => o.r === 'cambios');
  const pie = conCambios ? 'Toca el texto para copiarlo. Para pedir cambios, responde a este mensaje.'
    : 'Toca el texto para copiarlo. Si te ha contestado, responde a este mensaje con lo que te ha dicho.';
  const prio = ap.prio ? `${ap.prio.emoji} <b>${html(ap.prio.etiqueta)}</b> · ${html(ap.prio.motivo)}\n` : '';
  // Cada bloque que hay que pegar en algún sitio va en su propio recuadro: un toque lo copia entero
  const cuerpoHtml = bloques(cuerpo).map(bl => `${bl.titulo ? `<b>${html(bl.titulo)}</b>\n` : ''}${bl.cuerpo ? (bl.copiar ? `<pre>${html(bl.cuerpo)}</pre>` : `<i>${html(bl.cuerpo)}</i>`) : ''}`).join('\n');
  const icono = { paso: '📅', video: '🎬', articulo: '🌐', boletin: '📰', anuncio: '📣' }[ap.tipo] || '📝';
  const texto = `${prio}${icono} <b>${html(nombreAgente)}</b> ${html(ap.titulo)}${ap.canal || ap.fecha_prevista ? `\n🗓 ${[ap.canal && CANAL[ap.canal], ap.fecha_prevista && fechaCorta(ap.fecha_prevista)].filter(Boolean).join(' · ')}${ap.auto ? ' · 🤖 se publica solo a las 9:00 si no lo paras' : ''}` : ''}\n\n${cuerpoHtml}\n${pie}`;
  const filas = [];
  const enlaces = [];
  if (empresa?.linkedin_url) enlaces.push({ text: `LinkedIn de ${String(empresa.decisor || 'el decisor').split(' ')[0]}`, url: empresa.linkedin_url });
  if (empresa?.linkedin_empresa) enlaces.push({ text: 'LinkedIn empresa', url: empresa.linkedin_empresa });
  if (config.panelUrl) enlaces.push({ text: 'Ver en el panel', url: config.panelUrl });
  if (enlaces.length) filas.push(enlaces);
  if (ap.opciones) {
    const botones = ap.opciones.filter(o => o.r !== 'cambios').map(o => ({ text: o.t || o.r, callback_data: `ap:${ap.id}:${o.r}` }));
    for (let i = 0; i < botones.length; i += 2) filas.push(botones.slice(i, i + 2));
  } else filas.push([
    ap.tipo === 'video' ? { text: '🎬 Generar vídeo', callback_data: `ap:${ap.id}:generar` } : { text: ETIQUETA_OK[ap.tipo] || '✅ Aprobar', callback_data: `ap:${ap.id}:ok` },
    { text: 'Descartar', callback_data: `ap:${ap.id}:no` },
  ]);
  const m = await llamar('sendMessage', { chat_id: cfg.chat, text: texto, parse_mode: 'HTML', reply_markup: { inline_keyboard: filas }, disable_web_page_preview: true });
  return m?.message_id ?? null;
}

/** Ya no toca: el mensaje desaparece del chat. Si es demasiado antiguo para borrarlo (48 h), se queda sin botones. */
export async function retirar(msgId) {
  if (!msgId) return;
  if (await llamar('deleteMessage', { chat_id: cfg.chat, message_id: msgId })) return;
  await llamar('editMessageReplyMarkup', { chat_id: cfg.chat, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: '🔁 Ya no hace falta', callback_data: 'nada' }]] } });
}

export async function marcarResuelta(msgId, resultado, etiqueta) {
  if (!msgId) return;
  const texto = etiqueta ? `✔ ${etiqueta.replace(/^\S+\s/, '')}` : resultado === 'aprobada' ? '✅ Hecho' : resultado === 'cambios' ? '✏️ Cambios pedidos' : '✖ Descartado';
  await llamar('editMessageReplyMarkup', { chat_id: cfg.chat, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: texto, callback_data: 'nada' }]] } });
}

/** Pide a Dirección que conteste a un mensaje concreto (p. ej. con lo que le ha respondido un lead). */
export async function pedirRespuesta(msgId, texto) {
  return llamar('sendMessage', { chat_id: cfg.chat, text: texto, reply_to_message_id: msgId || undefined, reply_markup: { force_reply: true, input_field_placeholder: 'Lo que te ha dicho…' } });
}

let offset = 0, parar = false;
let escuchando = false;
export async function escuchar() {
  if (!cfg.token) { console.log('Telegram desactivado (falta el bot de la oficina).'); return; }
  if (escuchando) return; escuchando = true;
  await llamar('setMyCommands', { commands: [
    { command: 'estado', description: 'Embudo, pendientes y gasto' },
    { command: 'encargar', description: 'encargar <agente> <instrucción>' },
    { command: 'pausa', description: 'Pausar a todos los agentes' },
    { command: 'reanudar', description: 'Reanudar el trabajo' },
  ] });
  while (!parar) {
    try {
      const r = await fetch(`${apiUrl()}/getUpdates`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ offset, timeout: 50, allowed_updates: ['message', 'callback_query'] }) });
      const j = await r.json();
      for (const u of j.result || []) {
        offset = u.update_id + 1;
        try { await procesar(u); } catch (e) { console.error('Telegram update:', e.message); }
      }
    } catch (e) {
      console.error('Telegram getUpdates:', e.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}
export const detener = () => { parar = true; };

export const _procesar = u => procesar(u);   // para las pruebas
async function procesar(u) {
  const chat = String(u.callback_query?.message?.chat?.id ?? u.message?.chat?.id ?? '');
  const de = String(u.callback_query?.from?.id ?? u.message?.from?.id ?? '');
  // Vinculación desde el panel: el primero que manda «/start <código>» queda como dueño del bot
  const txt0 = String(u.message?.text || '').trim();
  if (!cfg.env && codigoVinculo && txt0 === `/start ${codigoVinculo}`) {
    cfg.chat = chat; cfg.user = de; codigoVinculo = null;
    const g = await ajuste('telegram_oficina', {}); await fijarAjuste('telegram_oficina', { ...g, chat, user: de });
    await llamar('sendMessage', { chat_id: chat, text: '✅ Vinculado. A partir de ahora la oficina te escribe aquí.' });
    return;
  }
  if (!activo() || chat !== String(cfg.chat) || de !== String(cfg.user)) return;   // solo Dirección, en su chat
  await politica.actividad?.();   // si Dirección escribe, está despierto: se le contesta al momento
  if (u.callback_query) {
    const [tipo, id, acc] = (u.callback_query.data || '').split(':');
    await llamar('answerCallbackQuery', { callback_query_id: u.callback_query.id });
    if (tipo === 'ap' && id) await manejadorBoton(id, acc === 'ok' ? 'aprobada' : acc === 'no' ? 'descartada' : acc, u.callback_query.message?.message_id);
    return;
  }
  const texto = (u.message?.text || '').trim();
  const respondido = u.message?.reply_to_message?.message_id;
  if (respondido && texto && !texto.startsWith('/')) {
    const r = await manejadorRespuesta(respondido, texto, u.message.reply_to_message.text || '');
    if (r) await avisar(r, { ahora: true });
    return;
  }
  if (texto.startsWith('/')) {
    const [cmd, ...resto] = texto.slice(1).split(/\s+/);
    const respuesta = await manejadorComando(cmd.replace(/@.*/, '').toLowerCase(), resto.join(' '));
    if (respuesta) await avisar(respuesta, { ahora: true });
  } else if (texto) {
    const r = await manejadorLibre(texto);
    if (r) await avisar(r, { ahora: true });
  }
}
