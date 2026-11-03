// Imagen de marca de la empresa (Configuración › Imagen de marca): logo, colores, letra y normas para replicarla.
// Manda en las imágenes de los posts y entra en las instrucciones de los agentes. Lo que no se rellena sale como siempre.
import { ajuste, fijarAjuste } from './db.js';
import { config } from './config.js';

export const POR_DEFECTO = {
  colores: { fondo: '#fbfaf8', circuloA: '#e3edf5', circuloB: '#e3e8e2', texto: '#3a2f28', acento: '#2f6f9f', pie: '#64564d' },
  web: config.empresa.web, lema: config.empresa.lema,
};
const TEXTOS = { nombre: 120, web: 60, lema: 120, tipografias: 400, normas: 4000 };
const NOMBRE_COLOR = { fondo: 'fondo', texto: 'titulares', acento: 'acento', pie: 'texto pequeño', circuloA: 'forma de fondo 1', circuloB: 'forma de fondo 2' };
let marca = {}, logo = null;

export async function cargar() {
  marca = (await ajuste('marca', null)) || {};
  logo = await ajuste('marca_logo', null);
  return marca;
}
export const leer = () => ({ ...marca, logo: Boolean(logo) });
export const logoUri = () => logo;

/** Deja solo lo válido. Un color igual al de siempre no cuenta como cambio. */
export function limpiar(d = {}) {
  const r = { colores: {}, letra: d.letra === 'sans' ? 'sans' : 'serif' };
  for (const [c, def] of Object.entries(POR_DEFECTO.colores)) {
    const v = String(d.colores?.[c] ?? '').toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(v) && v !== def) r.colores[c] = v;
  }
  for (const [c, max] of Object.entries(TEXTOS)) r[c] = String(d[c] ?? '').trim().slice(0, max);
  r.web = r.web.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  return r;
}

export async function guardar(d) {
  marca = limpiar(d);
  await fijarAjuste('marca', marca);
  return leer();
}

export async function ponerLogo(uri) {
  logo = uri;
  await fijarAjuste('marca_logo', uri);
  return leer();
}

/** Bloque para las instrucciones de los agentes. Vacío si no hay nada definido. */
export function paraPrompt() {
  const col = Object.entries(marca.colores || {}).map(([k, v]) => `${NOMBRE_COLOR[k]} ${v}`).join(', ');
  const l = [col && `- Colores: ${col}`, marca.tipografias && `- Tipografías: ${marca.tipografias}`, marca.lema && `- Lema: ${marca.lema}`,
    marca.web && `- Web que se enseña: ${marca.web}`, marca.normas && `- Normas de uso: ${marca.normas}`].filter(Boolean);
  if (!l.length) return '';
  return `\n\n## Imagen de marca (lo que Dirección ha definido en Configuración: respétala en todo lo visual)\n${l.join('\n')}\nLas imágenes de los posts y los vídeos salen solos con esta marca: tú solo das las frases.\n`;
}
