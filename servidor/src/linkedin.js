// Publicar en el perfil personal de Dirección en LinkedIn (producto «Share on LinkedIn», permiso w_member_social).
// Dirección conecta una vez desde el panel; el permiso dura 60 días y LinkedIn no deja renovarlo solo: avisamos antes.
// Nada se publica sin que Dirección pulse «Publicar» en su mesa.
import crypto from 'node:crypto';
import { q, ajuste, fijarAjuste } from './db.js';

// Publicación automática: los posts de Álex salen solos en su fecha (a las 9:00) salvo que Dirección los pare antes
export const autopublicar = async () => (await ajuste('linkedin_auto', false)) === true;   // por defecto, nada sale sin el clic de Dirección
export const fijarAutopublicar = on => fijarAjuste('linkedin_auto', Boolean(on));
import { config } from './config.js';
import { bloques } from './telegram.js';

const AUT = 'https://www.linkedin.com/oauth/v2';
const API = 'https://api.linkedin.com';
const estados = new Map();   // state de OAuth → caduca

// Credenciales de la app: del .env o, si no, las que Dirección pega en el panel (se guardan cifradas)
const app = { clientId: config.linkedin.clientId, clientSecret: config.linkedin.clientSecret };
export const configurado = () => Boolean(app.clientId && app.clientSecret && config.panelUrl);

export async function cargarApp() {
  const g = await ajuste('linkedin_app', null);
  if (g && !config.linkedin.clientSecret) { try { app.clientId = g.clientId; app.clientSecret = descifrar(g.secreto); } catch { console.error('No se pudo leer la app de LinkedIn guardada'); } }
  if (!app.clientId) app.clientId = config.linkedin.clientIdPorDefecto;
}
/** Dirección pega el «Client Secret» de su app en el panel. */
export async function guardarApp({ clientId, clientSecret }) {
  const id = String(clientId || app.clientId || '').trim(), sec = String(clientSecret || '').trim();
  if (!/^[A-Za-z0-9]{8,40}$/.test(id)) throw new Error('El Client ID no parece válido.');
  if (!/^\S{12,200}$/.test(sec)) throw new Error('Pega el «Primary Client Secret» completo, sin espacios.');
  await fijarAjuste('linkedin_app', { clientId: id, secreto: cifrar(sec) });
  app.clientId = id; app.clientSecret = sec;
  return estado();
}
const redireccion = () => `${config.panelUrl.replace(/\/+$/, '')}/api/linkedin/vuelta`;

// El token se guarda cifrado con una clave derivada del secreto de la app
const clave = () => crypto.createHash('sha256').update('acp-linkedin:' + config.claveCifrado).digest();
function cifrar(t) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', clave(), iv);
  const d = Buffer.concat([c.update(t, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), d].map(b => b.toString('base64')).join('.');
}
function descifrar(s) {
  const [iv, tag, d] = s.split('.').map(x => Buffer.from(x, 'base64'));
  const c = crypto.createDecipheriv('aes-256-gcm', clave(), iv); c.setAuthTag(tag);
  return Buffer.concat([c.update(d), c.final()]).toString('utf8');
}

/** Estado de la conexión para el panel (sin el token). */
export async function estado() {
  const g = await ajuste('linkedin', null);
  if (!configurado()) return { configurado: false, conectado: false, client_id: app.clientId || null };
  if (!g) return { configurado: true, conectado: false };
  const dias = Math.floor((new Date(g.caduca) - Date.now()) / 86_400_000);
  return { configurado: true, conectado: dias >= 0, nombre: g.nombre, caduca: g.caduca, dias_restantes: dias, autopublicar: await autopublicar() };
}

/** URL a la que se manda a Dirección para dar permiso. */
export function urlConexion() {
  if (!configurado()) throw new Error('Falta configurar la app de LinkedIn (LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET y PANEL_URL).');
  const st = crypto.randomBytes(16).toString('hex');
  estados.set(st, Date.now() + 15 * 60_000);
  const p = new URLSearchParams({ response_type: 'code', client_id: app.clientId, redirect_uri: redireccion(), state: st, scope: 'openid profile w_member_social' });
  return `${AUT}/authorization?${p}`;
}

