// Canales de chat con leads (de momento, un bot de Telegram de contacto; mañana, WhatsApp con la misma lógica).
// Solo se contesta a quien nos escribe: es él quien inicia la conversación (nada en frío).
// Al primer mensaje se le contesta al momento con un acuse; la respuesta de verdad la prepara Paula y la envía Dirección.
import crypto from 'node:crypto';
import { q, ajuste, fijarAjuste } from './db.js';
import { config } from './config.js';
import * as miEmpresa from './empresa.js';
import { log } from './bus.js';
import * as tareas from './tareas.js';
import * as empresas from './empresas.js';
import { T } from './en.js';

const clave = () => crypto.createHash('sha256').update('acp-chats:' + config.claveCifrado).digest();
function cifrar(t) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', clave(), iv);
  const d = Buffer.concat([c.update(t, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), d].map(b => b.toString('base64')).join('.');
}
function descifrar(s) {
  const [iv, tag, d] = s.split('.').map(x => Buffer.from(x, 'base64'));
  const c = crypto.createDecipheriv('aes-256-gcm', clave(), iv); c.setAuthTag(tag);
  return Buffer.concat([c.update(d), c.final()]).toString('utf8');
}

// ---------- Telegram de contacto ----------
let token = null, bot = null, parar = false, enMarcha = false;
const tg = async (metodo, cuerpo) => {
  if (process.env.CHATS_SIMULADO) return { ok: true, result: { message_id: 1, username: 'prueba_bot' } };
  const r = await fetch(`https://api.telegram.org/bot${token}/${metodo}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo), signal: AbortSignal.timeout(60000) });
  return r.json();
};

export async function cargar() {
  const g = await ajuste('telegram_contacto', null);
  if (!g) return;
  try { token = descifrar(g.token); bot = g.usuario; arrancar(); } catch { console.error('No se pudo leer el bot de contacto'); }
}

/** Dirección pega el token que le da @BotFather. */
export async function guardarTelegram(t) {
  const tk = String(t || '').trim();
  if (!/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(tk)) throw new Error(T('El token no parece válido: cópialo entero del mensaje de @BotFather (números, dos puntos y letras).'));
  if (tk === config.telegramToken) throw new Error(T('Ese es el bot con el que hablas tú con la oficina. Crea uno nuevo en @BotFather para los clientes.'));
  token = tk;
  const me = await tg('getMe', {});
  if (!me.ok) { token = null; throw new Error(T('Telegram no reconoce ese token.')); }
  bot = me.result.username;
  await fijarAjuste('telegram_contacto', { token: cifrar(tk), usuario: bot });
  await tg('setMyDescription', { description: miEmpresa.texto('descripcionChat') }).catch(() => {});
  arrancar();
  return estado();
}

export async function estado() {
  const g = await ajuste('telegram_contacto', null);
  return g ? { telegram: { conectado: true, usuario: g.usuario, enlace: `https://t.me/${g.usuario}` } } : { telegram: { conectado: false } };
}
export async function desconectarTelegram() { parar = true; token = null; await fijarAjuste('telegram_contacto', null); }

function arrancar() {
  if (enMarcha || !token) return;
  enMarcha = true; parar = false;
  (async () => {
    let offset = Number(await ajuste('telegram_contacto_offset', 0)) || 0;
    while (!parar && token) {
      try {
        const r = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] });
        for (const u of r.result || []) {
          offset = u.update_id + 1;
          await fijarAjuste('telegram_contacto_offset', offset);
          if (u.message?.chat?.type === 'private' && (u.message.text || u.message.caption)) await recibir('telegram', u.message).catch(e => console.error('Chat (Telegram):', e.message));
        }
      } catch (e) { console.error('Telegram contacto:', e.message); await new Promise(res => setTimeout(res, 15000)); }
    }
    enMarcha = false;
  })();
}

// ---------- Lo común a todos los canales ----------
const ACUSE = () => miEmpresa.texto('acuseChat');
const BIENVENIDA = () => miEmpresa.texto('bienvenidaChat');

