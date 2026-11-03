// Publicar en la página de Facebook de la empresa (y, más adelante, en su Instagram enlazado).
// Dirección crea una app en Meta for Developers, pega en el panel su App ID y su clave secreta (se guardan cifradas)
// y pulsa «Conectar Facebook». Con eso obtenemos el token de la página, que no caduca.
// Nada se publica sin que Dirección pulse «Publicar» en su mesa.
import crypto from 'node:crypto';
import { ajuste, fijarAjuste } from './db.js';
import { config } from './config.js';

const V = 'v21.0';
const GRAPH = `https://graph.facebook.com/${V}`;
const estados = new Map();
const app = { id: '', secreto: '', config: '' };   // config: identificador de la configuración de «Inicio de sesión con Facebook para empresas»

const clave = () => crypto.createHash('sha256').update('acp-facebook:' + config.claveCifrado).digest();
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
const redireccion = () => `${String(config.panelUrl || '').replace(/\/+$/, '')}/api/facebook/vuelta`;
export const configurado = () => Boolean(app.id && app.secreto && config.panelUrl);

export async function cargarApp() {
  const g = await ajuste('facebook_app', null);
  if (g) { try { app.id = g.id; app.secreto = descifrar(g.secreto); } catch { console.error('No se pudo leer la app de Facebook guardada'); } }
  const pre = await ajuste('facebook_app_previa', null);   // App ID y configuración ya creados en Meta (solo falta la clave)
  if (pre) { if (!app.id) app.id = pre.id || ''; app.config = pre.config || ''; }
}

/** Dirección pega el App ID y la clave secreta de su app de Meta. */
export async function guardarApp({ appId, appSecret }) {
  const id = String(appId || '').trim(), sec = String(appSecret || '').trim();
  if (!/^\d{8,20}$/.test(id)) throw new Error('El identificador de la app son solo números (lo ves arriba en developers.facebook.com).');
  if (!/^[a-f0-9]{32}$/i.test(sec)) throw new Error('La clave secreta tiene 32 letras y números. Pulsa «Mostrar» en Configuración › Básica y cópiala entera.');
  await fijarAjuste('facebook_app', { id, secreto: cifrar(sec) });
  app.id = id; app.secreto = sec;
  return estado();
}

/** Publicación automática en Facebook: los posts de la mesa salen solos a las 9:00 de su día si Dirección no los para. Por defecto, apagada. */
export const autopublicar = async () => (await ajuste('facebook_auto', false)) === true;
export const fijarAutopublicar = on => fijarAjuste('facebook_auto', Boolean(on));

export async function estado() {
  const g = await ajuste('facebook', null);
  if (!configurado()) return { configurado: false, conectado: false, app_id: app.id || null, redireccion: config.panelUrl ? redireccion() : null };
  if (!g) return { configurado: true, conectado: false, redireccion: redireccion() };
  return { configurado: true, conectado: true, pagina: g.nombre, pagina_id: g.pagina, instagram: g.instagram_usuario || null, conectado_el: g.conectado, autopublicar: await autopublicar() };
}

export function urlConexion() {
  if (!configurado()) throw new Error('Falta pegar el App ID y la clave secreta de la app de Meta en el panel (Tu mesa).');
  const st = crypto.randomBytes(16).toString('hex');
  estados.set(st, Date.now() + 15 * 60_000);
  const p = new URLSearchParams({ client_id: app.id, redirect_uri: redireccion(), state: st, response_type: 'code' });
  // Las apps de empresa usan una «configuración» con los permisos; las demás, la lista de permisos
  if (app.config) p.set('config_id', app.config); else p.set('scope', 'pages_show_list,pages_read_engagement,pages_manage_posts');
  return `https://www.facebook.com/${V}/dialog/oauth?${p}`;
}

