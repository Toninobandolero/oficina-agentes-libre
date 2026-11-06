// Conexión con los modelos de IA. Cada agente usa su propio modelo.
//
// Proveedores (se eligen en el panel: Configuración → Inteligencia artificial; ver ia.js):
//  - Claude (API de Anthropic), el principal. Con un plan Max, se gastan los créditos de API que incluye el plan; sin él,
//    el saldo que se compre en la Console. Los modelos se siguen escribiendo como «anthropic/claude-haiku-5.5».
//  - OpenRouter: alternativa de pago por uso. Puede ser el principal, o el RESPALDO: si se acaba el crédito de Claude y
//    el respaldo está activado, la oficina sigue con OpenRouter, avisa, y cada pocas horas vuelve a probar con Claude.
//    Mientras haya crédito de Claude, OpenRouter no se usa (salvo para modelos que no son de Anthropic, si alguien los elige).
//
// El resto del código habla siempre el mismo idioma (mensajes y herramientas en el formato de OpenAI/OpenRouter);
// aquí se traduce a la API de Anthropic cuando toca.
import { config } from './config.js';

export class ErrorLLM extends Error {
  constructor(mensaje, status, extra = {}) { super(mensaje); this.status = status; Object.assign(this, extra); }
}

const espera = ms => new Promise(r => setTimeout(r, ms));

// ---------- Respaldo: sin crédito de Claude → OpenRouter durante un rato, y se vuelve a probar con Claude ----------
const REINTENTO_CLAUDE_MS = 6 * 3600_000;
const respaldo = { hasta: 0, desde: null };
const hayRespaldo = () => Boolean(config.respaldoOpenrouter && config.openrouterKey);
/** Estado del respaldo para el panel. */
export const estadoRespaldo = () => ({ activo: Date.now() < respaldo.hasta, desde: respaldo.desde, hasta: respaldo.hasta ? new Date(respaldo.hasta).toISOString() : null });
export function _reiniciarRespaldo() { respaldo.hasta = 0; respaldo.desde = null; }   // al cambiar las claves
export function _caducarRespaldo() { respaldo.hasta = 0; }                           // pruebas: «ya toca» volver a probar con Claude

async function avisarCambio(texto) {
  try {
    const [{ log }, telegram] = await Promise.all([import('./bus.js'), import('./telegram.js')]);
    await log('sistema', texto);
    await telegram.avisar(texto);
  } catch (e) { console.error('Aviso de IA:', e.message); }
}

/** JSON de la petición sin medios emojis: un texto recortado con .slice() puede partir un emoji (par sustituto) y dejar
 *  media mitad suelta; la API de Claude rechaza ese JSON («unexpected end of hex escape»). toWellFormed la cambia por «�». */
