// Boletín por correo: Álex lo redacta, Dirección lo envía con un botón y sale poco a poco a quien se apuntó en la web con su permiso.
// Cada correo lleva su enlace de baja. Lo que se ha enviado queda apuntado: si algo se corta, nadie lo recibe dos veces.
import crypto from 'node:crypto';
import { q } from './db.js';
import { config } from './config.js';
import { log, emitir } from './bus.js';
import { bloques } from './telegram.js';
import * as correo from './correo.js';

// Uno por vuelta del planificador (cada 30 s, unos 120 a la hora). Hostinger limita por buzón y su límite depende del plan:
// 90 al día queda por debajo de los 100 del más bajo.
const POR_VUELTA = 1, TOPE_DIA = 90, INTENTOS = 3;

/** Saca asunto y texto. Lo demás no sale: las notas para Dirección se quedan en la mesa. */
export function leerBoletin(texto) {
  const b = bloques(texto);
  const i = b.findIndex(x => /^ASUNTO/.test(x.titulo));
  const enLinea = String(texto || '').match(/^asunto:\s*(.+)$/im)?.[1];
  const asunto = (i >= 0 ? b[i].cuerpo.split('\n')[0] : enLinea || '').trim().slice(0, 200);
  const partes = b.filter((x, k) => x.copiar && k !== i).map((x, k) => {
    const cuerpo = x.cuerpo.replace(/^asunto:.*$/im, '').trim();
    return k === 0 && /BOLET|TEXTO|CUERPO|CORREO|MENSAJE/.test(x.titulo) ? cuerpo : [x.titulo, cuerpo].filter(Boolean).join('\n');
  }).filter(Boolean);
  if (!asunto || !partes.length) return { error: 'El boletín necesita dos bloques, con su título en mayúsculas en una línea propia: ASUNTO y TEXTO DEL BOLETÍN.' };
  return { asunto, cuerpo: partes.join('\n\n') };
}

/** A quién se le envía: quien se apuntó en la web con su permiso y no se ha dado de baja. */
export async function destinatarios() {
  return (await q(`SELECT DISTINCT ON (lower(e.email)) lower(e.email) AS email, e.nombre FROM entradas e
                    WHERE e.tipo = 'oficina' AND e.consentimiento AND e.email ~ '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$'
                      AND NOT EXISTS (SELECT 1 FROM boletin_bajas b WHERE b.email = lower(e.email))
                    ORDER BY lower(e.email), e.id DESC`)).rows;
}

/** Los botones de la tarjeta, con cuántos son ahora. */
export async function opciones() {
  const n = (await destinatarios()).length;
  return [{ r: 'enviar', t: `📧 Enviar a ${n} interesado${n === 1 ? '' : 's'}` }, { r: 'cambios' }, { r: 'descartada', t: 'Descartar' }];
}

/** Al arrancar: los boletines que ya están en la mesa también tienen su botón, con la cuenta al día. */
export async function ponerBotones() {
  await q(`UPDATE aprobaciones SET opciones=$1 WHERE tipo='boletin' AND estado='pendiente'`, [JSON.stringify(await opciones())]);
}

function comprobarConexion() {
  if (!correo.activo()) throw new Error('El correo de la oficina no está conectado: crea el buzón de correo y pon sus datos en Configuración › Conexiones.');
  if (!config.panelUrl) throw new Error('Falta PANEL_URL en el .env: sin esa dirección el correo no puede llevar el enlace de baja.');
}

/** Solo a Dirección, para ver cómo llega antes de mandarlo a la lista. La tarjeta sigue en la mesa y su enlace de baja no da de baja a nadie. */
export async function enviarPrueba(ap, para) {
  const dir = String(para || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(dir)) throw new Error('Esa dirección de correo no es válida.');
  comprobarConexion();
  const b = leerBoletin(ap.texto);
  if (b.error) throw new Error(`${b.error} Pulsa «Pedir cambios» para que lo corrija Álex.`);
  const { token } = (await q(`INSERT INTO boletin_envios (aprobacion_id, email, token, estado) VALUES ($1,$2,$3,'prueba')
                             ON CONFLICT (aprobacion_id, email) DO UPDATE SET email = EXCLUDED.email RETURNING token`, [`prueba:${ap.id}`, dir, crypto.randomBytes(24).toString('base64url')])).rows[0];
  try { await correo.enviarBoletin({ para: dir, asunto: `[Prueba] ${b.asunto}`, texto: b.cuerpo, baja: enlaceBaja(token) }); }
  catch (e) { throw new Error(`El servidor de correo no lo ha aceptado (${String(e.message).slice(0, 160)}). Si habla de autenticación o de contraseña, revisa CORREO_USUARIO y CORREO_CLAVE.`); }
  await log('dueno', `ha enviado una prueba del boletín: «${b.asunto}».`, { aprobacion_id: ap.id });
  return { ok: true };
}

/** Dirección pulsa «Enviar»: se apunta a quién va y el planificador lo manda. Si falla aquí, la tarjeta sigue en la mesa y ve el motivo. */
export async function lanzar(ap) {
  comprobarConexion();
  const b = leerBoletin(ap.texto);
  if (b.error) throw new Error(`${b.error} Pulsa «Pedir cambios» para que lo corrija Álex.`);
  const lista = await destinatarios();
  if (!lista.length) throw new Error('Todavía no hay nadie apuntado con permiso: el boletín sigue en tu mesa.');
  for (const d of lista) {
    await q(`INSERT INTO boletin_envios (aprobacion_id, email, nombre, token) VALUES ($1,$2,$3,$4) ON CONFLICT (aprobacion_id, email) DO NOTHING`,
      [ap.id, d.email, d.nombre, crypto.randomBytes(24).toString('base64url')]);
  }
  await log('dueno', `ha enviado el boletín a ${lista.length} interesado${lista.length === 1 ? '' : 's'}: «${b.asunto}». Sale poco a poco, como mucho ${TOPE_DIA} al día.`, { aprobacion_id: ap.id });
  return lista.length;
}

