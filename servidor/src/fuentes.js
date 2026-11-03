// Fuentes con conexión propia: el BORME (datos abiertos del BOE, gratis y sin clave) y Google Places (opcional, con la clave de cada oficina).
import { ajuste, fijarAjuste } from './db.js';
import { config } from './config.js';
import { log } from './bus.js';
import { cifrar, descifrar, limpiarClave } from './ia.js';
import { normalizar } from './empresas.js';

const BOE = 'https://boe.es', PLACES = 'https://places.googleapis.com';
const AGENTE = 'Mozilla/5.0 (compatible; OficinaAgentesBot/1.0)';

let simulado = null;   // pruebas: respuestas sin red
export const _simular = s => { simulado = s; cacheBorme.clear(); };
async function pedir(url, opciones = {}) {
  if (simulado) return simulado(url, opciones);
  const r = await fetch(url, { signal: AbortSignal.timeout(15000), ...opciones, headers: { 'User-Agent': AGENTE, ...opciones.headers } });
  return { status: r.status, texto: await r.text() };
}

// ---------- BORME: actos inscritos por provincia y día. No tiene buscador por nombre: se mira por fechas. ----------
const cacheBorme = new Map();   // ponytail: en memoria, un boletín publicado no cambia; se pierde al reiniciar y se vuelve a pedir
const limpiar = s => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** De la página HTML de un boletín provincial a [{ empresa, texto }]. */
export function actosDeHtml(html) {
  return [...String(html).matchAll(/<h5[^>]*class="articulo"[^>]*>\s*\d+\s*-\s*([\s\S]*?)<\/h5>\s*<p[^>]*class="parrafo"[^>]*>([\s\S]*?)<\/p>/g)]
    .map(m => ({ empresa: limpiar(m[1]).replace(/\.$/, ''), texto: limpiar(m[2]) }));
}

async function documento(id) {
  if (cacheBorme.has(id)) return cacheBorme.get(id);
  const url = `https://www.boe.es/diario_borme/txt.php?id=${id}`;
  const r = await pedir(url);
  if (r.status !== 200) throw new Error(`El BOE respondió ${r.status} al leer ${id}.`);
  const fecha = (id.match(/^BORME-A-(\d{4})-/) || [])[1];   // el día exacto lo pone el sumario; aquí, el año
  const actos = actosDeHtml(r.texto).map(a => ({ ...a, documento: id, url, fecha }));
  cacheBorme.set(id, actos);
  return actos;
}

/** Los actos de una provincia en una fecha (AAAAMMDD). Los días sin boletín (festivos, fines de semana) dan lista vacía. */
async function actosDelDia(fecha, provincia) {
  const r = await pedir(`${BOE}/datosabiertos/api/borme/sumario/${fecha}`, { headers: { Accept: 'application/json' } });
  if (r.status === 404) return [];
  if (r.status !== 200) throw new Error(`El BOE respondió ${r.status} al pedir el sumario del ${fecha}.`);
  const secciones = [].concat(JSON.parse(r.texto)?.data?.sumario?.diario || []).flatMap(d => [].concat(d.seccion || []));
  const items = secciones.filter(s => s.codigo === 'A').flatMap(s => [].concat(s.item || []));
  const quiere = normalizar(provincia);
  const item = items.find(x => normalizar(x.titulo).includes(quiere));
  if (!item) return [];
  const dia = `${fecha.slice(0, 4)}-${fecha.slice(4, 6)}-${fecha.slice(6, 8)}`;
  return (await documento(item.identificador)).map(a => ({ ...a, fecha: dia }));
}

