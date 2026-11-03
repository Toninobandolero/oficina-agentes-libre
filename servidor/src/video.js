// Vídeo vertical a partir de un guion de Álex: texto animado con la marca, sin voz. Lo pide Dirección desde la tarjeta.
// Aquí, el guion, el diseño y el estado; el trabajo pesado, en otro proceso (videoRender.js) para no parar el servidor.
// ponytail: el MP4 va en Postgres, como las imágenes de los posts (sobrevive a un redespliegue sin montar nada). Vale para 1–3 MB por vídeo; si crecen, a un volumen.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { q } from './db.js';
import { emitir, log, panelAbierto } from './bus.js';
import { bloques, avisar } from './telegram.js';
import { cabecera, esc, opcionesPng, partir, sobreColor } from './disenio.js';
import * as marca from './marca.js';
import * as miEmpresa from './empresa.js';
import { AGENTES } from './agentes.js';

const RENDER = fileURLToPath(new URL('./videoRender.js', import.meta.url));
const W = 1080, H = 1920, ANCHO_TEXTO = 880, ALTO_TEXTO = 1060, CENTRO_TEXTO = 860, Y_WEB = H - 380;
const TOPE = { escenas: 30, segundos: 90, frase: 200, palabra: 30, minimo: 1, maximo: 15 };
const LIMITE = 5 * 60_000;
// Ancho de las letras en em, medido con las dos de la marca: así ninguna línea se sale de la pantalla
const EM = { serif: { may: 0.7, min: 0.52, otro: 0.34 }, sans: { may: 0.72, min: 0.55, otro: 0.37 } };
const anchoEm = (t, e) => [...t].reduce((n, ch) => n + (/\p{Lu}/u.test(ch) ? e.may : /\p{Ll}|\d/u.test(ch) ? e.min : e.otro), 0);

/** Lee el bloque ESCENAS DEL VÍDEO del guion: una escena por línea, «frase | frase en color | segundos». Si algo no vale, { error } dice qué. */
export function leerEscenas(texto) {
  const b = bloques(texto).find(x => /^ESCENAS/.test(x.titulo));
  if (!b?.cuerpo) return { error: 'El guion no trae el bloque ESCENAS DEL VÍDEO.' };
  const escenas = [];
  for (const l of b.cuerpo.split('\n').map(s => s.trim()).filter(Boolean)) {
    const c = l.split('|').map(s => s.replace(/\p{Extended_Pictographic}|️/gu, '').trim());
    const mal = motivo => ({ error: `Escena «${l.slice(0, 60)}»: ${motivo}` });
    if (c.length < 2 || c.length > 3) return mal('tiene que ser «frase | frase en color | segundos».');
    const segundos = Number(c.at(-1).replace(',', '.').replace(/\s*s(eg(undos)?)?\.?$/i, ''));
    const frase = c[0], color = c.length === 3 ? c[1] : '';
    if (!c.at(-1) || !(segundos >= TOPE.minimo && segundos <= TOPE.maximo)) return mal(`los segundos tienen que ser un número entre ${TOPE.minimo} y ${TOPE.maximo}.`);
    if (!frase && !color) return mal('no tiene ninguna frase.');
    if ((frase + color).length > TOPE.frase) return mal(`es demasiado larga (máximo ${TOPE.frase} caracteres).`);
    if (new RegExp(`\\S{${TOPE.palabra + 1}}`).test(`${frase} ${color}`)) return mal(`tiene una palabra de más de ${TOPE.palabra} letras.`);
    escenas.push({ frase, color, segundos });
  }
  const total = +escenas.reduce((n, e) => n + e.segundos, 0).toFixed(1);
  if (!escenas.length) return { error: 'El bloque ESCENAS DEL VÍDEO está vacío.' };
  if (escenas.length > TOPE.escenas) return { error: `Son ${escenas.length} escenas y el máximo es ${TOPE.escenas}.` };
  if (total > TOPE.segundos) return { error: `El vídeo duraría ${segundosTxt(total)} s y el máximo es ${TOPE.segundos} s.` };
  return { escenas, total };
}

