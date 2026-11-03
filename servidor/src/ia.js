// Claves de la IA, pegadas por Dirección en el panel (Configuración → Inteligencia artificial). Se guardan cifradas.
// Lo que se pega en el panel manda sobre el .env (ANTHROPIC_API_KEY, OPENROUTER_API_KEY, PROVEEDOR_IA, RESPALDO_OPENROUTER).
//  - Claude (API de Anthropic): lo recomendado. Con un plan Max, el gasto sale de los créditos de API que incluye el plan;
//    sin plan Max, del saldo que se compre en la Console.
//  - OpenRouter: pago por uso. Puede ser el principal o el respaldo: si se acaba el crédito de Claude, la oficina sigue con
//    OpenRouter y vuelve sola a Claude cuando hay crédito (ver llm.js). Mientras haya crédito de Claude, no se usa.
import crypto from 'node:crypto';
import { ajuste, fijarAjuste } from './db.js';
import { config } from './config.js';
import { log } from './bus.js';

const clave = () => crypto.createHash('sha256').update('acp-ia:' + config.claveCifrado).digest();
export function cifrar(t) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', clave(), iv);
  const d = Buffer.concat([c.update(t, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), d].map(b => b.toString('base64')).join('.');
}
export function descifrar(s) {
  const [iv, tag, d] = s.split('.').map(x => Buffer.from(x, 'base64'));
  const c = crypto.createDecipheriv('aes-256-gcm', clave(), iv); c.setAuthTag(tag);
  return Buffer.concat([c.update(d), c.final()]).toString('utf8');
}

const PROVEEDORES = ['anthropic', 'openrouter'];
const NOMBRE = { anthropic: 'Claude (API de Anthropic)', openrouter: 'OpenRouter' };
// Lo guardado en el panel (ya descifrado) y lo que venía del .env al arrancar
let panel = { proveedor: null, anthropic: null, openrouter: null, respaldo: null };
const env = { anthropic: config.anthropicKey, openrouter: config.openrouterKey, proveedor: PROVEEDORES.includes(config.proveedorIndicado) ? config.proveedorIndicado : null, respaldo: config.respaldoOpenrouter };

/** Recalcula qué clave y qué proveedor se usan: primero lo del panel, si no, lo del .env. */
function aplicar() {
  config.anthropicKey = panel.anthropic || env.anthropic || '';
  config.openrouterKey = panel.openrouter || env.openrouter || '';
  const elegido = panel.proveedor || env.proveedor;
  config.proveedor = PROVEEDORES.includes(elegido) ? elegido : (config.anthropicKey || !config.openrouterKey ? 'anthropic' : 'openrouter');
  config.respaldoOpenrouter = typeof panel.respaldo === 'boolean' ? panel.respaldo : env.respaldo;
}

/** Al arrancar: lee las claves guardadas en el panel. */
export async function cargar() {
  const g = await ajuste('ia', null);
  const leer = s => { try { return s ? descifrar(s) : null; } catch { console.error('No se pudo leer una clave de IA guardada (¿ha cambiado CLAVE_CIFRADO?)'); return null; } };
  panel = { proveedor: PROVEEDORES.includes(g?.proveedor) ? g.proveedor : null, anthropic: leer(g?.anthropic), openrouter: leer(g?.openrouter),
    respaldo: typeof g?.respaldo === 'boolean' ? g.respaldo : null };
  aplicar();
}

async function guardarPanel() {
  await fijarAjuste('ia', {
    proveedor: panel.proveedor,
    anthropic: panel.anthropic ? cifrar(panel.anthropic) : null,
    openrouter: panel.openrouter ? cifrar(panel.openrouter) : null,
    respaldo: panel.respaldo,
  });
  aplicar();
  (await import('./llm.js'))._reiniciarRespaldo();   // con claves nuevas, se vuelve a probar con Claude enseguida
}