const FILTRO = { constitucion: /Constituci[oó]n/i, nombramientos: /Nombramientos|Reelecciones|Ceses/i };
const fechaMadrid = d => new Intl.DateTimeFormat('en-CA', { timeZone: config.zona, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d).replaceAll('-', '');

export async function consultarBorme({ empresa, tipo = 'todo', dias = 5, provincia, documento: doc } = {}) {
  const lugar = String(provincia || config.bormeProvincia).trim();
  const quiere = empresa ? normalizar(String(empresa)) : '';
  const vale = a => (!quiere || normalizar(a.empresa).includes(quiere)) && (!FILTRO[tipo] || FILTRO[tipo].test(a.texto));
  const salida = (actos, mirados) => ({ provincia: lugar, dias_mirados: mirados, actos: actos.slice(0, 25).map(a => ({ ...a, texto: a.texto.slice(0, 700) })), hay_mas: actos.length > 25,
    fuente: 'BORME, Agencia Estatal BOE',
    nota: 'De una persona, guarda solo nombre y cargo del administrador; el socio único no. Pon la URL del boletín en fuente. El BORME no busca por nombre: mira por fechas. Para un acto antiguo, encuéntralo con buscar_web y pásame su identificador (BORME-A-…) en documento.' });
  if (doc) {
    if (!/^BORME-A-\d{4}-\d+-\d+$/.test(doc)) throw new Error('El documento tiene la forma BORME-A-2026-211-29.');
    return salida((await documento(doc)).filter(vale), 0);
  }
  if (!lugar) throw new Error('Indica la provincia que quieres mirar: la zona de la empresa está en su ficha.');
  const n = Math.min(Math.max(Number(dias) || 5, 1), 30);
  const actos = [];
  for (let i = 0; i < n && actos.length <= 25; i++) actos.push(...(await actosDelDia(fechaMadrid(new Date(Date.now() - i * 86_400_000)), lugar)).filter(vale));
  return salida(actos, n);
}

// ---------- Google Places: descubrir negocios. Sin clave no se ofrece a nadie. ----------
// Condiciones de Google: sin caché; solo el identificador se puede guardar sin límite. Por eso los resultados no van a la memoria
// de búsquedas y a la ficha pasa lo que se confirme en la web de la empresa.
const CAMPOS = ['id', 'displayName', 'formattedAddress', 'websiteUri', 'nationalPhoneNumber', 'rating', 'userRatingCount', 'businessStatus', 'googleMapsUri'].map(c => `places.${c}`).join(',');
const USD_CONSULTA = 0.035;   // por lo alto: con estos campos, 35 $ cada 1.000 consultas. Lo que Google regala al mes no se descuenta
let claveMaps = null;
export const mapsActivo = () => Boolean(claveMaps);
export const estadoMaps = () => ({ conectado: mapsActivo(), final: claveMaps ? claveMaps.slice(-4) : null, eur_consulta: Math.round(USD_CONSULTA * config.usdEur * 100) / 100 });

export async function cargar() {
  const g = await ajuste('google_maps', null);
  try { claveMaps = g?.clave ? descifrar(g.clave) : null; } catch { claveMaps = null; console.error('No se pudo leer la clave de Google Maps guardada (¿ha cambiado CLAVE_CIFRADO?)'); }
}

async function textSearch(k, cuerpo, campos) {
  const r = await pedir(`${PLACES}/v1/places:searchText`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': k, 'X-Goog-FieldMask': campos }, body: JSON.stringify({ languageCode: 'es', regionCode: 'ES', ...cuerpo }) });
  if (r.status === 400 || r.status === 401 || r.status === 403) throw new Error('Google no acepta esa clave, o la clave no tiene activada «Places API (New)» en su proyecto.');
  if (r.status === 429) throw new Error('Google Maps ha llegado al límite de consultas de esta clave. Sigue con buscar_web.');
  if (r.status !== 200) throw new Error(`Google Maps respondió ${r.status}.`);
  return JSON.parse(r.texto);
}

/** Dirección pega su clave. Se comprueba pidiendo solo identificadores, que Google no cobra. */
export async function conectarMaps(k) {
  k = limpiarClave(k);
  if (!/^AIza[\w-]{30,}$/.test(k)) throw new Error('Esa no parece una clave de Google: empieza por AIza. Créala en console.cloud.google.com con «Places API (New)» activada.');
  await textSearch(k, { textQuery: 'restaurante Madrid', pageSize: 1 }, 'places.id');
  await fijarAjuste('google_maps', { clave: cifrar(k) });
  claveMaps = k;
  await log('dueno', 'ha conectado Google Maps: Lucía y Carmen ya pueden buscar negocios por zona y sector.');
  return estadoMaps();
}
export async function quitarMaps() {
  await fijarAjuste('google_maps', null);
  claveMaps = null;
  await log('dueno', 'ha quitado la clave de Google Maps.');
  return estadoMaps();
}

export async function buscarMaps(consulta) {
  if (!claveMaps) throw new Error('Google Maps no está conectado.');
  const j = await textSearch(claveMaps, { textQuery: consulta, pageSize: 10 }, CAMPOS);
  return { coste_usd: USD_CONSULTA, resultados: (j.places || []).map(p => ({ place_id: p.id, nombre: p.displayName?.text, direccion: p.formattedAddress, web: p.websiteUri, telefono: p.nationalPhoneNumber,
    valoracion: p.rating, opiniones: p.userRatingCount, estado: p.businessStatus, url_maps: p.googleMapsUri })),
    nota: 'Esto es para descubrir. A la ficha solo va place_id como google_place_id y lo que confirmes en la web de la empresa o en otra fuente, con esa otra URL en fuente. Las reseñas y valoraciones de Google no se copian.' };
}
