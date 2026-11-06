// Los documentos que se mandan a un cliente (diagnóstico, propuesta): un PDF con la marca de la empresa, sus imágenes y gráficos.
// Nuria escribe el contenido y aquí se maqueta, sin gastar IA. Las cifras solo salen con su fuente: mejor sin gráfico que con uno inventado.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { Resvg } from '@resvg/resvg-js';
import { q } from './db.js';
import { config } from './config.js';
import * as marca from './marca.js';

const CARPETA = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../panel/marca');
export const IMAGENES = ['talleres', 'gestion', 'automatizacion', 'turnos', 'reservas'];
const ANCHO = 595.28, ALTO = 841.89, M = 42;
const AVISO_CIFRAS = 'Cifras estimadas con lo que hemos visto de tu negocio. Se afinan contigo en la primera conversación.';

// La letra del PDF solo tiene acentos y signos occidentales: lo demás (emojis, flechas) saldría como basura
const limpio = t => String(t ?? '').replace(/→/g, '>').replace(/[^\n\t\x20-\x7e -ÿ€–—‘’“”…•]/g, '').replace(/[ \t]+/g, ' ').trim();
const corto = (t, n) => { const s = limpio(t); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; };
const lista = (v, n) => (Array.isArray(v) ? v : []).filter(Boolean).slice(0, n);

/** Deja solo lo válido de lo que entrega un agente, con los textos a medida para que quepa. Lo que no trae fuente, no sale. */
export function limpiarDocumento(d = {}) {
  const corto = (x, n) => limpio(x).slice(0, n * 3);   // nunca «…»: lo largo se rechaza al entregarlo, no se corta al maquetar
  const fuente = corto(d.grafico?.fuente, 120);
  const filas = lista(d.grafico?.filas, 5).map(f => ({ etiqueta: corto(f.etiqueta, 40), hoy: Number(f.hoy), despues: f.despues == null || f.despues === '' ? null : Number(f.despues) }))
    .filter(f => f.etiqueta && Number.isFinite(f.hoy) && f.hoy >= 0 && (f.despues == null || (Number.isFinite(f.despues) && f.despues >= 0)));
  return {
    tipo: d.tipo === 'propuesta' ? 'propuesta' : 'diagnostico',
    titulo: corto(d.titulo, 70), para: corto(d.para, 70), gancho: corto(d.gancho, 170), situacion: corto(d.situacion, 420),
    cifras: lista(d.cifras, 3).map(c => ({ valor: corto(c.valor, 14), etiqueta: corto(c.etiqueta, 110), fuente: corto(c.fuente, 80) })).filter(c => c.valor && c.etiqueta && c.fuente),
    grafico: fuente && filas.length ? { titulo: corto(d.grafico.titulo, 60) || 'Dónde se va el tiempo', unidad: corto(d.grafico.unidad, 8), filas, fuente } : null,
    esquema: lista(d.esquema?.hoy, 4).length && lista(d.esquema?.despues, 2).length ? { hoy: lista(d.esquema.hoy, 4).map(x => corto(x, 60)), despues: lista(d.esquema.despues, 2).map(x => corto(x, 90)) } : null,
    puntos: lista(d.puntos, 3).map(p => ({ titulo: corto(p.titulo, 60), texto: corto(p.texto, 170) })).filter(p => p.titulo),
    primero: d.primero?.titulo ? { titulo: corto(d.primero.titulo, 80), texto: corto(d.primero.texto, 300), plazo: corto(d.primero.plazo, 70), precio: corto(d.primero.precio, 40) } : null,
    no_haria: corto(d.no_haria, 200), siguiente: corto(d.siguiente, 130),
    imagen: IMAGENES.includes(d.imagen) ? d.imagen : null,   // sin imagen antes que con una que no pinta nada
  };
}