/** Vuelta de LinkedIn con el código: lo cambia por el token y guarda quién es. */
export async function vuelta({ code, state, error, error_description }) {
  if (error) throw new Error(`LinkedIn ha devuelto: ${error_description || error}`);
  const cad = estados.get(state); estados.delete(state);
  if (!cad || cad < Date.now()) throw new Error('El enlace de conexión ha caducado. Vuelve a pulsar «Conectar LinkedIn».');
  const r = await fetch(`${AUT}/accessToken`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redireccion(), client_id: app.clientId, client_secret: app.clientSecret }) });
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.access_token) throw new Error(`No se ha podido conectar: ${t.error_description || r.status}`);
  const u = await (await fetch(`${API}/v2/userinfo`, { headers: { Authorization: `Bearer ${t.access_token}` } })).json().catch(() => ({}));
  if (!u.sub) throw new Error('LinkedIn no ha devuelto tu perfil.');
  const caduca = new Date(Date.now() + (Number(t.expires_in) || 5_184_000) * 1000).toISOString();
  await fijarAjuste('linkedin', { token: cifrar(t.access_token), autor: `urn:li:person:${u.sub}`, nombre: u.name || [u.given_name, u.family_name].filter(Boolean).join(' '), caduca, conectado: new Date().toISOString() });
  return estado();
}

export async function desconectar() { await fijarAjuste('linkedin', null); }

// Versión de la API: LinkedIn admite las de los últimos meses (formato AAAAMM)
function version() {
  if (config.linkedin.version) return config.linkedin.version;
  const d = new Date(); d.setUTCMonth(d.getUTCMonth() - 2);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
// En el texto de un post, estos caracteres tienen significado especial y hay que escaparlos
const escapar = t => String(t).replace(/[\\|{}@[\]()<>#*_~]/g, c => '\\' + c);

/** Publica un texto en el perfil de Dirección. Devuelve la URL del post. */
export async function publicar(texto, imagen = null) {
  const g = await ajuste('linkedin', null);
  if (!g) throw new Error('LinkedIn no está conectado. Conéctalo desde el panel (Tu mesa).');
  if (new Date(g.caduca) < new Date()) throw new Error('El permiso de LinkedIn ha caducado. Vuelve a conectarlo desde el panel.');
  if (process.env.LINKEDIN_SIMULADO) return { url: 'https://www.linkedin.com/feed/update/urn:li:share:simulado', id: 'urn:li:share:simulado' };
  const cab = { Authorization: `Bearer ${descifrar(g.token)}`, 'LinkedIn-Version': version(), 'X-Restli-Protocol-Version': '2.0.0' };
  // Con imagen: primero se sube (LinkedIn da una dirección de subida) y luego se cita en el post
  let media = null;
  if (imagen?.png) {
    const ini = await fetch(`${API}/rest/images?action=initializeUpload`, { method: 'POST', headers: { ...cab, 'Content-Type': 'application/json' }, body: JSON.stringify({ initializeUploadRequest: { owner: g.autor } }) });
    const j = await ini.json().catch(() => ({}));
    if (!ini.ok || !j.value?.uploadUrl) throw new Error(`LinkedIn no ha aceptado la imagen (${ini.status}): ${JSON.stringify(j).slice(0, 160)}`);
    const sub = await fetch(j.value.uploadUrl, { method: 'PUT', headers: { Authorization: cab.Authorization, 'Content-Type': 'image/png' }, body: imagen.png });
    if (!sub.ok) throw new Error(`No se ha podido subir la imagen a LinkedIn (${sub.status}).`);
    media = { id: j.value.image, altText: String(imagen.alt || '').slice(0, 300) };
  }
  const r = await fetch(`${API}/rest/posts`, {
    method: 'POST',
    headers: { ...cab, 'Content-Type': 'application/json' },
    body: JSON.stringify({ author: g.autor, commentary: escapar(texto).slice(0, 3000), visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] }, lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false,
      ...(media ? { content: { media } } : {}) }),
  });
  if (r.status !== 201) {
    const e = await r.text().catch(() => '');
    if (r.status === 401) throw new Error('LinkedIn ha rechazado el permiso (401). Vuelve a conectarlo desde el panel.');
    throw new Error(`LinkedIn no ha publicado el post (${r.status}): ${e.slice(0, 200)}`);
  }
  const id = r.headers.get('x-restli-id') || r.headers.get('x-linkedin-id') || '';
  return { id, url: id ? `https://www.linkedin.com/feed/update/${id}` : 'https://www.linkedin.com/feed/' };
}

/** Quita lo que se pone alrededor del post al prepararlo (título, «Día:», notas para Dirección). Si viene por bloques, solo el del post. */
export function textoDelPost(t) {
  const limpio = String(t).replace(/^\s*(?:Día|Fecha|Canal|Pilar)\s*:.*\n/gim, '').replace(/\n-{3,}\n[\s\S]*$/, '').trim();
  if (!/^\s*(NOTAS|TEXTO DEL POST|TEXTO DE LA PUBLICACI)/i.test(limpio)) return limpio;
  const bl = bloques(limpio).filter(b => b.copiar);
  return (bl.find(b => /POST|PUBLICACI/i.test(b.titulo)) || bl[0])?.cuerpo ?? '';
}