/** Comprueba que la clave funciona antes de guardarla (no gasta nada: solo lista modelos o lee la clave). */
async function probar(cual, k) {
  let r;
  try {
    r = cual === 'anthropic'
      ? await fetch(`${config.anthropicUrl}/v1/models?limit=1`, { headers: { 'x-api-key': k, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(15000) })
      : await fetch(`${config.openrouterUrl}/key`, { headers: { Authorization: `Bearer ${k}` }, signal: AbortSignal.timeout(15000) });
  } catch (e) { throw new Error(`No se ha podido comprobar la clave (${e.message}). Inténtalo otra vez en un rato.`); }
  if (r.status === 401 || r.status === 403) throw new Error(`${NOMBRE[cual]} no acepta esa clave. Cópiala entera otra vez.`);
  if (!r.ok) throw new Error(`${NOMBRE[cual]} respondió ${r.status} al comprobar la clave. Inténtalo otra vez en un rato.`);
}

const FORMATO = { anthropic: /^sk-ant-[A-Za-z0-9_-]{20,}$/, openrouter: /^sk-or-[A-Za-z0-9_-]{20,}$/ };
/** Lo que se cuela al copiar y pegar: espacios o saltos de línea en medio, comillas, «ANTHROPIC_API_KEY=» delante. */
// También los invisibles (espacio de ancho cero, guion blando) y los guiones «tipográficos» que pegan algunas webs y notas.
export const limpiarClave = k => String(k ?? '').replace(/^\s*(export\s+)?[A-Z_]*API_KEY\s*[=:]\s*/, '')
  .replace(/[\s"'`​-‍⁠﻿­]/g, '').replace(/[‐-―−]/g, '-');
/** Por qué no encaja, sin enseñar la clave: el principio que tiene, cuánto mide y qué signos raros lleva. */
export function porQue(cual, k) {
  const pre = cual === 'anthropic' ? 'sk-ant-' : 'sk-or-';
  if (!k.startsWith(pre)) return `empieza por «${k.slice(0, Math.min(7, k.length))}…» y debería empezar por «${pre}»`;
  const raros = [...new Set(k.slice(pre.length).replace(/[A-Za-z0-9_-]/g, ''))].map(c => c === ' ' ? 'espacio' : `«${c}» (U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')})`);
  if (raros.length) return `lleva signos que no son de una clave: ${raros.slice(0, 5).join(', ')}`;
  return `es demasiado corta: ${k.length} caracteres`;
}
const ABREVIADA = /[.…•*]/;   // la lista de claves de Anthropic solo enseña el principio y el final: sk-ant-api03-…AbCd
const AYUDA = { anthropic: 'cópiala entera desde platform.claude.com → API keys (empieza por sk-ant-)', openrouter: 'cópiala entera desde openrouter.ai → Keys (empieza por sk-or-)' };

/** Guarda lo que llega del panel: { proveedor?, anthropic?, openrouter? }. Las claves vacías no tocan lo que había. */
export async function guardar(d = {}) {
  const cambios = [];
  // Pegada en la casilla que no era: va a la suya (se reconoce por cómo empieza)
  for (const [de, a, pre] of [['openrouter', 'anthropic', 'sk-ant-'], ['anthropic', 'openrouter', 'sk-or-']])
    if (limpiarClave(d[de]).startsWith(pre) && !limpiarClave(d[a])) d = { ...d, [a]: d[de], [de]: '' };
  for (const cual of PROVEEDORES) {
    const k = limpiarClave(d[cual]);
    if (!k) continue;
    if (ABREVIADA.test(k)) throw new Error(`Esa es la clave abreviada que se ve en la lista. La completa solo se enseña una vez, al crearla: crea una nueva en ${cual === 'anthropic' ? 'platform.claude.com → API keys' : 'openrouter.ai → Keys'} y cópiala entera en ese momento.`);
    if (!FORMATO[cual].test(k)) throw new Error(`La clave de ${NOMBRE[cual]} no parece válida (${porQue(cual, k)}): ${AYUDA[cual]}.`);
    await probar(cual, k);
    panel[cual] = k;
    cambios.push(`la clave de ${NOMBRE[cual]}`);
  }
  if (d.proveedor !== undefined && d.proveedor !== null && d.proveedor !== '') {
    if (!PROVEEDORES.includes(d.proveedor)) throw new Error('Elige Claude u OpenRouter.');
    if (d.proveedor !== panel.proveedor) cambios.push(`que trabajen con ${NOMBRE[d.proveedor]}`);
    panel.proveedor = d.proveedor;
  }
  if (typeof d.respaldo === 'boolean') {
    if (d.respaldo !== config.respaldoOpenrouter) cambios.push(d.respaldo ? 'OpenRouter como respaldo si se acaba el crédito de Claude' : 'sin respaldo de OpenRouter');
    panel.respaldo = d.respaldo;
  }
  const elegido = panel.proveedor || env.proveedor || null;
  const tiene = cual => Boolean(panel[cual] || env[cual]);
  if (elegido && !tiene(elegido)) throw new Error(`Para usar ${NOMBRE[elegido]} pega primero su clave.`);
  await guardarPanel();
  if (cambios.length) await log('dueno', `ha configurado la IA de la oficina: ${cambios.join(' y ')}.`);
  return estado();
}

/** Quita la clave guardada en el panel de «anthropic» u «openrouter» (si había una en .env, se vuelve a usar esa). */
export async function quitar(cual) {
  if (!PROVEEDORES.includes(cual)) throw new Error('No sé qué clave quitar.');
  panel[cual] = null;
  if (panel.proveedor === cual) panel.proveedor = null;
  await guardarPanel();
  await log('dueno', `ha quitado la clave de ${NOMBRE[cual]} de la oficina.`);
  return estado();
}

/** Lo que ve el panel: nunca la clave entera, solo sus 4 últimos caracteres y de dónde sale. */
export async function estado() {
  const { estadoRespaldo } = await import('./llm.js');
  const info = cual => {
    const k = panel[cual] || env[cual];
    return { conectada: Boolean(k), origen: panel[cual] ? 'panel' : env[cual] ? 'env' : null, final: k ? k.slice(-4) : null };
  };
  const r = estadoRespaldo();
  return { proveedor: config.proveedor, proveedor_panel: panel.proveedor, nombre: NOMBRE[config.proveedor], anthropic: info('anthropic'), openrouter: info('openrouter'),
    listo: Boolean(config.proveedor === 'anthropic' ? config.anthropicKey : config.openrouterKey),
    respaldo: Boolean(config.respaldoOpenrouter), respaldo_listo: Boolean(config.respaldoOpenrouter && config.openrouterKey),
    // Ahora mismo trabajando con OpenRouter porque se acabó el crédito de Claude
    en_respaldo: config.proveedor === 'anthropic' && r.activo && Boolean(config.openrouterKey), respaldo_desde: r.desde };
}