export const segundosTxt = n => String(n).replace('.', ',');
const colores = m => ({ ...marca.POR_DEFECTO.colores, ...m.colores });
const lienzo = cuerpo => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${cuerpo}</svg>`;

/** Lo que no se mueve: fondo, logo, lema y web. La web y el lema van por encima de lo que tapan las redes en vertical (pie y título). */
export function svgFondo(m = marca.leer()) {
  const c = colores(m), web = m.web || miEmpresa.web(), lema = partir(m.lema || marca.POR_DEFECTO.lema || '', 46);
  const tamWeb = Math.min(30, Math.floor(ANCHO_TEXTO / (web.length * 0.6))), anchoWeb = Math.round(web.length * tamWeb * 0.57 + 64);
  return lienzo(`<rect width="${W}" height="${H}" fill="${c.fondo}"/>
  <circle cx="${W - 60}" cy="240" r="340" fill="${c.circuloA}"/>
  <circle cx="60" cy="${H - 200}" r="300" fill="${c.circuloB}"/>
  <g transform="translate(-50,62) scale(1.5)">${cabecera(m)}</g>
  ${lema.map((l, i) => `<text x="${W / 2}" y="${Y_WEB - 30 - (lema.length - 1 - i) * 40}" text-anchor="middle" font-family="Inter" font-weight="400" font-size="30" fill="${c.pie}">${esc(l)}</text>`).join('')}
  ${web ? `<rect x="${(W - anchoWeb) / 2}" y="${Y_WEB}" width="${anchoWeb}" height="72" rx="36" fill="${c.acento}"/>
  <text x="${W / 2}" y="${Y_WEB + 47}" text-anchor="middle" font-family="Inter" font-weight="600" font-size="${tamWeb}" fill="${sobreColor(c.acento)}">${esc(web)}</text>` : ''}
  <rect y="${H - 20}" width="${W}" height="20" fill="${c.acento}"/>`);
}

/** Tamaño de letra que cabe: grande para una palabra, normal para una frase, y baja hasta que entra. */
function maquetar(frase, color, em) {
  const largo = (frase + color).length;
  for (let tam = largo <= 12 ? 150 : largo <= 90 ? 104 : 88; ; tam -= 8) {
    const medida = s => anchoEm(s, em) * tam;
    const l1 = frase ? partir(frase, ANCHO_TEXTO, medida) : [], l2 = color ? partir(color, ANCHO_TEXTO, medida) : [];
    if (tam <= 40 || ((l1.length + l2.length) * tam * 1.16 <= ALTO_TEXTO && [...l1, ...l2].every(l => medida(l) <= ANCHO_TEXTO))) return { tam, l1, l2 };
  }
}

/** El texto de una escena, sobre transparente: es lo que se anima encima del fondo. */
export function svgEscena({ frase, color }, m = marca.leer()) {
  const c = colores(m), sans = m.letra === 'sans', { tam, l1, l2 } = maquetar(frase, color, sans ? EM.sans : EM.serif), alto = tam * 1.16;
  const y0 = CENTRO_TEXTO - ((l1.length + l2.length) * alto) / 2 + tam * 0.8;
  const linea = (t, n, tinta) => `<text x="90" y="${(y0 + n * alto).toFixed(0)}" font-family="${sans ? 'Inter' : 'Playfair Display'}" font-weight="600" font-size="${tam}" fill="${tinta}">${esc(t)}</text>`;
  return lienzo([...l1.map((t, n) => linea(t, n, c.texto)), ...l2.map((t, n) => linea(t, l1.length + n, c.acento))].join(''));
}

/** Lanza el proceso que hace el vídeo. Pasado el límite, lo para con todo lo que haya lanzado él (ffmpeg). */
function renderizar(dir, limite) {
  return new Promise((ok, mal) => {
    const h = spawn(process.execPath, [RENDER, dir], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '', parado = false;
    const t = setTimeout(() => { parado = true; try { process.kill(-h.pid, 'SIGKILL'); } catch {} }, limite);
    h.stderr.on('data', d => { err = (err + d).slice(-600); });
    h.on('error', e => { clearTimeout(t); mal(e); });
    h.on('close', codigo => {
      clearTimeout(t);
      if (parado) mal(new Error(`Ha tardado más de ${Math.max(1, Math.round(limite / 60_000))} min y se ha parado.`));
      else if (codigo === 0) ok();
      else mal(new Error(err.trim().split('\n').pop() || `El proceso ha fallado (código ${codigo}).`));
    });
  });
}

/** Lo que el panel necesita saber del vídeo de un guion. */
export const ficha = (texto, fila) => ({ estado: fila?.estado ?? null, error: fila?.error ?? null, bytes: fila?.bytes ?? 0, segundos: fila?.segundos ?? null, generado: fila?.generado ?? null, problema: leerEscenas(texto).error ?? null });

const CAMPOS = 'estado, error, octet_length(mp4) AS bytes, segundos, generado';
const leerFila = async id => (await q(`SELECT ${CAMPOS} FROM videos WHERE aprobacion_id=$1`, [id])).rows[0];

/** A las tarjetas de guion de la mesa les añade el estado de su vídeo. */
export async function enTarjetas(aprobaciones) {
  const guiones = aprobaciones.filter(a => a.clase === 'video');
  if (!guiones.length) return aprobaciones;
  const filas = new Map((await q(`SELECT aprobacion_id, ${CAMPOS} FROM videos WHERE aprobacion_id = ANY($1::text[])`, [guiones.map(a => a.id)])).rows.map(f => [f.aprobacion_id, f]));
  for (const a of guiones) a.video = ficha(a.texto, filas.get(a.id));
  return aprobaciones;
}

export const hayVideo = async id => (await leerFila(id))?.bytes > 0;
export const mp4De = async id => (await q(`SELECT mp4 FROM videos WHERE aprobacion_id=$1 AND mp4 IS NOT NULL`, [id])).rows[0]?.mp4 ?? null;

/** Un reinicio mata el render a medias: que la tarjeta lo diga y se pueda volver a pedir. */
export async function recuperar() {
  await q(`UPDATE videos SET estado='error', error='La oficina se ha reiniciado mientras se generaba. Vuelve a pedirlo.' WHERE estado='generando'`);
}

async function producir(ap, escenas, total, { limite, porTelegram }) {
  const avisoTg = t => (porTelegram || !panelAbierto() ? avisar(t).catch(() => {}) : null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-'));
  const resto = ap.titulo.replace(/^ha preparado /, '');
  try {
    const m = marca.leer();
    fs.writeFileSync(path.join(dir, 'trabajo.json'), JSON.stringify({ font: opcionesPng.font, W, fondo: svgFondo(m), escenas: escenas.map(e => ({ svg: svgEscena(e, m), segundos: e.segundos })) }));
    await renderizar(dir, limite);
    await q(`UPDATE videos SET estado='listo', error=NULL, mp4=$2, segundos=$3, generado=now() WHERE aprobacion_id=$1`, [ap.id, fs.readFileSync(path.join(dir, 'video.mp4')), total]);
    await emitir({ tipo: 'video', id: ap.id, video: ficha(ap.texto, await leerFila(ap.id)) });
    await log(ap.agente, `ha generado el vídeo (${segundosTxt(total)} s, sin voz): ${resto}. Está en tu mesa; aún no está publicado.`, { aprobacion_id: ap.id });
    await avisoTg(`🎬 Vídeo listo (${segundosTxt(total)} s): ${resto}. Míralo y descárgalo en tu mesa del panel. Aún no está publicado.`);
  } catch (e) {
    const motivo = String(e.message).slice(0, 400);
    console.error('Vídeo:', motivo);
    await q(`UPDATE videos SET estado='error', error=$2 WHERE aprobacion_id=$1`, [ap.id, motivo]);
    await emitir({ tipo: 'video', id: ap.id, video: ficha(ap.texto, await leerFila(ap.id)) });
    await log('sistema', `no ha podido generar el vídeo (${resto}): ${motivo}`, { aprobacion_id: ap.id });
    await avisoTg(`⚠️ No se ha podido generar el vídeo (${resto}): ${motivo}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// De uno en uno: ffmpeg se come la máquina y el servidor es pequeño