/** Llega un mensaje de un lead por un canal de chat. */
export async function recibir(canal, m) {
  const chatId = String(m.chat.id);
  const nombre = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' ') || m.from?.username || 'Contacto de Telegram';
  const texto = String(m.text || m.caption || '').trim();
  let chat = (await q(`SELECT * FROM chats WHERE canal=$1 AND chat_id=$2`, [canal, chatId])).rows[0];
  const nuevo = !chat;
  if (nuevo) {
    const { creadas } = await empresas.crear([{ nombre: `${nombre} (${canal})`, origen: canal, origen_detalle: `Escribió por ${canal}${m.from?.username ? ' (@' + m.from.username + ')' : ''}`, decisor: nombre, notas: 'Nos escribió por chat: contestar el mismo día.' }]).catch(() => ({ creadas: [] }));
    const empresaId = creadas?.[0]?.id || null;
    chat = (await q(`INSERT INTO chats (canal, chat_id, nombre, usuario, empresa_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [canal, chatId, nombre, m.from?.username || null, empresaId])).rows[0];
  }
  if (texto === '/start') { await enviarTexto(chat, BIENVENIDA(), { auto: true }); return; }
  await q(`INSERT INTO mensajes_chat (chat, direccion, texto) VALUES ($1,'entrada',$2)`, [chat.id, texto.slice(0, 4000)]);
  if (chat.empresa_id) await empresas.actualizar(chat.empresa_id, { estado: 'conversacion', ultimo_contacto: new Date().toISOString().slice(0, 10) }).catch(() => {});
  const acusado = (await q(`SELECT 1 FROM mensajes_chat WHERE chat=$1 AND direccion='salida' AND auto LIMIT 1`, [chat.id])).rows.length;
  if (!acusado) await enviarTexto(chat, ACUSE(), { auto: true });
  // Si Paula ya tiene este chat entre manos, no se le encarga otra vez (lee todo el hilo al empezar)
  const ya = (await q(`SELECT 1 FROM tareas WHERE agente='paula' AND estado IN ('pendiente','en_curso') AND instruccion LIKE $1`, [`%[chat ${chat.id}]%`])).rows.length;
  if (!ya) {
    await tareas.crear('paula', `Mensaje nuevo por ${canal} de ${nombre} [chat ${chat.id}]. Lee la conversación con leer_chat (chat ${chat.id}) y prepara la respuesta con responder_chat. Es un contacto que nos ha escrito él: contéstale de tú a tú, corto, y propón el siguiente paso (por ejemplo, una llamada de 15 minutos). Si cuenta algo útil de su empresa, guárdalo con actualizar_empresa.`,
      { empresa_id: chat.empresa_id, origen: 'web' });
  }
  const tgDueno = await import('./telegram.js');
  await tgDueno.avisar(`💬 ${nombre} escribe por ${canal}:\n«${texto.slice(0, 500)}»\n\nPaula te prepara la respuesta.`);
  await log('sistema', T`ha recibido un mensaje por ${canal} de ${nombre}: «${texto.slice(0, 140)}»`, { empresa_id: chat.empresa_id || undefined });
}

async function enviarTexto(chat, texto, { auto = false } = {}) {
  if (chat.canal === 'telegram') {
    const r = await tg('sendMessage', { chat_id: chat.chat_id, text: texto, disable_web_page_preview: true });
    if (!r.ok) throw new Error(T`Telegram no ha enviado el mensaje: ${r.description || 'error'}`);
  } else throw new Error(T`Canal ${chat.canal} aún no disponible.`);
  await q(`INSERT INTO mensajes_chat (chat, direccion, texto, auto) VALUES ($1,'salida',$2,$3)`, [chat.id, texto, auto]);
}

/** El hilo de un chat, para Paula y para el panel. */
export async function hilo(chatId, limite = 30) {
  const chat = (await q(`SELECT * FROM chats WHERE id=$1`, [chatId])).rows[0];
  if (!chat) throw new Error(T`No existe el chat ${chatId}`);
  const ms = (await q(`SELECT direccion, texto, auto, creado FROM mensajes_chat WHERE chat=$1 AND direccion IN ('entrada','salida') ORDER BY id DESC LIMIT $2`, [chatId, limite])).rows.reverse();
  return { chat: { id: chat.id, canal: chat.canal, nombre: chat.nombre, empresa_id: chat.empresa_id }, mensajes: ms.map(m => ({ de: m.direccion === 'entrada' ? chat.nombre : (m.auto ? 'Acuse automático' : 'Dirección'), texto: m.texto, cuando: m.creado })) };
}

/** Paula prepara una respuesta: va a la mesa de Dirección con el botón «Enviar». */
export async function prepararRespuesta({ agente, chatId, texto }) {
  const chat = (await q(`SELECT * FROM chats WHERE id=$1`, [chatId])).rows[0];
  if (!chat) throw new Error(T`No existe el chat ${chatId}`);
  if (!String(texto || '').trim()) throw new Error(T('Falta el texto de la respuesta.'));
  const b = (await q(`INSERT INTO mensajes_chat (chat, direccion, texto) VALUES ($1,'borrador',$2) RETURNING id`, [chat.id, String(texto).trim().slice(0, 4000)])).rows[0];
  const aprobaciones = await import('./aprobaciones.js');
  const ultimos = (await hilo(chat.id, 6)).mensajes.map(m => `${m.de}: ${m.texto}`).join('\n');
  return aprobaciones.crear({
    agente, tipo: 'respuesta', empresa_id: chat.empresa_id, ref: `chat:${b.id}`,
    titulo: T`ha preparado la respuesta por ${chat.canal} a ${chat.nombre}`,
    texto: `CONVERSACIÓN (no se envía)\n${ultimos}\n\nRESPUESTA POR ${chat.canal.toUpperCase()}\n${String(texto).trim()}`,
    opciones: [{ r: 'enviar', t: `📨 Enviar por ${chat.canal === 'telegram' ? 'Telegram' : chat.canal}` }, { r: 'cambios' }, { r: 'descartada', t: 'Descartar' }],
    importancia: 'alta', motivo: 'Un contacto que nos ha escrito: contestar el mismo día',
  });
}

/** Dirección pulsa «Enviar». */
export async function enviarBorrador(borradorId) {
  const b = (await q(`SELECT m.*, c.canal, c.chat_id, c.nombre, c.empresa_id FROM mensajes_chat m JOIN chats c ON c.id=m.chat WHERE m.id=$1 AND m.direccion='borrador'`, [borradorId])).rows[0];
  if (!b) throw new Error(T('Esa respuesta ya no existe o ya se envió.'));
  await enviarTexto({ id: b.chat, canal: b.canal, chat_id: b.chat_id }, b.texto);
  await q(`UPDATE mensajes_chat SET direccion='enviado' WHERE id=$1`, [borradorId]);
  await log('dueno', T`ha contestado por ${b.canal} a ${b.nombre}.`, { empresa_id: b.empresa_id || undefined });
}