export const jsonSano = o => JSON.stringify(o, (k, v) => (typeof v === 'string' ? v.toWellFormed() : v));
export const esDeAnthropic = modelo => /^anthropic\//.test(String(modelo));
export const MODELO_CLAUDE = 'anthropic/claude-sonnet-5.5';
const avisados = new Set();
/** Proveedor que atiende un modelo: «anthropic» o «openrouter». */
export function proveedorDe(modelo) {
  if (config.proveedor !== 'anthropic' || !/^anthropic\//.test(String(modelo))) return 'openrouter';
  return Date.now() < respaldo.hasta && hayRespaldo() ? 'openrouter' : 'anthropic';
}
/** ¿Hay alguna clave de IA configurada? */
export const hayIA = () => Boolean(config.anthropicKey || config.openrouterKey);

/**
 * Llama a un modelo. Devuelve { mensaje, fin, uso, coste, citas, busquedas } (coste en USD).
 *  - mensaje: { content, tool_calls? } en formato OpenAI; fin: 'stop' | 'tool_calls' | 'length'…
 *  - busquedaWeb: { max } para que el modelo busque en la web (Exa en OpenRouter, búsqueda web de Claude en Anthropic);
 *    las fuentes vuelven en «citas»: [{ url, titulo, extracto }].
 * Reintenta solo errores transitorios (429, 5xx, red).
 */
export async function llamar(opciones) {
  // Con Claude elegido, todo va a Claude: un modelo de otro proveedor se cambia por Sonnet (no se va a OpenRouter sin avisar)
  if (config.proveedor === 'anthropic' && !esDeAnthropic(opciones.modelo)) {
    if (!avisados.has(opciones.modelo)) { avisados.add(opciones.modelo); console.warn(`IA: ${opciones.modelo} no es de Anthropic; con Claude se usa ${MODELO_CLAUDE}.`); }
    opciones = { ...opciones, modelo: MODELO_CLAUDE };
  }
  if (proveedorDe(opciones.modelo) === 'anthropic') {
    if (!config.anthropicKey) throw new ErrorLLM('Falta la clave de Claude: pégala en el panel (Configuración → Inteligencia artificial).', 401);
    try {
      const r = await llamarAnthropic(opciones);
      if (respaldo.desde) {   // venía de estar con el respaldo: ya hay crédito otra vez
        respaldo.hasta = 0; respaldo.desde = null;
        avisarCambio('✅ Vuelve a haber crédito de Claude: la oficina trabaja otra vez con Claude (OpenRouter queda en reserva).');
      }
      return r;
    } catch (e) {
      if (!e.sinCredito || !hayRespaldo()) throw e;
      const primeraVez = !respaldo.desde;
      respaldo.hasta = Date.now() + REINTENTO_CLAUDE_MS;
      respaldo.desde = respaldo.desde || new Date().toISOString();
      if (primeraVez) avisarCambio('🔁 No queda crédito de Claude (saldo agotado, tope de gasto o problema con el pago). La oficina sigue trabajando con OpenRouter (respaldo) y vuelve sola a Claude cuando haya crédito. Si prefieres pararla: /pausa.');
      return llamarOpenRouter(opciones);
    }
  }
  if (!config.openrouterKey) {
    throw new ErrorLLM(config.proveedor === 'anthropic'
      ? `El modelo ${opciones.modelo} no es de Anthropic y solo funciona con OpenRouter: pega su clave en el panel (Configuración → Inteligencia artificial) o elige un modelo de Claude.`
      : 'Falta la clave de OpenRouter: pégala en el panel (Configuración → Inteligencia artificial).', 401);
  }
  return llamarOpenRouter(opciones);
}

/** ¿Se puede volver a trabajar? Una llamada mínima, primero con Claude y si no con el respaldo; sin crédito la rechazan y no cuesta nada. */
export async function hayCredito() {
  respaldo.hasta = 0;
  try { await llamar({ modelo: config.modelos.rafa, messages: [{ role: 'user', content: 'Di «ok».' }], maxTokens: 16 }); return true; }
  catch { return false; }
}

/** Convierte las definiciones de herramientas al formato de OpenAI (el que usa todo el código). */
export const herramientaOpenAI = (nombre, def) => ({ type: 'function', function: { name: nombre, description: def.description, parameters: def.input_schema } });

// ===================================================================== OpenRouter

async function llamarOpenRouter({ modelo, system, messages, tools, plugins, busquedaWeb, maxTokens = 6000, razonamiento = null }) {
  const cuerpo = {
    model: modelo,
    max_tokens: maxTokens,
    messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
  };
  if (tools?.length) cuerpo.tools = tools;
  if (busquedaWeb) cuerpo.plugins = [{ id: 'web', engine: 'exa', max_results: busquedaWeb.max || 8 }];
  if (plugins) cuerpo.plugins = plugins;
  if (razonamiento) cuerpo.reasoning = razonamiento;   // p. ej. { max_tokens: 800 }: que pensar no se coma la respuesta

  let ultimo;
  for (let intento = 0; intento < 4; intento++) {
    if (intento) await espera(2000 * 2 ** intento);
    let r;
    try {
      r = await fetch(`${config.openrouterUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.openrouterKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': config.panelUrl || `https://${config.empresa.web || 'localhost'}`,
          'X-Title': 'Oficina de agentes',
        },
        body: jsonSano(cuerpo),
        signal: AbortSignal.timeout(180_000),
      });
    } catch (e) { ultimo = new ErrorLLM(`Sin conexión con OpenRouter: ${e.message}`, 0); continue; }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) {
      const status = r.ok ? (j.error?.code ?? 500) : r.status;
      ultimo = Number(status) === 402
        ? new ErrorLLM('Se ha acabado el saldo de OpenRouter (openrouter.ai → Credits).', 402, { sinCredito: true })
        : new ErrorLLM(`OpenRouter ${status}: ${j.error?.message || r.statusText}`, Number(status) || 500);
      if (status === 429 || status >= 500 || status === 0) continue;
      throw ultimo;                          // 400, 401, 402 (sin saldo), 403, 404…: no se arregla repitiendo
    }
    const c = j.choices?.[0];
    if (!c) { ultimo = new ErrorLLM('Respuesta vacía de OpenRouter', 502); continue; }
    const vistos = new Set();
    const citas = (c.message?.annotations || [])
      .filter(a => a.type === 'url_citation' && a.url_citation?.url)
      .map(a => ({ url: a.url_citation.url, titulo: a.url_citation.title || '', extracto: (a.url_citation.content || '').slice(0, 700) }))
      .filter(x => !vistos.has(x.url) && vistos.add(x.url));
    return { mensaje: c.message || {}, fin: c.finish_reason, uso: { ...(j.usage || {}), proveedor: 'openrouter' }, coste: Number(j.usage?.cost) || 0, citas, busquedas: busquedaWeb || plugins ? 1 : 0 };
  }
  throw ultimo;
}

