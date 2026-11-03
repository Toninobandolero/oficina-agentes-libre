// Acceso al panel: pantalla propia con contraseña, sesiones con cookie y freno a los intentos repetidos.
import crypto from 'node:crypto';
import { q } from './db.js';
import { config } from './config.js';

const COOKIE = 'oficina_sesion';
const DIA = 86_400_000;
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const intentos = new Map();                  // ip → { fallos, hasta }
const MAX_FALLOS = 5, BLOQUEO_MS = 15 * 60_000;

export const activo = () => Boolean(config.panelPassword);

export function ipDe(req) {
  // Detrás de Caddy, el ÚLTIMO valor de X-Forwarded-For es el que pone Caddy (el cliente real); los anteriores
  // los puede inventar quien llama, y con ellos se saltaría el freno de intentos de contraseña
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  return xff.at(-1) || String(req.socket.remoteAddress || '');
}

function leerCookie(req) {
  const c = req.headers.cookie || '';
  const m = c.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]+)`));
  return m ? m[1] : null;
}

/** ¿Tiene esta petición una sesión válida? Alarga la sesión si le queda poco. */
export async function sesionValida(req) {
  if (!activo()) return true;
  const token = leerCookie(req);
  if (!token) return false;
  const r = await q(`SELECT id, expira, larga FROM sesiones WHERE token_hash=$1 AND expira > now()`, [sha(token).toString('hex')]);
  if (!r.rows.length) return false;
  const s = r.rows[0];
  if (s.larga && new Date(s.expira) - Date.now() < 15 * DIA) await q(`UPDATE sesiones SET expira = now() + interval '30 days' WHERE id=$1`, [s.id]);
  await q(`UPDATE sesiones SET ultimo_uso=now() WHERE id=$1`, [s.id]);
  return true;
}

function cabeceraCookie(req, valor, maxAgeSeg) {
  const segura = req.headers['x-forwarded-proto'] === 'https';
  return `${COOKIE}=${valor}; Path=/; HttpOnly; SameSite=Strict${segura ? '; Secure' : ''}${maxAgeSeg != null ? `; Max-Age=${maxAgeSeg}` : ''}`;
}

/** Comprueba la contraseña. Devuelve { ok, cookie } o { ok:false, error, restantes, bloqueadoMin }. */
export async function entrar(req, contrasena, recordar) {
  const ip = ipDe(req);
  if (intentos.size > 500) for (const [k, v] of intentos) if (v.hasta < Date.now()) intentos.delete(k);   // que la lista no crezca sin fin
  const estado = intentos.get(ip) || { fallos: 0, hasta: 0 };
  if (estado.hasta > Date.now()) return { ok: false, bloqueadoMin: Math.ceil((estado.hasta - Date.now()) / 60_000) };

  const bien = activo() && crypto.timingSafeEqual(sha(contrasena || ''), sha(config.panelPassword));
  if (!bien) {
    estado.fallos++;
    if (estado.fallos >= MAX_FALLOS) { estado.hasta = Date.now() + BLOQUEO_MS; estado.fallos = 0; }
    intentos.set(ip, estado);
    await new Promise(r => setTimeout(r, 800));       // frena los intentos automáticos
    return estado.hasta > Date.now() ? { ok: false, bloqueadoMin: 15 } : { ok: false, restantes: MAX_FALLOS - estado.fallos };
  }
  intentos.delete(ip);
  const token = crypto.randomBytes(32).toString('base64url');
  const dur = recordar ? 30 * DIA : DIA / 2;
  await q(`INSERT INTO sesiones (token_hash, expira, larga, ip, navegador) VALUES ($1, now() + $2 * interval '1 millisecond', $3, $4, $5)`,
    [sha(token).toString('hex'), dur, Boolean(recordar), ip, String(req.headers['user-agent'] || '').slice(0, 200)]);
  await q(`DELETE FROM sesiones WHERE expira < now()`);
  return { ok: true, cookie: cabeceraCookie(req, token, recordar ? 30 * 86400 : null) };
}

export async function salir(req) {
  const token = leerCookie(req);
  if (token) await q(`DELETE FROM sesiones WHERE token_hash=$1`, [sha(token).toString('hex')]);
  return cabeceraCookie(req, '', 0);
}
