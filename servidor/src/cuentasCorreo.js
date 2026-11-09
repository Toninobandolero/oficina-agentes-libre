// Las cuentas de correo enlazadas con la oficina: la del servidor (.env) y las que se añaden desde Configuración, para elegir desde cuál sale cada envío.
// Las contraseñas se guardan cifradas y no salen nunca de este archivo.
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { ajuste, fijarAjuste } from './db.js';
import { config } from './config.js';
import { T } from './en.js';

const clave = () => crypto.createHash('sha256').update('acp-correo:' + config.claveCifrado).digest();
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

let extra = [], porDefecto = null;
const transportes = new Map();
export async function cargar() {
  extra = (await ajuste('correo_cuentas', [])) || [];
  porDefecto = await ajuste('correo_predeterminada', null);
  transportes.clear();
}

const delServidor = () => (config.correo.usuario && config.correo.clave
  ? { id: 'principal', nombre: config.correo.nombre, direccion: config.correo.usuario, clave: config.correo.clave, smtp: config.correo.smtp, imap: config.correo.imap, leer: true, del_servidor: true } : null);
const todas = () => [delServidor(), ...extra.map(c => {
  try { return { ...c, clave: descifrar(c.clave) }; } catch { return null; }   // cifrada con otra CLAVE_CIFRADO: hay que volver a ponerla
})].filter(Boolean);

/** La cuenta pedida o, si no existe, la predeterminada. */
export const elegir = id => { const l = todas(); return l.find(c => c.id === id) || l.find(c => c.id === porDefecto) || l[0] || null; };
export const predeterminada = () => elegir(null);
/** ¿Se puede enviar por esta cuenta? Entra en el servidor sin mandar nada. */
export async function comprobar(id) {
  const c = elegir(id);
  if (!c) return { ok: false, motivo: 'No hay ninguna cuenta de correo conectada.' };
  if (process.env.CORREO_SIMULADO) return { ok: true, direccion: c.direccion };
  try { await transporte(c).verify(); return { ok: true, direccion: c.direccion }; }
  catch (e) { return { ok: false, direccion: c.direccion, codigo: e.code || null, detalle: String(e.message || e).slice(0, 200) }; }
}
export const queLeen = () => todas().filter(c => c.leer);
export const listar = () => { const d = predeterminada()?.id; return todas().map(({ clave: _, ...c }) => ({ ...c, predeterminada: c.id === d })); };

const crear = (c, servidor = c.smtp) => {
  if (process.env.CORREO_SIMULADO) return nodemailer.createTransport({ jsonTransport: true });
  const [host, puerto] = String(servidor).split(':');
  const port = Number(puerto || 465);
  return nodemailer.createTransport({ host, port, secure: port === 465, auth: { user: c.direccion, pass: c.clave }, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000 });
};
export function transporte(c) {
  if (!transportes.has(c.id)) transportes.set(c.id, crear(c));
  return transportes.get(c.id);
}

// Los servidores se deducen de la dirección; lo demás funciona con los del correo de la oficina
const servidoresDe = dir => (/@(gmail|googlemail)\.com$/.test(dir) ? { smtp: 'smtp.gmail.com:465', imap: 'imap.gmail.com:993' } : { smtp: config.correo.smtp, imap: config.correo.imap });

/** Añade una cuenta, o cambia la que tenga esa dirección. Antes comprueba que se puede entrar: una cuenta que no funciona no se guarda. */
export async function guardar({ nombre, direccion, clave: pass, smtp, imap, leer } = {}) {
  const dir = String(direccion || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(dir)) throw new Error(T('Esa dirección de correo no es válida.'));
  if (delServidor()?.direccion === dir) throw new Error(T('Esa cuenta ya está: es la del servidor.'));
  const previa = extra.find(c => c.direccion === dir);
  const contrasena = String(pass || '').trim() || (previa ? descifrar(previa.clave) : '');
  if (!contrasena) throw new Error(T('Pon la contraseña de esa cuenta.'));
  const base = servidoresDe(dir);
  const cuenta = { id: previa?.id || crypto.randomBytes(4).toString('hex'), nombre: String(nombre || '').trim().slice(0, 80) || config.correo.nombre, direccion: dir,
    smtp: String(smtp || '').trim() || previa?.smtp || base.smtp, imap: String(imap || '').trim() || previa?.imap || base.imap, leer: Boolean(leer) };
  try { await crear({ ...cuenta, clave: contrasena }).verify(); }
  catch (e) { throw new Error(T`No se ha podido entrar en ${dir}: revisa la contraseña y el servidor (${cuenta.smtp}). Gmail y otros piden una contraseña de aplicación. ${String(e.message || '').slice(0, 120)}`); }
  extra = [...extra.filter(c => c.direccion !== dir), { ...cuenta, clave: cifrar(contrasena) }];
  await fijarAjuste('correo_cuentas', extra);
  transportes.delete(cuenta.id);
  return listar();
}

export async function quitar(id) {
  if (id === 'principal') throw new Error(T('Esa cuenta está en la configuración del servidor: no se puede quitar desde aquí.'));
  extra = extra.filter(c => c.id !== id);
  await fijarAjuste('correo_cuentas', extra);
  transportes.delete(id);
  if (porDefecto === id) await predeterminar(null);
  return listar();
}

export async function predeterminar(id) {
  porDefecto = id;
  await fijarAjuste('correo_predeterminada', id);
  return listar();
}