const enlaceBaja = token => `${config.panelUrl.replace(/\/+$/, '')}/baja/${token}`;

/** Una vuelta del planificador: manda el siguiente. Si falla, lo reintenta en otra vuelta, hasta 3 veces. */
let enviando = false;
export async function revisar() {
  if (enviando || !correo.activo()) return 0;
  enviando = true;
  try {
    const hechos = (await q(`SELECT count(*)::int n FROM boletin_envios WHERE enviado > now() - interval '24 hours'`)).rows[0].n;
    const hueco = Math.min(POR_VUELTA, TOPE_DIA - hechos);
    let enviados = 0;
    for (let i = 0; i < hueco; i++) {
      const e = (await q(`UPDATE boletin_envios SET estado='enviando' WHERE id = (SELECT id FROM boletin_envios WHERE estado='pendiente' ORDER BY id LIMIT 1) RETURNING *`)).rows[0];
      if (!e) break;
      if ((await q(`SELECT 1 FROM boletin_bajas WHERE email=$1`, [e.email])).rows.length) { await q(`UPDATE boletin_envios SET estado='baja' WHERE id=$1`, [e.id]); continue; }
      const b = leerBoletin((await q(`SELECT texto FROM aprobaciones WHERE id=$1`, [e.aprobacion_id])).rows[0]?.texto);
      try {
        if (b.error) throw new Error(b.error);
        await correo.enviarBoletin({ para: e.email, asunto: b.asunto, texto: b.cuerpo, baja: enlaceBaja(e.token) });
        await q(`UPDATE boletin_envios SET estado='enviado', enviado=now(), error=NULL WHERE id=$1`, [e.id]);
        enviados++;
      } catch (err) {
        console.error('Boletín:', err.message);
        await q(`UPDATE boletin_envios SET estado = CASE WHEN intentos + 1 >= $2 THEN 'error' ELSE 'pendiente' END, intentos = intentos + 1, error=$3 WHERE id=$1`, [e.id, INTENTOS, String(err.message).slice(0, 300)]);
      }
      await cerrarSiTermino(e.aprobacion_id);
    }
    return enviados;
  } finally { enviando = false; }
}

/** Cuando ya no queda nadie, se cuenta cómo ha ido. Si algo ha fallado, se dice el motivo. */
async function cerrarSiTermino(aprobacion_id) {
  const r = (await q(`SELECT count(*) FILTER (WHERE estado='enviado')::int ok, count(*) FILTER (WHERE estado='error')::int mal, count(*) FILTER (WHERE estado='pendiente')::int quedan,
                             max(error) FILTER (WHERE estado='error') AS motivo FROM boletin_envios WHERE aprobacion_id=$1`, [aprobacion_id])).rows[0];
  if (r.quedan) return;
  await log('sistema', `ha terminado de enviar el boletín: ${r.ok} enviado${r.ok === 1 ? '' : 's'}${r.mal ? ` y ${r.mal} sin poder enviar (${r.motivo})` : ''}.`, { aprobacion_id });
}

const pagina = (titulo, cuerpo) => `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${titulo}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#222}button{font:inherit;padding:.6rem 1.2rem;cursor:pointer}</style></head><body><h1 style="font-size:1.4rem">${titulo}</h1>${cuerpo}</body></html>`;

/** La página del enlace de baja. Abrirlo solo pregunta, porque los antivirus de correo abren los enlaces solos: la baja es al pulsar
 *  el botón o con la baja de un clic de los programas de correo, que hacen un POST. Sin sesión: la llave es el token de cada correo. */
export async function paginaBaja(token, darDeBaja) {
  const e = (await q(`SELECT email, estado FROM boletin_envios WHERE token=$1`, [token])).rows[0];
  if (!e) return { codigo: 404, html: pagina('Este enlace no es válido', '<p>Puede que esté incompleto. Si quieres darte de baja, contesta al correo y lo hacemos nosotros.</p>') };
  if (darDeBaja && e.estado === 'prueba') return { codigo: 200, html: pagina('El enlace funciona', '<p>Era una prueba: no se ha dado de baja a nadie.</p>') };
  if (darDeBaja) {
    const nueva = (await q(`INSERT INTO boletin_bajas (email) VALUES ($1) ON CONFLICT (email) DO NOTHING RETURNING 1`, [e.email])).rows.length;
    await q(`UPDATE boletin_envios SET estado='baja' WHERE email=$1 AND estado='pendiente'`, [e.email]);
    if (nueva) { await log('sistema', 'ha dado de baja del boletín a una persona que lo ha pedido.'); await emitir({ tipo: 'mesa_cambiada' }); }
    return { codigo: 200, html: pagina('Ya estás fuera', '<p>No volverás a recibir el boletín.</p>') };
  }
  if ((await q(`SELECT 1 FROM boletin_bajas WHERE email=$1`, [e.email])).rows.length) return { codigo: 200, html: pagina('Ya estás fuera', '<p>No volverás a recibir el boletín.</p>') };
  return { codigo: 200, html: pagina('¿Quieres dejar de recibir el boletín?', '<form method="post"><button type="submit">Darme de baja</button></form>') };
}