/** Un texto ya escrito, sin estructura: se parte por sus títulos y lo que es solo para Dirección se queda fuera. */
export function deTexto(texto) {
  const secciones = []; let actual = null;
  const titulo = l => { const t = l.replace(/^#+\s*/, '').replace(/\*\*/g, '').replace(/:$/, '').trim(); const base = t.replace(/\s*\(.*\)\s*$/, ''); return /^#+\s/.test(l) || (base.length >= 3 && t.length < 70 && /[A-ZÁÉÍÓÚÑ]/.test(base) && base === base.toUpperCase()) ? t : null; };
  for (const bruta of String(texto || '').split('\n')) {
    const l = bruta.trim(); if (!l) continue;
    const t = titulo(l);
    if (t) { actual = { titulo: t === t.toUpperCase() ? t.charAt(0) + t.slice(1).toLowerCase() : t, interno: /NOTAS|CONTEXTO|ASUNTO|NO SE ENV|PARA DUENO/i.test(t), lineas: [] }; secciones.push(actual); continue; }
    if (!actual) { actual = { titulo: '', interno: false, lineas: [] }; secciones.push(actual); }
    actual.lineas.push(l.replace(/\*\*/g, ''));
  }
  return secciones.filter(s => !s.interno && s.lineas.length).map(s => ({ titulo: limpio(s.titulo), lineas: s.lineas.map(limpio).filter(Boolean) }));
}

export function logoBuffer() {
  const uri = marca.logoUri();
  const m = String(uri || '').match(/^data:image\/(png|jpe?g|svg\+xml);base64,(.+)$/);
  if (!m) return fs.existsSync(path.join(CARPETA, 'logo.jpg')) ? fs.readFileSync(path.join(CARPETA, 'logo.jpg')) : null;   // el logo y las capturas son de quien monta la oficina: sin ellos el PDF sale igual
  const b = Buffer.from(m[2], 'base64');
  return m[1] === 'svg+xml' ? Buffer.from(new Resvg(b.toString('utf8'), { fitTo: { mode: 'width', value: 400 } }).render().asPng()) : b;
}

// Lo que se ve de cada imagen (quitando su pie, que aquí sobra) y qué es
const FOTOS = {
  talleres: { x: 180, y: 55, w: 840, h: 640, pie: 'Panel de control a medida para talleres' },
  gestion: { x: 175, y: 55, w: 850, h: 640, pie: 'Temporadas, precios y horarios sin Excel' },
  automatizacion: { x: 88, y: 190, w: 1024, h: 372, pie: 'Automatizaciones que conectan tus herramientas' },
  turnos: { x: 88, y: 120, w: 1024, h: 512, pie: 'Cuadrantes de turnos automáticos' },
  reservas: { x: 280, y: 55, w: 640, h: 640, pie: 'Reservas online para un negocio de playa' },
};

/** Una pasada de maquetación. Devuelve dónde acaba, para saber cuánto sitio le queda a las imágenes. */
function maquetar(pdf, d, { empresa, fecha, altoFoto = 0, altoCol = 0, k = 1 }) {
  const col = { ...marca.POR_DEFECTO.colores, ...(marca.leer().colores || {}) };
  const web = marca.leer().web || marca.POR_DEFECTO.web;
  const firma = limpio([marca.leer().nombre || config.correo?.nombre, config.correo?.usuario, web].filter(Boolean).join('  ·  '));
  const anchoUtil = ANCHO - M * 2;
  let paginas = 1;
  const decorar = () => {
    pdf.rect(0, 0, ANCHO, ALTO).fill(col.fondo);
    pdf.circle(ANCHO + 10, -6, 150).fill(col.circuloA);
    pdf.circle(ANCHO - 118, -34, 78).fill(col.circuloB);
    if (k !== 1) { pdf.translate(ANCHO * (1 - k) / 2, 0); pdf.scale(k); }   // si no cabe, todo un poco más pequeño antes que partirlo en dos
  };
  const alto = (t, w, size, font = 'Helvetica', gap = 2) => pdf.font(font).fontSize(size).heightOfString(t, { width: w, lineGap: gap });
  const escribe = (t, x, yy, { w = anchoUtil, size = 10, font = 'Helvetica', color = col.texto, gap = 2, align = 'left', opt = {} } = {}) => {
    pdf.font(font).fontSize(size).fillColor(color).text(t, x, yy, { width: w, lineGap: gap, align, ...opt });
    return yy + alto(t, w, size, font, gap);
  };
  const caja = (x, yy, w, h, color, r = 8) => pdf.roundedRect(x, yy, w, h, r).fill(color);
  // La imagen rellena su hueco sin deformarse; se ve la parte de arriba de la pantalla, que es la que explica qué es
  const foto = (nombre, x, yy, w, h) => {
    const f = FOTOS[nombre] || FOTOS.automatizacion;
    h = Math.min(h, w * f.h / f.w);   // sin cortar por los lados una pantalla más ancha que el hueco
    const escala = Math.max(w / f.w, h / f.h);
    pdf.save(); pdf.roundedRect(x, yy, w, h, 8).clip();
    pdf.image(path.join(CARPETA, `foto-${FOTOS[nombre] ? nombre : 'automatizacion'}.jpg`), x - (f.x + (f.w - w / escala) / 2) * escala, yy - f.y * escala, { width: 1200 * escala });
    pdf.restore();
    pdf.roundedRect(x, yy, w, h, 8).lineWidth(0.6).strokeColor('#e4dcd4').stroke();
    escribe(`Algo parecido que ya hemos hecho: ${f.pie.charAt(0).toLowerCase()}${f.pie.slice(1)}`, x, yy + h + 4, { w, size: 8, color: col.pie, align: 'center' });
  };
  const PIE = 16;
  let y = 0;
  const FIN = (ALTO - 26) / k;
  const llamada = d.siguiente || 'Hablamos 15 minutos, sin compromiso, y lo afinamos con lo que tú sabes de tu negocio.';
  const hCta = alto(llamada, anchoUtil - 32, 12.5, 'Helvetica-Bold', 2) + 40;
  const fuentes = [...new Set([...(d.cifras || []).map(c => c.fuente), d.grafico?.fuente].filter(Boolean))];
  const nota = fuentes.length ? limpio(`${AVISO_CIFRAS} Fuente: ${fuentes.join('; ')}.`) : '';
  const hNota = nota ? alto(nota, anchoUtil, 7, 'Helvetica', 1) + 5 : 0;
  const reservaFinal = hCta + hNota + 10;
  const cabe = h => { if (y + h > FIN - reservaFinal) { pdf.addPage(); paginas++; decorar(); y = 56; } };
  const titulo = (t, x = M, w = anchoUtil) => { y = escribe(t, x, y, { w, size: 12, font: 'Helvetica-Bold' }) + 4; };
  const esPropuesta = d.tipo === 'propuesta';

  decorar();
  const logo = logoBuffer();
  if (logo) pdf.image(logo, M - 8, 14, { height: 54 });
  y = 72;
  y = escribe(esPropuesta ? 'PROPUESTA' : 'DIAGNÓSTICO', M, y, { size: 9, font: 'Helvetica-Bold', color: col.acento, opt: { characterSpacing: 1.6 } }) + 4;
  y = escribe(d.titulo || `Para ${empresa}`, M, y, { w: anchoUtil - 60, size: 23, font: 'Helvetica-Bold', gap: 1 }) + 4;
  const quien = [d.para, empresa, new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Madrid' }).format(fecha)].filter(Boolean).join('  ·  ');
  y = escribe(limpio(quien), M, y, { size: 9.5, color: col.pie }) + 11;

  if (d.gancho) {
    const h = alto(d.gancho, anchoUtil - 30, 12.5, 'Helvetica-Bold', 2.5) + 18;
    caja(M, y, anchoUtil, h, '#ffffff', 6); pdf.rect(M, y, 4, h).fill(col.acento);
    escribe(d.gancho, M + 18, y + 9, { w: anchoUtil - 30, size: 12.5, font: 'Helvetica-Bold', gap: 2.5 });
    y += h + 10;
  }
  // Lo que le pasa, al lado del gráfico si hay de las dos cosas
  const dos = d.situacion && d.grafico, anchoCol = dos ? (anchoUtil - 20) / 2 : anchoUtil, yCols = y;
  if (d.situacion) { titulo('Lo que nos contaste', M, anchoCol); y = escribe(d.situacion, M, y, { w: anchoCol, size: 9.5, gap: 2.2 }) + 9; }
  const yIzq = y;
  if (d.grafico) {
    const xG = dos ? M + anchoCol + 20 : M; if (dos) y = yCols;
    titulo(d.grafico.titulo, xG, anchoCol);
    const max = Math.max(...d.grafico.filas.flatMap(f => [f.hoy, f.despues ?? 0]), 1), anchoBarra = anchoCol - 46, uni = d.grafico.unidad ? ` ${d.grafico.unidad}` : '';
    for (const f of d.grafico.filas) {
      y = escribe(f.etiqueta, xG, y, { w: anchoCol, size: 8.5, color: col.pie }) + 1.5;
      const barra = (v, color) => { const ancho = Math.max(3, v / max * anchoBarra); pdf.roundedRect(xG, y, ancho, 7, 2).fill(color); escribe(`${v.toLocaleString('es-ES')}${uni}`, xG + ancho + 4, y - 0.5, { w: 44, size: 8, font: 'Helvetica-Bold' }); y += 9.5; };
      barra(f.hoy, '#c8bcb2');
      if (f.despues != null) barra(f.despues, col.acento);
      y += 3;
    }
    if (d.grafico.filas.some(f => f.despues != null)) {
      pdf.rect(xG, y + 1, 7, 7).fill('#c8bcb2'); escribe('Hoy', xG + 10, y, { w: 30, size: 7.5, color: col.pie });
      pdf.rect(xG + 34, y + 1, 7, 7).fill(col.acento); escribe('Después', xG + 44, y, { w: 110, size: 7.5, color: col.pie });
      y += 12;
    }
    y = Math.max(y, yIzq) + 6;
  }
  const huecoCol = dos ? y - yIzq : 0;
  if (altoCol) { foto(d.imagen, M, yIzq, anchoCol, altoCol); y = Math.max(y, yIzq + altoCol + PIE + 6); }
  if (d.secciones) {
    for (const s of d.secciones) {
      if (s.titulo) { cabe(38); titulo(s.titulo); }
      for (const l of s.lineas) {
        const vineta = /^[-•*]\s+/.test(l), t = l.replace(/^[-•*]\s+/, ''), anchoT = vineta ? anchoUtil - 12 : anchoUtil;
        cabe(alto(t, anchoT, 10, 'Helvetica', 2.5) + 5);
        if (vineta) pdf.circle(M + 3, y + 5, 1.8).fill(col.acento);
        y = escribe(t, vineta ? M + 12 : M, y, { w: anchoT, size: 10, gap: 2.5 }) + 4;
      }
      y += 6;
    }
  }
  if (d.cifras?.length) {
    const hueco = 10, w = (anchoUtil - hueco * (d.cifras.length - 1)) / d.cifras.length;
    const h = 40 + Math.max(...d.cifras.map(c => alto(c.etiqueta, w - 22, 8.5, 'Helvetica', 1)));
    cabe(h + 24); titulo('Lo que está en juego');
    d.cifras.forEach((c, i) => {
      const x = M + i * (w + hueco);
      caja(x, y, w, h, i % 2 ? col.circuloB : col.circuloA);
      escribe(c.valor, x + 11, y + 8, { w: w - 22, size: c.valor.length > 14 ? 14 : 20, font: 'Helvetica-Bold', color: col.acento });
      escribe(c.etiqueta, x + 11, y + 33, { w: w - 22, size: 8.5, gap: 1 });
    });
    y += h + 10;
  }
  if (altoFoto) { foto(d.imagen, M, y, anchoUtil, altoFoto); y += altoFoto + PIE + 8; }

  if (d.esquema) {
    const wCaja = (anchoUtil - 44) / 2, wHoy = (wCaja - 28) / 2, wDesp = wCaja - 22;
    const altoChip = (t, w) => alto(t, w - 8, 8, 'Helvetica', 1) + 9;
    const filas = (items, w, cols) => { const out = []; for (let i = 0; i < items.length; i += cols) out.push(Math.max(...items.slice(i, i + cols).map(t => altoChip(t, w)))); return out; };
    const fHoy = filas(d.esquema.hoy, wHoy, 2), fDesp = filas(d.esquema.despues, wDesp, 1);
    const h = 28 + Math.max(fHoy.reduce((a, b) => a + b + 4, 0), fDesp.reduce((a, b) => a + b + 4, 0));
    cabe(h + 26); titulo('Cómo cambiaría');
    const pinta = (x, rotulo, items, fondo, color, columnas, alturas) => {
      caja(x, y, wCaja, h, fondo);
      escribe(rotulo, x + 11, y + 8, { w: wCaja - 22, size: 8, font: 'Helvetica-Bold', color, opt: { characterSpacing: 0.8 } });
      const wChip = (wCaja - 22 - (columnas - 1) * 6) / columnas;
      items.forEach((t, i) => {
        const fila = Math.floor(i / columnas), cx = x + 11 + (i % columnas) * (wChip + 6), cy = y + 23 + alturas.slice(0, fila).reduce((a, b) => a + b + 4, 0);
        caja(cx, cy, wChip, alturas[fila], '#ffffff', 5);
        escribe(t, cx + 4, cy + (alturas[fila] - alto(t, wChip - 8, 8, 'Helvetica', 1)) / 2, { w: wChip - 8, size: 8, align: 'center', gap: 1 });
      });
    };
    pinta(M, 'HOY', d.esquema.hoy, col.circuloA, col.pie, 2, fHoy);
    const ax = M + wCaja + 8, ay = y + h / 2;
    pdf.moveTo(ax, ay).lineTo(ax + 20, ay).lineWidth(2.5).strokeColor(col.acento).stroke();
    pdf.moveTo(ax + 28, ay).lineTo(ax + 19, ay - 6).lineTo(ax + 19, ay + 6).closePath().fill(col.acento);
    pinta(M + wCaja + 44, 'DESPUÉS', d.esquema.despues, col.circuloB, col.acento, 1, fDesp);
    y += h + 10;
  }
  if (d.puntos?.length) {
    const hueco = 10, w = (anchoUtil - hueco * (d.puntos.length - 1)) / d.puntos.length;
    const h = Math.max(...d.puntos.map(p => alto(p.titulo, w - 22, 9.5, 'Helvetica-Bold') + alto(p.texto, w - 22, 8.5, 'Helvetica', 1.5))) + 36;
    cabe(h + 24); titulo(esPropuesta ? 'Lo que resolvemos' : 'Dónde se te escapa');
    d.puntos.forEach((p, i) => {
      const x = M + i * (w + hueco);
      caja(x, y, w, h, '#ffffff');
      pdf.circle(x + 19, y + 16, 8).fill(col.acento);
      escribe(String(i + 1), x + 11, y + 12, { w: 16, size: 9, font: 'Helvetica-Bold', color: '#ffffff', align: 'center' });
      const y2 = escribe(p.titulo, x + 11, y + 28, { w: w - 22, size: 9.5, font: 'Helvetica-Bold' }) + 2;
      escribe(p.texto, x + 11, y2, { w: w - 22, size: 8.5, color: col.pie, gap: 1.5 });
    });
    y += h + 10;
  }
  if (d.primero) {
    const chips = [d.primero.plazo && `Plazo: ${d.primero.plazo}`, d.primero.precio && `Orientativo: ${d.primero.precio}`].filter(Boolean).join('      ');
    const ancho = anchoUtil - 26, h = 32 + alto(d.primero.titulo, ancho, 11.5, 'Helvetica-Bold') + alto(d.primero.texto, ancho, 9.5, 'Helvetica', 2.2) + (chips ? 15 : 0);
    cabe(h + 8);
    caja(M, y, anchoUtil, h, col.circuloB);
    let yy = escribe('POR DÓNDE EMPEZARÍAMOS', M + 13, y + 9, { w: ancho, size: 8, font: 'Helvetica-Bold', color: col.acento, opt: { characterSpacing: 0.8 } }) + 3;
    yy = escribe(d.primero.titulo, M + 13, yy, { w: ancho, size: 11.5, font: 'Helvetica-Bold' }) + 2;
    yy = escribe(d.primero.texto, M + 13, yy, { w: ancho, size: 9.5, gap: 2.2 }) + 3;
    if (chips) escribe(chips, M + 13, yy, { w: ancho, size: 8.5, font: 'Helvetica-Bold', color: col.pie });
    y += h + 8;
  }
  if (d.no_haria) {
    const t = `Lo que no haríamos todavía: ${d.no_haria}`;
    cabe(alto(t, anchoUtil, 9, 'Helvetica-Oblique') + 8);
    y = escribe(t, M, y, { size: 9, font: 'Helvetica-Oblique', color: col.pie }) + 8;
  }
  // La llamada a la acción y las fuentes, siempre al pie
  const yLibre = y;
  const yCta = paginas > 1 ? y + 6 : FIN - hNota - hCta;   // en la segunda página, a continuación: sin un hueco en medio
  caja(M, yCta, anchoUtil, hCta, col.acento);
  const yFirma = escribe(llamada, M + 16, yCta + 12, { w: anchoUtil - 32, size: 12.5, font: 'Helvetica-Bold', color: '#ffffff', gap: 2 }) + 5;
  escribe(firma, M + 16, yFirma, { w: anchoUtil - 32, size: 9, color: '#ffffff', opt: { lineBreak: false, height: 12, ellipsis: true } });
  if (nota) escribe(nota, M, yCta + hCta + 5, { size: 7, color: col.pie, gap: 1 });
  return { libre: yCta - 10 - yLibre, huecoCol, paginas };
}

const documentoNuevo = d => new PDFDocument({ size: 'A4', margins: { top: 0, left: 0, right: 0, bottom: -2000 }, autoFirstPage: true, info: { Title: d.titulo || 'Documento', Author: marca.leer().nombre || config.correo?.nombre || '' } });

/** Maqueta el documento. d: lo de limpiarDocumento o { secciones } si viene de un texto. Una primera pasada mide y el sitio que sobra es para las imágenes. */
export function renderizar(d, { empresa = '', fecha = new Date() } = {}) {
  const medir = (o = {}) => { const m = documentoNuevo(d); m.on('data', () => {}); const r = maquetar(m, d, { empresa, fecha, ...o }); m.end(); return r; };
  const PIE_FOTO = 24, m = medir();
  let k = 1, altoFoto = 0, altoCol = 0;
  if (d.imagen && !fs.existsSync(path.join(CARPETA, `foto-${d.imagen}.jpg`))) d = { ...d, imagen: null };
  if (m.paginas > 1) {
    // No cabe: sin imagen y, si hace falta, un poco más pequeño. Un texto largo de verdad sí pasa a otra página
    k = [0.94, 0.88, 0.82].find(x => medir({ k: x }).paginas === 1) || 1;
  } else if (d.imagen) {
    const libres = d.situacion && d.grafico ? m.huecoCol + m.libre - PIE_FOTO : 0;
    if (libres >= 60) altoCol = Math.min(libres, 190);
    else if (m.libre >= 70 + PIE_FOTO) altoFoto = Math.min(m.libre - PIE_FOTO, 215);
  }
  const pdf = documentoNuevo(d), trozos = [];
  const hecho = new Promise((ok, mal) => { pdf.on('data', c => trozos.push(c)); pdf.on('end', () => ok(Buffer.concat(trozos))); pdf.on('error', mal); });
  maquetar(pdf, d, { empresa, fecha, altoFoto, altoCol, k });
  pdf.end();
  return hecho;
}

/** ¿Cabe en una página, con la reducción que admite? */
export function cabeEnUnaPagina(d) {
  return [1, 0.94, 0.88, 0.82].some(k => { const m = documentoNuevo(d); m.on('data', () => {}); const r = maquetar(m, d, { k }); m.end(); return r.paginas === 1; });
}

/** Lo que hay que corregir antes de entregar un documento: si un texto no cabe, lo recorta quien lo escribe, no la maqueta. */
export function revisarDocumento(d = {}) {
  const fallos = [], largo = (t, n, que) => { if (String(t ?? '').length > n) fallos.push(`${que} tiene ${String(t).length} letras y caben ${n}`); };
  if (!d.titulo) fallos.push('falta el titular'); largo(d.titulo, 70, 'el titular'); largo(d.gancho, 170, 'el gancho'); largo(d.situacion, 420, 'lo que nos cuenta');
  for (const c of d.cifras || []) { largo(c.valor, 14, `la cifra «${c.valor}»`); largo(c.etiqueta, 110, `la etiqueta de «${c.valor}»`); }
  for (const x of d.esquema?.hoy || []) largo(x, 60, `«${x}» del esquema`);
  for (const x of d.esquema?.despues || []) largo(x, 90, `«${x}» del esquema`);
  for (const x of d.puntos || []) { largo(x.titulo, 60, `el punto «${x.titulo}»`); largo(x.texto, 170, `el texto de «${x.titulo}»`); }
  largo(d.primero?.titulo, 80, 'lo primero que haríamos'); largo(d.primero?.texto, 300, 'el texto de lo primero'); largo(d.primero?.plazo, 70, 'el plazo'); largo(d.primero?.precio, 40, 'el precio');
  largo(d.no_haria, 200, 'lo que no haríamos'); largo(d.siguiente, 130, 'el siguiente paso');
  return fallos;
}

const imagenPara = sector => { const s = String(sector || '').toLowerCase(); return /moto|taller|automoc|concesion|coche|neum/.test(s) ? 'talleres' : /hostel|restaur|\bbar\b|hotel|cl[ií]nic|comerc/.test(s) ? 'turnos' : /playa|reserv|turis|apartament/.test(s) ? 'reservas' : null; };

/** El PDF de una tarjeta: con su documento, si Nuria lo entregó así, o maquetando su texto. */
/** La imagen la decide el sector, no quien redacta: un trabajo de otro sector resta. El esquema de automatización vale para cualquiera. */
export const imagenParaEmpresa = (pedida, sector) => pedida === 'automatizacion' ? pedida : imagenPara(sector);

export async function deAprobacion(id) {
  const a = (await q(`SELECT a.titulo, a.texto, a.tipo, a.documento, e.nombre AS empresa, e.decisor, e.sector FROM aprobaciones a LEFT JOIN empresas e ON e.id=a.empresa_id WHERE a.id=$1`, [id])).rows[0];
  if (!a) return null;
  let d;
  if (a.documento) { d = limpiarDocumento(a.documento); d.imagen = imagenParaEmpresa(d.imagen, a.sector); }
  else {
    const secciones = deTexto(a.texto), cierre = secciones.findIndex(s => /siguiente paso/i.test(s.titulo));
    const siguiente = cierre >= 0 ? corto(secciones.splice(cierre, 1)[0].lineas.join(' '), 130) : '';
    d = { tipo: /propuesta/i.test(a.titulo || '') ? 'propuesta' : 'diagnostico', titulo: a.empresa ? `Para ${limpio(a.empresa)}` : corto(a.titulo, 70), para: limpio(a.decisor), secciones, siguiente, imagen: imagenPara(a.sector) };
  }
  const datos = await renderizar(d, { empresa: limpio(a.empresa) });
  const base = `${d.tipo === 'propuesta' ? 'Propuesta' : 'Diagnostico'}-${String(a.empresa || 'Documento').normalize('NFD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').slice(0, 50)}`;
  return { nombre: `${base}.pdf`, datos };
}
