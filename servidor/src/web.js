// Búsqueda web (búsqueda de Claude con la API de Anthropic, o Exa con OpenRouter) y lectura de páginas (desde nuestro servidor, gratis).
import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from './config.js';
import { llamar } from './llm.js';
import { T } from './en.js';

/** Busca en la web. Devuelve resultados con URL, título y extracto, y el coste de la búsqueda. */
export async function buscar(consulta, { max = 8 } = {}) {
  const r = await llamar({
    modelo: config.modeloBusqueda,
    messages: [{ role: 'user', content: `Busca en la web: ${consulta}\nResponde solo con una lista breve de lo encontrado (empresa o página y dato clave), sin inventar nada.` }],
    busquedaWeb: { max },
    maxTokens: 800,
  });
  return { resultados: (r.citas || []).slice(0, max), resumen: (r.mensaje.content || '').slice(0, 1500), coste: r.coste, modelo: config.modeloBusqueda, proveedor: r.uso?.proveedor };
}

// ---------- Lectura de páginas con protección: nunca leer la red interna del servidor ----------
function esIpPrivada(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return esIpPrivada(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

async function comprobarUrl(u) {
  let url;
  try { url = new URL(u); } catch { throw new Error(T('URL no válida')); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(T('Solo se pueden leer páginas http o https'));
  if (url.port && !['80', '443'].includes(url.port)) throw new Error(T('Puerto no permitido'));
  if (/^(localhost|.*\.local|.*\.internal|db|oficina)$/i.test(url.hostname)) throw new Error(T('Dirección no permitida'));
  const ips = net.isIP(url.hostname) ? [{ address: url.hostname }] : await dns.lookup(url.hostname, { all: true });
  if (!ips.length || ips.some(x => esIpPrivada(x.address))) throw new Error(T('Dirección no permitida'));
  return url;
}

// Lo que una web lleva por dentro no sale en su texto: un widget de reservas o de chat solo se ve en su código.
const PROGRAMAS = [
  ['reservas', { covermanager: 'CoverManager', 'thefork|lafourchette': 'TheFork', opentable: 'OpenTable', sevenrooms: 'SevenRooms', quandoo: 'Quandoo', zenchef: 'Zenchef', mozrest: 'Mozrest', restoo: 'Restoo', 'roiback': 'Roiback', 'mirai\\.com': 'Mirai', siteminder: 'SiteMinder', cloudbeds: 'Cloudbeds' }],
  ['alquiler vacacional', { avantio: 'Avantio', guesty: 'Guesty', hostaway: 'Hostaway', smoobu: 'Smoobu', lodgify: 'Lodgify', beds24: 'Beds24', icnea: 'Icnea', rentalsunited: 'Rentals United' }],
  ['citas', { doctoralia: 'Doctoralia', calendly: 'Calendly', booksy: 'Booksy', timify: 'Timify', simplybook: 'SimplyBook', acuityscheduling: 'Acuity', treatwell: 'Treatwell' }],
  ['chat', { tidio: 'Tidio', 'intercom\\.io|widget\\.intercom': 'Intercom', 'zdassets|zendesk': 'Zendesk', 'crisp\\.chat': 'Crisp', 'tawk\\.to': 'Tawk', landbot: 'Landbot', manychat: 'ManyChat', chatbase: 'Chatbase', livechatinc: 'LiveChat', 'wa\\.me|api\\.whatsapp': 'WhatsApp' }],
  ['clientes y marketing', { 'hubspot|hs-scripts': 'HubSpot', salesforce: 'Salesforce', pipedrive: 'Pipedrive', 'zoho\\.': 'Zoho', activecampaign: 'ActiveCampaign', mailchimp: 'Mailchimp' }],
  ['tienda', { shopify: 'Shopify', woocommerce: 'WooCommerce', prestashop: 'PrestaShop', magento: 'Magento' }],
];
/** Qué programas se ven en el código de una página. */
export function detectarProgramas(html) {
  const h = String(html || '').toLowerCase(), out = [];
  for (const [para, lista] of PROGRAMAS) for (const [firma, nombre] of Object.entries(lista)) if (new RegExp(firma).test(h)) out.push(`${nombre} (${para})`);
  return out;
}

function aTexto(html) {
  const titulo = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const texto = html
    .replace(/<(script|style|noscript|svg|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|h\d|li|tr|br|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  return { titulo: titulo.trim(), texto };
}

/** Lee una página y devuelve su texto (máx. ~12.000 caracteres). */
export async function leer(u, { max = 12000 } = {}) {
  let url = await comprobarUrl(u);
  for (let saltos = 0; saltos < 4; saltos++) {
    const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { 'User-Agent': `Mozilla/5.0 (compatible; OficinaAgentesBot/1.0${config.empresa.web ? `; +https://${config.empresa.web}` : ''})`, Accept: 'text/html,text/plain' } });
    if ([301, 302, 303, 307, 308].includes(r.status)) { url = await comprobarUrl(new URL(r.headers.get('location'), url).href); continue; }
    if (!r.ok) throw new Error(T`La página respondió ${r.status}`);
    const tipo = r.headers.get('content-type') || '';
    if (!/text\/html|text\/plain|application\/xhtml/.test(tipo)) throw new Error(T`No es una página de texto (${tipo || T('tipo desconocido')})`);
    const lector = r.body.getReader(); let bytes = 0; const trozos = [];
    while (true) { const { done, value } = await lector.read(); if (done) break; bytes += value.length; trozos.push(value); if (bytes > 2_000_000) { lector.cancel(); break; } }
    const html = Buffer.concat(trozos).toString('utf8');
    const { titulo, texto } = tipo.includes('html') ? aTexto(html) : { titulo: '', texto: html };
    return { url: url.href, titulo, programas_detectados: detectarProgramas(html), texto: texto.length > max ? texto.slice(0, max) + ' […]' : texto };
  }
  throw new Error(T('Demasiadas redirecciones'));
}

export const _interno = { esIpPrivada, comprobarUrl };