// ===================================================================== Anthropic

/** «anthropic/claude-sonnet-5.5» → «claude-sonnet-5-5» (el nombre que usa la API de Anthropic). */
export const idAnthropic = modelo => String(modelo).replace(/^anthropic\//, '').replace(/\./g, '-');

// Precios en USD por millón de tokens: [entrada, escritura en caché (5 min), lectura de caché, salida].
// Fuente: platform.claude.com/docs/en/about-claude/pricing (octubre de 2026). Si cambian, se actualizan aquí.
const PRECIOS = [
  { m: /opus-5-5/, p: [4, 5, 0.20, 20] },
  { m: /sonnet-5-5/, p: [2, 2.5, 0.10, 10] },
  { m: /haiku-5-5/, p: [0.10, 0.125, 0.01, 0.50], largo: [0.50, 0.625, 0.05, 2.50] },   // «largo»: prompts de más de 100.000 tokens
  { m: /haiku-4-5/, p: [1, 1.25, 0.10, 5] },
  { m: /sonnet-4/, p: [3, 3.75, 0.30, 15] },
  { m: /opus-4-[5-9]/, p: [5, 6.25, 0.50, 25] },
];
const PRECIO_DESCONOCIDO = [5, 6.25, 0.50, 25];   // modelo que no está en la tabla: se cuenta por lo alto
const PRECIO_BUSQUEDA = 0.01;                     // búsqueda web de Claude: 10 $ cada 1.000

/** Coste en USD de una llamada a partir de lo que devuelve la API de Anthropic. */
export function costeAnthropic(modelo, u = {}) {
  const id = idAnthropic(modelo);
  const entrada = u.input_tokens || 0, escritura = u.cache_creation_input_tokens || 0, lectura = u.cache_read_input_tokens || 0, salida = u.output_tokens || 0;
  const fila = PRECIOS.find(x => x.m.test(id));
  const prompt = entrada + escritura + lectura;
  const [pe, pw, pr, ps] = !fila ? PRECIO_DESCONOCIDO : fila.largo && prompt > 100_000 ? fila.largo : fila.p;
  const busquedas = u.server_tool_use?.web_search_requests || 0;
  return (entrada * pe + escritura * pw + lectura * pr + salida * ps) / 1e6 + busquedas * PRECIO_BUSQUEDA;
}

/** Contenido en formato OpenAI (texto o lista de partes) → bloques de Anthropic. Los textos vacíos se quitan. */
function aBloques(contenido) {
  if (contenido == null) return [];
  if (typeof contenido === 'string') return contenido.trim() ? [{ type: 'text', text: contenido }] : [];
  if (!Array.isArray(contenido)) return [{ type: 'text', text: JSON.stringify(contenido) }];
  const out = [];
  for (const p of contenido) {
    if (typeof p === 'string') { if (p.trim()) out.push({ type: 'text', text: p }); continue; }
    if (p?.type === 'text') { if (String(p.text ?? '').trim()) out.push({ type: 'text', text: p.text, ...(p.cache_control ? { cache_control: p.cache_control } : {}) }); continue; }
    if (p?.type === 'image_url') {
      const url = p.image_url?.url || '';
      const d = url.match(/^data:([^;]+);base64,(.*)$/);
      out.push({ type: 'image', source: d ? { type: 'base64', media_type: d[1], data: d[2] } : { type: 'url', url } });
      continue;
    }
    if (p?.type) out.push(p);   // ya viene en formato de Anthropic
  }
  return out;
}

const leerArgs = t => { if (t && typeof t === 'object') return t; try { return JSON.parse(t || '{}'); } catch { return {}; } };

/** Mensajes en formato OpenAI → mensajes de Anthropic (los resultados de herramientas van en el turno del usuario). */
export function mensajesAnthropic(messages = []) {
  const out = [];
  const anadir = (role, bloques) => {
    if (!bloques.length) return;
    const ult = out[out.length - 1];
    if (ult?.role === role) ult.content.push(...bloques); else out.push({ role, content: [...bloques] });
  };
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      const partes = aBloques(m.content);
      const cache = partes.find(b => b.cache_control)?.cache_control;
      const contenido = partes.map(({ cache_control, ...b }) => b);
      anadir('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: contenido.length ? contenido : '(vacío)', ...(cache ? { cache_control: cache } : {}) }]);
    } else if (m.role === 'assistant') {
      const bloques = aBloques(m.content);
      for (const c of m.tool_calls || []) bloques.push({ type: 'tool_use', id: c.id, name: c.function?.name, input: leerArgs(c.function?.arguments) });
      anadir('assistant', bloques.length ? bloques : [{ type: 'text', text: '…' }]);
    } else {
      anadir('user', aBloques(m.content));
    }
  }
  return out;
}