let cola = Promise.resolve();

/** Pide el vídeo de un guion. Vuelve enseguida; el resultado llega con el evento «video» y en la tarjeta. */
export async function generar(id, { limite = LIMITE, porTelegram = false } = {}) {
  const ap = (await q(`SELECT id, agente, tipo, titulo, texto, estado FROM aprobaciones WHERE id=$1`, [id])).rows[0];
  if (!ap || ap.tipo !== 'video' || ap.estado !== 'pendiente') throw Object.assign(new Error('Ese guion ya no está en tu mesa.'), { status: 409 });
  const { escenas, total, error } = leerEscenas(ap.texto);
  if (error) throw new Error(`${error} Pide cambios a ${AGENTES[ap.agente]?.nombre ?? ap.agente} para que lo arregle.`);
  // Dos clics seguidos no lanzan dos vídeos: la segunda vez no cambia ninguna fila
  const nueva = (await q(`INSERT INTO videos (aprobacion_id, estado) VALUES ($1, 'generando')
                          ON CONFLICT (aprobacion_id) DO UPDATE SET estado='generando', error=NULL WHERE videos.estado <> 'generando' RETURNING aprobacion_id`, [id])).rows[0];
  const video = ficha(ap.texto, await leerFila(id));
  if (!nueva) return video;
  await emitir({ tipo: 'video', id, video });
  cola = cola.then(() => producir(ap, escenas, total, { limite, porTelegram })).catch(e => console.error('Vídeo:', e.message));
  return video;
}
