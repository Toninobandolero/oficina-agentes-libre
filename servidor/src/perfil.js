// Ficha de la empresa y de su dueño (Configuración › Mi empresa). Es lo que el equipo sabe de quién vende y qué vende.
// Se guarda en la base de datos y entra en las instrucciones de todos los agentes. Si la web cambia, se lee y se resume.
import { ajuste, fijarAjuste } from './db.js';
import { config } from './config.js';
import { llamar } from './llm.js';
import * as presupuesto from './presupuesto.js';
import { emitir, log } from './bus.js';

export const CAMPOS = {
  empresa: ['nombre', 'web', 'linkedin', 'otras_redes', 'telefono', 'localidad', 'zona', 'que_vende', 'precios', 'cliente_ideal', 'sectores', 'diferencia', 'casos'],
  dueno: ['nombre', 'presentacion', 'linkedin', 'trayectoria', 'tono', 'evitar'],
  extra: ['texto'],
};
const MAX = 4000;
let perfil = {};

export async function cargar() { perfil = (await ajuste('perfil_empresa', null)) || {}; return perfil; }
export const leer = () => perfil;

/** Guarda lo que Dirección escribe en Configuración. Si la web es nueva o ha cambiado, la lee y la resume en segundo plano. */
export async function guardar(datos = {}) {
  const limpio = { actualizado: new Date().toISOString(), resumen_web: perfil.resumen_web || null, web_leida: perfil.web_leida || null };
  for (const [grupo, campos] of Object.entries(CAMPOS)) {
    limpio[grupo] = {};
    for (const c of campos) limpio[grupo][c] = String(datos?.[grupo]?.[c] ?? '').trim().slice(0, MAX);
  }
  const web = limpio.empresa.web;
  if (web && !/^https?:\/\//i.test(web)) limpio.empresa.web = 'https://' + web;
  perfil = limpio;
  await fijarAjuste('perfil_empresa', perfil);
  await emitir({ tipo: 'perfil' });
  if (perfil.empresa.web && perfil.empresa.web !== perfil.web_leida) leerWeb().catch(e => console.error('Perfil (web):', e.message));
  return perfil;
}

/** Lee la web de la empresa (portada y hasta 3 páginas suyas) y guarda un resumen para el equipo. */
export async function leerWeb() {
  const url = perfil.empresa?.web; if (!url) return null;
  const { leer: leerPagina } = await import('./web.js');
  const portada = await leerPagina(url, { max: 9000 });
  const textoPortada = typeof portada === 'string' ? portada : (portada?.texto || JSON.stringify(portada).slice(0, 9000));
  const prompt = `Esta es la web de una empresa. Resume para su equipo comercial, en 8–12 líneas y en español de España: qué vende (servicios y productos concretos), a quién, en qué zona, precios si aparecen, casos o clientes que cita y qué la diferencia. Solo lo que diga la web; no inventes.\n\nWEB (${url}):\n${textoPortada.slice(0, 9000)}`;
  const r = await llamar({ modelo: config.modelos.rafa, messages: [{ role: 'user', content: prompt }], maxTokens: 3000, razonamiento: { max_tokens: 500 } });
  await presupuesto.registrar('rafa', null, config.modelos.rafa, r.coste, r.uso);
  const resumen = String(r.mensaje.content || '').trim();
  if (!resumen) return null;
  perfil = { ...perfil, resumen_web: resumen.slice(0, MAX), web_leida: url };
  await fijarAjuste('perfil_empresa', perfil);
  await emitir({ tipo: 'perfil' });
  await log('rafa', `ha leído la web de la empresa (${url}) y ha resumido para el equipo lo que vendemos.`);
  return resumen;
}

/** Bloque para las instrucciones de los agentes. Vacío si no hay nada escrito. */
export function paraPrompt() {
  const e = perfil.empresa || {}, d = perfil.dueno || {};
  const l = (t, v) => v ? `- ${t}: ${v}` : '';
  const emp = [l('Nombre', e.nombre), l('Web', e.web), l('LinkedIn de la empresa', e.linkedin), l('Otras redes', e.otras_redes), l('Teléfono de la empresa (el que se da a los clientes y sale al llamar)', e.telefono), l('Zona', e.zona),
    l('Qué vende', e.que_vende), l('Precios', e.precios), l('Cliente ideal', e.cliente_ideal), l('Sectores prioritarios', e.sectores),
    l('Qué la diferencia', e.diferencia), l('Casos y clientes', e.casos)].filter(Boolean);
  const due = [l('Nombre', d.nombre), l('Cómo presentarle', d.presentacion), l('LinkedIn', d.linkedin), l('Trayectoria', d.trayectoria),
    l('Tono al escribir en su nombre', d.tono), l('Lo que NUNCA hay que decir o hacer', d.evitar)].filter(Boolean);
  if (!emp.length && !due.length && !perfil.extra?.texto && !perfil.resumen_web) return '';
  return `\n\n## La empresa y su dueño (lo que Dirección ha escrito en Configuración: manda sobre cualquier otra descripción)\n` +
    (emp.length ? `Empresa:\n${emp.join('\n')}\n` : '') + (due.length ? `Dueño:\n${due.join('\n')}\n` : '') +
    (perfil.extra?.texto ? `Más contexto:\n${perfil.extra.texto}\n` : '') +
    (perfil.resumen_web ? `Lo que dice su web (resumen automático):\n${perfil.resumen_web}\n` : '');
}