/** Instrucciones de sistema (texto o lista de partes con cache_control) → formato de Anthropic. */
export function sistemaAnthropic(system, messages = []) {
  const extra = messages.filter(m => m.role === 'system').flatMap(m => aBloques(m.content));
  const base = typeof system === 'string' ? aBloques(system) : aBloques(system || []);
  const todo = [...base, ...extra].filter(b => b.type === 'text');
  return todo.length ? todo : undefined;
}

/** Herramientas en formato OpenAI → formato de Anthropic. */
export const herramientasAnthropic = (tools = []) => tools.map(t => t.function
  ? { name: t.function.name, description: t.function.description || '', input_schema: t.function.parameters || { type: 'object', properties: {} } }
  : t);

const FIN = { end_turn: 'stop', stop_sequence: 'stop', tool_use: 'tool_calls', max_tokens: 'length', pause_turn: 'stop', refusal: 'content_filter' };

/** Respuesta de Anthropic → { mensaje, fin, uso, citas } en el formato que usa el resto del código. */
export function respuestaAnthropic(j) {
  const bloques = j.content || [];
  const texto = bloques.filter(b => b.type === 'text').map(b => b.text).join('').trim();
  const tool_calls = bloques.filter(b => b.type === 'tool_use')
    .map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
  // Fuentes de la búsqueda web: primero las citadas en el texto (traen el fragmento), luego el resto de resultados
  const vistos = new Map();
  for (const b of bloques.filter(x => x.type === 'text')) {
    for (const c of b.citations || []) {
      if (!c.url) continue;
      const x = vistos.get(c.url) || { url: c.url, titulo: c.title || '', extracto: '' };
      if (c.cited_text && x.extracto.length < 700) x.extracto = (x.extracto ? x.extracto + ' … ' : '') + c.cited_text;
      vistos.set(c.url, x);
    }
  }
  let errorBusqueda = null;
  for (const b of bloques.filter(x => x.type === 'web_search_tool_result')) {
    if (!Array.isArray(b.content)) { errorBusqueda = b.content?.error_code || 'error'; continue; }
    for (const r of b.content) if (r.url && !vistos.has(r.url)) vistos.set(r.url, { url: r.url, titulo: r.title || '', extracto: '' });
  }
  const citas = [...vistos.values()].map(x => ({ ...x, extracto: x.extracto.slice(0, 700) }));
  const u = j.usage || {};
  const uso = {
    prompt_tokens: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
    completion_tokens: u.output_tokens || 0,
    cache_read_tokens: u.cache_read_input_tokens || 0,
    cache_write_tokens: u.cache_creation_input_tokens || 0,
    proveedor: 'anthropic',
  };
  return {
    mensaje: { role: 'assistant', content: texto || null, ...(tool_calls.length ? { tool_calls } : {}) },
    fin: FIN[j.stop_reason] || j.stop_reason || 'stop',
    uso, citas, errorBusqueda, busquedas: u.server_tool_use?.web_search_requests || 0,
  };
}

