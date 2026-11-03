// Quién es la empresa de esta oficina: lo escrito en Configuración › Mi empresa y, si falta algo, config.empresa.
import { config } from './config.js';
import { leer } from './perfil.js';

export const nombre = () => leer().empresa?.nombre || config.empresa.nombre;
export const web = () => String(leer().empresa?.web || config.empresa.web || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
export const dueno = () => String(leer().dueno?.nombre || '').split('(')[0].trim();
export const actividad = () => config.empresa.actividad || String(leer().empresa?.que_vende || '').split('\n')[0].slice(0, 120);
/** Un texto de config.empresa.textos con el nombre de la empresa puesto. */
export const texto = clave => String(config.empresa.textos?.[clave] || '').replaceAll('{empresa}', nombre());

/** Lo que nunca debe decirse en un texto (config.empresa.veto). Lanza el aviso para que el agente lo corrija. */
export function comprobarVeto(t) {
  const v = config.empresa.veto;
  if (v && v.prohibido.test(String(t || '')) && !v.salvo?.test(String(t || ''))) throw new Error(v.aviso);
}