async function get(ruta, params) {
  const r = await fetch(`${GRAPH}${ruta}?${new URLSearchParams(params)}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error?.message || `Facebook ${r.status}`);
  return j;
}

/** Vuelta de Facebook: cambia el código por un token largo y se queda con el de la página de la empresa. */
export async function vuelta({ code, state, error_description, error_message }) {
  if (error_description || error_message) throw new Error(`Facebook ha devuelto: ${error_description || error_message}`);
  const cad = estados.get(state); estados.delete(state);
  if (!cad || cad < Date.now()) throw new Error('El enlace de conexión ha caducado. Vuelve a pulsar «Conectar Facebook».');
  const corto = await get('/oauth/access_token', { client_id: app.id, client_secret: app.secreto, redirect_uri: redireccion(), code });
  const largo = await get('/oauth/access_token', { grant_type: 'fb_exchange_token', client_id: app.id, client_secret: app.secreto, fb_exchange_token: corto.access_token });
  const cuentas = await get('/me/accounts', { access_token: largo.access_token, fields: 'id,name,access_token,instagram_business_account{id,username}' });
  let paginas = cuentas.data || [];
  if (!paginas.length) {
    // Con «Inicio de sesión para empresas», las páginas elegidas vienen en los permisos concedidos (granular_scopes)
    const dbg = await get('/debug_token', { input_token: largo.access_token, access_token: `${app.id}|${app.secreto}` }).catch(() => ({}));
    const ids = [...new Set((dbg.data?.granular_scopes || []).filter(g => /^pages_/.test(g.scope)).flatMap(g => g.target_ids || []))];
    for (const pid of ids) {
      const pg = await get(`/${pid}`, { access_token: largo.access_token, fields: 'id,name,access_token,instagram_business_account{id,username}' }).catch(e => { console.error('Facebook (página):', e.message); return null; });
      if (pg?.access_token) paginas.push(pg);
    }
    if (!paginas.length) console.error('Facebook (vuelta): sin páginas; permisos:', JSON.stringify(dbg.data?.granular_scopes || dbg.data?.scopes || dbg));
  }
  if (!paginas.length) throw new Error('No he visto ninguna página. Al conectar, marca la página de la empresa.');
  const p = paginas.find(x => /c[oó]digo\s*abierto/i.test(x.name)) || paginas[0];
  await fijarAjuste('facebook', { pagina: p.id, nombre: p.name, token: cifrar(p.access_token),
    instagram: p.instagram_business_account?.id || null, instagram_usuario: p.instagram_business_account?.username || null, conectado: new Date().toISOString() });
  return estado();
}

export async function desconectar() { await fijarAjuste('facebook', null); }

/** Publica un texto en la página. Devuelve la URL del post. */
export async function publicar(texto, imagen = null) {
  const g = await ajuste('facebook', null);
  if (!g) throw new Error('Facebook no está conectado. Conéctalo desde el panel (Tu mesa).');
  if (process.env.FACEBOOK_SIMULADO) return { id: 'simulado', url: 'https://www.facebook.com/simulado' };
  let r;
  if (imagen?.png) {
    // Con imagen: se sube como foto de la página con el texto como pie
    const f = new FormData();
    f.append('caption', String(texto).slice(0, 60000)); f.append('access_token', descifrar(g.token));
    f.append('source', new Blob([imagen.png], { type: 'image/png' }), 'post.png');
    r = await fetch(`${GRAPH}/${g.pagina}/photos`, { method: 'POST', body: f });
  } else r = await fetch(`${GRAPH}/${g.pagina}/feed`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ message: String(texto).slice(0, 60000), access_token: descifrar(g.token) }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    if (j.error?.code === 190) throw new Error('Facebook ha retirado el permiso. Vuelve a conectarlo desde el panel.');
    throw new Error(`Facebook no ha publicado el post: ${j.error?.message || r.status}`);
  }
  const pid = j.post_id || j.id;
  const [pag, post] = String(pid || '').split('_');
  return { id: pid, url: post ? `https://www.facebook.com/${pag}/posts/${post}` : `https://www.facebook.com/${g.pagina}` };
}