/** Las formas en que Claude deja de dar servicio por dinero (platform.claude.com/docs/en/api/errors). Ninguna se arregla repitiendo. */
function corteDeCredito(status, error) {
  const texto = String(error?.message || '');
  if (/credit balance is too low/i.test(texto)) return 'Se ha acabado el crédito de la API de Claude. Con el plan Max llega más con el siguiente pago del plan; también se puede añadir saldo en platform.claude.com o activar OpenRouter como respaldo (Configuración → Inteligencia artificial).';
  if (error?.details?.error_code === 'enforced_spend_limit_reached' || /you have reached your .*api usage limits/i.test(texto)) return 'Claude ha cortado el servicio: la cuenta ha llegado a un tope de gasto (platform.claude.com → Billing). Vuelve al subir el tope o al empezar el mes siguiente.';
  if (status === 402 || error?.type === 'billing_error') return 'Claude ha cortado el servicio: hay un problema con el pago de la cuenta (platform.claude.com → Billing).';
  return null;
}

async function llamarAnthropic({ modelo, system, messages, tools, busquedaWeb, plugins, maxTokens = 6000 }) {
  // «razonamiento» (pensar antes de responder) no se activa aquí: estas tareas no lo necesitan y así no gasta tokens.
  const cuerpo = { model: idAnthropic(modelo), max_tokens: maxTokens, messages: mensajesAnthropic(messages) };
  const sys = sistemaAnthropic(system, messages);
  if (sys) cuerpo.system = sys;
  const herramientas = herramientasAnthropic(tools);
  const buscar = busquedaWeb || (plugins?.some(p => p.id === 'web') ? { max: plugins.find(p => p.id === 'web').max_results } : null);
  if (buscar) herramientas.push({ type: config.herramientaBusqueda, name: 'web_search', max_uses: 1 });
  if (herramientas.length) cuerpo.tools = herramientas;

  let ultimo;
  for (let intento = 0; intento < 4; intento++) {
    if (intento) await espera(2000 * 2 ** intento);
    let r;
    try {
      r = await fetch(`${config.anthropicUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': config.anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: jsonSano(cuerpo),
        signal: AbortSignal.timeout(180_000),
      });
    } catch (e) { ultimo = new ErrorLLM(`Sin conexión con la API de Claude: ${e.message}`, 0); continue; }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.type === 'error') {
      const status = r.ok ? 500 : r.status;
      const texto = j.error?.message || r.statusText;
      const corte = corteDeCredito(status, j.error);
      if (corte) throw new ErrorLLM(corte, 402, { sinCredito: true });
      ultimo = new ErrorLLM(`API de Claude ${status}: ${texto}`, status);
      if (status === 429 || status >= 500) continue;   // 529 = saturada: se reintenta
      throw ultimo;                                     // 400, 401, 403, 404, 413…
    }
    const out = respuestaAnthropic(j);
    if (buscar && out.errorBusqueda && !out.citas.length) {
      throw new ErrorLLM(`La búsqueda web de Claude ha fallado (${out.errorBusqueda}). Si dice que no está permitida, actívala en platform.claude.com (Seguridad y datos).`, 403);
    }
    return { ...out, coste: costeAnthropic(modelo, j.usage) };
  }
  throw ultimo;
}
