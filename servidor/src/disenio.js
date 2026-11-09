// Imagen de cada post: fondo, logo arriba, titular con la segunda frase en color, círculos suaves y pie con la web. 1200 × 1200 px.
// Lo que defina la imagen de marca (marca.js) manda sobre estos valores.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import * as marca from './marca.js';
import { textoDelPost } from './linkedin.js';
import { config } from './config.js';
import * as miEmpresa from './empresa.js';
import { T } from './en.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'disenio');
const FUENTES = ['PlayfairDisplay-SemiBold.ttf', 'PlayfairDisplay-Medium.ttf', 'Inter-Regular.ttf', 'Inter-SemiBold.ttf'].map(f => path.join(DIR, f));
const MAX_LOGO = 2 * 1024 * 1024;
let logo = null;
const logoB64 = () => logo ??= '';

export const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Parte un texto en líneas de como mucho «max» caracteres (aprox. al ancho de la letra), o de «max» según lo que diga «medida». */
export function partir(texto, max, medida = s => s.length) {
  const lineas = []; let actual = '';
  for (const p of String(texto).trim().split(/\s+/)) {
    if (!actual) actual = p;
    else if (medida(actual + ' ' + p) <= max) actual += ' ' + p;
    else { lineas.push(actual); actual = p; }
  }
  if (actual) lineas.push(actual);
  return lineas;
}

/** Saca titular y frase destacada de un post: las dos primeras frases (el gancho). */
export function delTexto(texto) {
  const t = textoDelPost(texto || '');
  const frases = t.split(/\n+/).flatMap(l => l.match(/[¿¡]?[^.!?¿¡]*[.!?]+|[^.!?]+$/g) || []).map(s => s.trim()).filter(Boolean);
  return { titular: (frases[0] || t).slice(0, 110), destacado: (frases[1] || '').slice(0, 110) };
}

// Sobre un color de acento muy claro, el texto del botón va oscuro para que se lea
export function sobreColor(hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.7 ? '#1a1a1a' : '#ffffff';
}

/** Arriba de la imagen: el logo de la marca, su nombre o, si no hay ninguno, el de siempre. */
export function cabecera(m) {
  const c = { ...marca.POR_DEFECTO.colores, ...m.colores }, familia = m.letra === 'sans' ? 'Inter' : 'Playfair Display', logoPropio = marca.logoUri();
  return logoPropio ? `<image x="90" y="72" width="480" height="88" preserveAspectRatio="xMinYMid meet" xlink:href="${logoPropio}"/>`
    : m.nombre || !config.empresa.logoPorDefecto ? `<text x="90" y="132" font-family="${familia}" font-weight="600" font-size="42" fill="${c.texto}">${esc(m.nombre || miEmpresa.nombre())}</text>`
    : '';
}

export function svg({ titular, destacado = '' }, m = marca.leer()) {
  const c = { ...marca.POR_DEFECTO.colores, ...m.colores }, web = m.web || miEmpresa.web(), pie = m.lema || marca.POR_DEFECTO.lema || '';
  const sans = m.letra === 'sans', familia = sans ? 'Inter' : 'Playfair Display';
  const W = 1200, total = (titular + ' ' + destacado).length;
  const tam = total < 60 ? 88 : total < 95 ? 76 : total < 130 ? 66 : 58;
  const max = Math.floor(1000 / (tam * (sans ? 0.56 : 0.5)));
  const l1 = partir(titular, max), l2 = destacado ? partir(destacado, max) : [];
  const alto = tam * 1.12, bloque = (l1.length + l2.length) * alto;
  const y0 = Math.max(330, 600 - bloque / 2 + tam * 0.8);
  const linea = (t, i, color) => `<text x="90" y="${(y0 + i * alto).toFixed(0)}" font-family="${familia}" font-weight="600" font-size="${tam}" fill="${color}">${esc(t)}</text>`;
  const texto = [...l1.map((t, i) => linea(t, i, c.texto)), ...l2.map((t, i) => linea(t, l1.length + i, c.acento))].join('');
  const anchoPill = Math.round(web.length * 15 + 56);
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${W}" viewBox="0 0 ${W} ${W}">
  <rect width="${W}" height="${W}" fill="${c.fondo}"/>
  <circle cx="1090" cy="110" r="300" fill="${c.circuloA}"/>
  <circle cx="110" cy="1150" r="250" fill="${c.circuloB}"/>
  ${cabecera(m)}
  ${texto}
  <text x="90" y="1093" font-family="Inter" font-weight="400" font-size="26" fill="${c.pie}">${esc(pie)}</text>
  ${web ? `<rect x="${W - 90 - anchoPill}" y="1052" width="${anchoPill}" height="58" rx="29" fill="${c.acento}"/>
  <text x="${W - 90 - anchoPill / 2}" y="1090" text-anchor="middle" font-family="Inter" font-weight="600" font-size="26" fill="${sobreColor(c.acento)}">${esc(web)}</text>` : ''}
  <rect y="${W - 16}" width="${W}" height="16" fill="${c.acento}"/>
</svg>`;
}

export const opcionesPng = { font: { fontFiles: FUENTES, loadSystemFonts: false, defaultFontFamily: 'Inter' } };

/** PNG listo para publicar. */
export function png(datos, m) {
  const r = new Resvg(svg(datos, m), { ...opcionesPng, fitTo: { mode: 'width', value: 1200 } });
  return Buffer.from(r.render().asPng());
}

/** Comprueba el logo subido y lo deja como data: URI. Un SVG pasa a PNG: así nunca se sirve tal cual. */
export function logoDeSubida(uri) {
  const m = /^data:image\/(png|jpeg|svg\+xml);base64,([A-Za-z0-9+/=]+)$/.exec(String(uri || ''));
  if (!m) throw new Error(T('El logo tiene que ser PNG, JPG o SVG.'));
  const b = Buffer.from(m[2], 'base64');
  if (b.length > MAX_LOGO) throw new Error(T('El logo pesa más de 2 MB.'));
  if (m[1] === 'svg+xml') {
    try { return `data:image/png;base64,${Buffer.from(new Resvg(b.toString('utf8'), { ...opcionesPng, fitTo: { mode: 'width', value: 800 } }).render().asPng()).toString('base64')}`; }
    catch { throw new Error(T('Ese SVG no se puede leer.')); }
  }
  const firma = { png: '89504e47', jpeg: 'ffd8ff' }[m[1]];
  if (b.subarray(0, firma.length / 2).toString('hex') !== firma) throw new Error(T('Ese archivo no es una imagen válida.'));
  return uri;
}

/** El logo en uso, para enseñarlo en el panel. */
export function logoActual() {
  const m = /^data:(.+?);base64,(.+)$/.exec(marca.logoUri() || '');
  if (m) return { tipo: m[1], bytes: Buffer.from(m[2], 'base64') };
  return config.empresa.logoPorDefecto ? { tipo: 'image/png', bytes: Buffer.from(logoB64(), 'base64') } : null;
}
