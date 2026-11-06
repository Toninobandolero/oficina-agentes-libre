// Oficina de agentes: servidor HTTP (panel + API), motor, planificador y Telegram.
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config, validar } from './config.js';
import { migrar, ajuste, q } from './db.js';
import * as secuencias from './secuencias.js';
import * as plantilla from './plantilla.js';
import * as ausencia from './ausencia.js';
import * as correo from './correo.js';
import * as bus from './bus.js';
import { AGENTES, IDS, RAIZ } from './agentes.js';
import * as empresas from './empresas.js';
import * as importador from './importar.js';
import * as tareas from './tareas.js';
import * as aprobaciones from './aprobaciones.js';
import * as aprendizajes from './aprendizajes.js';
import * as presupuesto from './presupuesto.js';
import * as motor from './motor.js';
import * as planificador from './planificador.js';
import * as busqueda from './busqueda.js';
import * as boletin from './boletin.js';
import * as contactos from './contactos.js';
import * as protocolo from './protocolo.js';
import * as cuentasCorreo from './cuentasCorreo.js';
import * as fuentes from './fuentes.js';
import * as telegram from './telegram.js';
import * as acceso from './acceso.js';
import * as entradas from './entradas.js';
import * as alianzas from './alianzas.js';
import * as premios from './premios.js';
import * as memoria from './memoria.js';
import * as linkedin from './linkedin.js';
import * as facebook from './facebook.js';
import * as perfil from './perfil.js';
import * as marca from './marca.js';
import * as disenio from './disenio.js';
import * as video from './video.js';
import { PRO, M } from './modulos.js';
import * as modulos from './modulos.js';
import * as chats from './chats.js';
import * as vida from './vida.js';
import * as reunion from './reunion.js';
import * as chat from './chat.js';
import * as ia from './ia.js';
import * as arranque from './arranque.js';
import * as departamentos from './departamentos.js';

const PANEL =path.join(RAIZ, 'panel', 'index.html');
const ESTATICOS = {
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icono-192.png': ['icono-192.png', 'image/png'], '/icono-512.png': ['icono-512.png', 'image/png'],
  '/apple-touch-icon.png': ['icono-180.png', 'image/png'], '/favicon.ico': ['icono-192.png', 'image/png'],
  '/en.js': ['en.js', 'text/javascript; charset=utf-8'],   // el panel en inglés (?lang=en)
};

// ---------- utilidades HTTP ----------
function json(res, codigo, datos) {
  res.writeHead(codigo, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(datos));
}
/** Tras volver de LinkedIn o Facebook (otra web), la cookie «SameSite=Strict» no viaja en la redirección:
 *  pasamos por una página propia que salta al panel, y así sigues dentro sin volver a entrar. */
function volverAlPanel(res, destino) {
  const d = String(destino).replace(/[<>"']/g, '');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  return res.end(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${d}"><title>Volviendo a la oficina…</title><p style="font-family:system-ui;padding:2rem">Volviendo a la oficina… <a href="${d}">Pulsa aquí si no pasa nada</a>.</p>`);
}

async function cuerpo(req, limite = 200_000) {
  let t = '';
  for await (const c of req) { t += c; if (t.length > limite) throw Object.assign(new Error('Cuerpo demasiado grande'), { codigo: 413 }); }
  if (!t) return {};
  try { return JSON.parse(t); } catch { throw Object.assign(new Error('JSON no válido'), { codigo: 400 }); }
}
const nombreAgente = s => plantilla.idPorNombre(s);

// Huella del panel: si cambia (nueva publicación), los navegadores abiertos se recargan solos
import crypto from 'node:crypto';
let versionPanel = null;
const versionDelPanel = () => versionPanel ??= crypto.createHash('sha1').update(fs.readFileSync(PANEL)).digest('hex').slice(0, 10);

async function snapshotCompleto() {
  const s = await bus.snapshot({ version: versionDelPanel(), premio: await premios.ultimo().catch(() => null), linkedin: await linkedin.estado().catch(() => null), vida_oficina: vida.estaActiva(), gasto: await presupuesto.gastoMes(), pausado: await motor.estaPausado(), pausa_motivo: await ajuste('pausa_motivo', ''), gracias: await aprendizajes.contadorGracias(), plantilla: plantilla.listar(), ausencia: await ausencia.estado(), animo: await vida.animo().catch(() => null) });
  await video.enTarjetas(s.aprobaciones);
  return s;
}

/** Sirve el MP4 por trozos si los piden: Safari no reproduce un vídeo sin eso, y los demás lo usan para saltar. */
function servirVideo(req, res, mp4, nombre) {
  const total = mp4.length, cab = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600', ...(nombre ? { 'Content-Disposition': `attachment; filename="${nombre}"` } : {}) };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (!m || (!m[1] && !m[2])) { res.writeHead(200, { ...cab, 'Content-Length': total }); return res.end(mp4); }
  const ini = m[1] ? Number(m[1]) : Math.max(0, total - Number(m[2])), fin = m[1] && m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
  if (ini > fin) { res.writeHead(416, { 'Content-Range': `bytes */${total}` }); return res.end(); }
  res.writeHead(206, { ...cab, 'Content-Range': `bytes ${ini}-${fin}/${total}`, 'Content-Length': fin - ini + 1 });
  res.end(mp4.subarray(ini, fin + 1));
}

// Protección frente a órdenes enviadas desde otras webs (CSRF): solo JSON y solo desde el propio panel
function peticionSegura(req) {
  if (!['POST', 'DELETE'].includes(req.method)) return true;
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) return false;
  const sitio = req.headers['sec-fetch-site'];
  if (sitio && !['same-origin', 'none'].includes(sitio)) return false;
  const origen = req.headers.origin;
  if (origen) { try { if (new URL(origen).host !== req.headers.host) return false; } catch { return false; } }
  return true;
}

// ---------- rutas ----------
// Formulario público de la web de la empresa: única ruta que acepta peticiones de otra web (la nuestra)
function cabecerasWeb(req, res) {
  const origen = req.headers.origin;
  if (origen && config.entradaOrigenes.includes(origen)) {
    res.setHeader('Access-Control-Allow-Origin', origen);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    return true;
  }
  return !origen;   // sin Origin (p. ej. curl o el propio servidor) no hace falta CORS
}
const ipDe = acceso.ipDe;   // la IP real detrás de Caddy (el último valor de X-Forwarded-For)

async function rutas(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname, m = req.method;
  // Cabeceras de seguridad para todo: nada se interpreta con otro tipo, no se filtra la URL al salir, y el panel no se puede
  // meter en un marco de otra web
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), payment=()');
  res.setHeader('X-Frame-Options', p.endsWith('/documento.pdf') ? 'SAMEORIGIN' : 'DENY');   // el PDF se ve dentro del propio panel
  if (req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=15552000');   // 180 días: el navegador no vuelve a usar http
  if (p === '/api/entrada') {
    const permitido = cabecerasWeb(req, res);
    if (m === 'OPTIONS') { res.writeHead(permitido ? 204 : 403); return res.end(); }
    if (m !== 'POST') return json(res, 405, { error: 'Solo POST' });
    if (!permitido) return json(res, 403, { error: 'Origen no permitido' });
    const r = await entradas.recibir(await cuerpo(req), ipDe(req));
    return r.ok ? json(res, 201, { ok: true }) : json(res, r.codigo || 400, { error: r.error });
  }
  // Calendario para el móvil: dirección secreta de solo lectura (el móvil no tiene sesión; la protege el token)
  let ri;
  if (m === 'GET' && (ri = p.match(/^\/cal\/([A-Za-z0-9_-]{20,40})\.ics$/))) {
    const agenda = await import('./agenda.js');
    if (!(await agenda.tokenValido(ri[1]))) { res.writeHead(404); return res.end(); }
    const tipos = (url.searchParams.get('tipos') || agenda.TIPOS.join(',')).split(',');
    res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-cache', 'Content-Disposition': 'inline; filename="oficina.ics"' });
    return res.end(await agenda.ics(tipos));
  }
  // Vuelta de LinkedIn tras dar permiso: llega sin la cookie (viene de otra web); la protege el «state» de un solo uso
  if (m === 'GET' && p === '/api/linkedin/vuelta') {
    let destino = '/?linkedin=ok';
    try { await linkedin.vuelta(Object.fromEntries(url.searchParams)); await bus.log('dueno', 'ha conectado su LinkedIn: lo que apruebe de Álex se podrá publicar desde la mesa.'); await aprobaciones.actualizarOpcionesPosts().catch(() => {}); }
    catch (e) { console.error('LinkedIn (vuelta):', e.message); await bus.log('sistema', `no ha podido conectar LinkedIn: ${e.message}`); destino = '/?linkedin=error&motivo=' + encodeURIComponent(e.message); }
    return volverAlPanel(res, destino);
  }
  if (m === 'GET' && p === '/api/facebook/vuelta') {
    let destino = '/?facebook=ok';
    try { const e = await facebook.vuelta(Object.fromEntries(url.searchParams)); await bus.log('dueno', `ha conectado la página de Facebook «${e.pagina}»: lo que apruebe de Álex se podrá publicar desde la mesa.`); await aprobaciones.actualizarOpcionesPosts().catch(() => {}); }
    catch (e) { console.error('Facebook (vuelta):', e.message); await bus.log('sistema', `no ha podido conectar Facebook: ${e.message}`); destino = '/?facebook=error&motivo=' + encodeURIComponent(e.message); }
    return volverAlPanel(res, destino);
  }
  // Baja del boletín: sin sesión, con la llave de cada correo. Los programas de correo hacen un POST que no es JSON, por eso va antes de la guarda
  const baja = p.match(/^\/baja\/([\w-]{20,})$/);
  if (baja && (m === 'GET' || m === 'POST')) {
    const r = await boletin.paginaBaja(baja[1], m === 'POST');
    res.writeHead(r.codigo, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(r.html);
  }
  if (!peticionSegura(req)) return json(res, 403, { error: 'Petición rechazada: solo se aceptan órdenes desde el propio panel.' });

  if (m === 'GET' && p === '/salud') return json(res, 200, { ok: true });
  // Archivos de la app instalable (pantalla de inicio del móvil): públicos, sin datos
  const est = ESTATICOS[p];
  if (m === 'GET' && est) {
    let cont; try { cont = fs.readFileSync(path.join(RAIZ, 'panel', est[0])); } catch { return json(res, 404, { error: 'No existe' }); }
    res.writeHead(200, { 'Content-Type': est[1], 'Cache-Control': est[0] === 'en.js' ? 'no-cache' : 'public, max-age=86400' }); return res.end(cont);
  }
  // Imágenes de la marca (logo, capturas de lo que hemos hecho…): públicas, para fichas y perfiles (Google, redes, correos)
  const imgMarca = m === 'GET' && p.match(/^\/marca\/([\w-]+\.(jpg|jpeg|png|webp))$/);
  if (imgMarca) {
    const f = path.join(RAIZ, 'panel', 'marca', imgMarca[1]);
    if (!fs.existsSync(f)) return json(res, 404, { error: 'No existe esa imagen' });
    res.writeHead(200, { 'Content-Type': { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[imgMarca[2]], 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' });
    return res.end(fs.readFileSync(f));
  }

  // Modelos 3D de la oficina (Kenney, CC0): públicos; solo nombres sencillos, en la raíz o en cementerio/ (Halloween), con su Textures/
  const modelo = m === 'GET' && p.match(/^\/modelos3d\/((?:cementerio\/)?(?:Textures\/)?[\w-]+\.(glb|png))$/);
  if (modelo) {
    const f = path.join(RAIZ, 'panel', 'modelos3d', modelo[1]);
    if (!fs.existsSync(f)) return json(res, 404, { error: 'No existe ese modelo' });
    res.writeHead(200, { 'Content-Type': modelo[2] === 'glb' ? 'model/gltf-binary' : 'image/png', 'Cache-Control': 'public, max-age=604800' });
    return res.end(fs.readFileSync(f));
  }

  // ---- acceso ----
  if (m === 'POST' && p === '/api/entrar') {
    const b = await cuerpo(req);
    const r = await acceso.entrar(req, b.contrasena, b.recordar);
    if (r.ok) { res.setHeader('Set-Cookie', r.cookie); return json(res, 200, { ok: true }); }
    return json(res, r.bloqueadoMin ? 429 : 401, r.bloqueadoMin
      ? { error: `Demasiados intentos. Prueba de nuevo dentro de ${r.bloqueadoMin} minutos.` }
      : { error: `Contraseña incorrecta.${r.restantes <= 2 ? ` Te quedan ${r.restantes} intentos.` : ''}` });
  }
  if (m === 'POST' && p === '/api/salir') { res.setHeader('Set-Cookie', await acceso.salir(req)); return json(res, 200, { ok: true }); }

  const dentro = await acceso.sesionValida(req);
  if (m === 'GET' && (p === '/' || p === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    const html = fs.readFileSync(PANEL, 'utf8');
    // Sin sesión: la pantalla de acceso. Con sesión y sin configurar todavía: el primer uso
    const avisos = !dentro ? ['window.PANTALLA_ACCESO=true'] : [...((await arranque.hecho()) ? [] : ['window.PRIMER_USO=true']), `window.PRO=${JSON.stringify(PRO)}`, `window.APAGADOS=${JSON.stringify(departamentos.agentesApagados())}`, `window.PROPIOS=${JSON.stringify(departamentos.paraPanel()).replace(/</g, '\\u003c')}`];
    return res.end(html.replace('<head>', () => `<head><script>${avisos.join(';')}</script>`));
  }
  if (!dentro) return json(res, 401, { error: 'Inicia sesión para continuar.' });
  if (m === 'POST') ausencia.marcarActividad();   // si estás tocando el panel, estás despierto

  if (m === 'GET' && p === '/api/eventos') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`retry: 3000\ndata: ${JSON.stringify(await snapshotCompleto())}\n\n`);
    bus.suscribir(res);
    const latido = setInterval(() => res.write('data: {"tipo":"latido"}\n\n'), 25_000);   // el panel lo usa para saber que la conexión sigue viva
    req.on('close', () => clearInterval(latido));
    return;
  }
  if (m === 'GET' && p === '/api/estado') return json(res, 200, await snapshotCompleto());

  if (m === 'GET' && p === '/api/empresas.csv') {
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="empresas.csv"' });
    return res.end(await empresas.csv());
  }
  // Una lista de contactos de otro programa, en Excel o CSV: primero se propone a qué campo va cada columna y se enseña cómo quedaría; se guarda cuando lo confirma quien importa
  if (m === 'POST' && p === '/api/empresas/importar/leer') {
    const b = await cuerpo(req, 12_000_000);
    try { return json(res, 200, await importador.proponer(b.archivo)); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (m === 'POST' && p === '/api/empresas/importar') {
    const b = await cuerpo(req, 12_000_000);
    let r; try { r = await importador.importar(b); } catch (e) { return json(res, 400, { error: e.message }); }
    if (r.importadas) await bus.log('dueno', `ha importado ${r.importadas} empresa${r.importadas === 1 ? '' : 's'} de su cartera (${{ ganada: 'clientes', conversacion: 'con permiso o en conversación', nueva: 'lista fría' }[b.estado]}).`);
    return json(res, 200, r);
  }
  if (m === 'GET' && p === '/api/protocolo') return json(res, 200, { niveles: protocolo.listado(), sin_hablar: protocolo.SIN_HABLAR });
  let rInteres;
  if (m === 'POST' && (rInteres = p.match(/^\/api\/empresas\/([\w-]+)\/interes$/))) {
    const r = rInteres;
    const b = await cuerpo(req);
    try {
      const hecho = await protocolo.registrar(r[1], b.nivel, { frase: b.frase, canal: b.canal, cuando: b.cuando, por: 'dueno' });
      if (!protocolo.NIVELES[b.nivel].cierra && !hecho.agotado) await tareas.crear('paula', `Dirección ha apuntado lo que dijo este contacto: «${String(b.frase).trim()}». Según el protocolo: ${hecho.hacer} Prepárale lo que toque; el recordatorio ya está puesto.`, { empresa_id: r[1], origen: 'dueno' });
      return json(res, 200, hecho);
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (m === 'GET' && p === '/api/empresas') return json(res, 200, await empresas.listar(Object.fromEntries(url.searchParams)));
  let r;
  if ((r = p.match(/^\/api\/empresas\/([\w-]+)\/contactos$/))) {
    if (m === 'GET') return json(res, 200, { contactos: await contactos.deEmpresa(r[1]), opciones: await contactos.opciones(r[1]), consejos: await (await import('./horario.js')).mejorasRecientes() });
    if (m === 'POST') {
      try {
        const c = await contactos.guardar(r[1], await cuerpo(req), { origen: 'dueno' });
        await bus.log('dueno', `ha apuntado a ${c.nombre || c.telefono || c.email} en los contactos de la empresa.`, { empresa_id: r[1] });
        return json(res, 200, { contacto: c, contactos: await contactos.deEmpresa(r[1]), opciones: await contactos.opciones(r[1]) });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
  }
  if (m === 'POST' && (r = p.match(/^\/api\/contactos\/(\d+)\/(preferente|quitar)$/))) {
    try { await (r[2] === 'quitar' ? contactos.quitar(Number(r[1])) : contactos.hacerPreferente(Number(r[1]))); return json(res, 200, { ok: true }); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (m === 'GET' && (r = p.match(/^\/api\/empresas\/([\w-]+)\/historial$/))) {
    const h = await empresas.historial(r[1]);
    return h ? json(res, 200, { ...h, secuencia: await secuencias.deEmpresa(r[1]), correos: await correo.deEmpresa(r[1]) }) : json(res, 404, { error: 'No existe esa empresa' });
  }
  if (m === 'GET' && (r = p.match(/^\/api\/empresas\/([\w-]+)$/))) {
    const e = await empresas.leer(r[1]);
    return e ? json(res, 200, { ...e, coste: await empresas.coste(r[1]).catch(() => null), contactos: await contactos.deEmpresa(r[1]), situacion: await protocolo.situacion(e) }) : json(res, 404, { error: 'No existe esa empresa' });
  }
  if (m === 'POST' && (r = p.match(/^\/api\/empresas\/([\w-]+)\/proximo-hecho$/))) {
    await empresas.actualizar(r[1], { proximo_paso: null, fecha_proximo_paso: null });
    return json(res, 200, { ok: true });
  }
  if (m === 'POST' && (r = p.match(/^\/api\/empresas\/([\w-]+)\/estado$/))) {
    const b = await cuerpo(req);
    const e = await empresas.actualizar(r[1], { estado: b.estado });
    await bus.log('dueno', `ha marcado ${e.nombre} como «${b.estado}».`);
    return json(res, 200, e);
  }

  if (m === 'POST' && p === '/api/tareas') {
    const b = await cuerpo(req);
    const ag = nombreAgente(b.agente);
    if (!ag) return json(res, 400, { error: `Agente desconocido. Usa uno de: ${IDS.join(', ')}` });
    if (!b.instruccion?.trim()) return json(res, 400, { error: 'Escribe qué tiene que hacer.' });
    const t = await tareas.crear(ag, b.instruccion.trim(), { empresa_id: b.empresa_id || null, origen: 'dueno' });
    await bus.log('dueno', `ha encargado a ${AGENTES[ag].nombre}: «${b.instruccion.trim().slice(0, 140)}»`);
    return json(res, 201, t);
  }

  if (m === 'POST' && (r = p.match(/^\/api\/aprobaciones\/(\w+)\/prueba$/))) {
    const ap = (await q(`SELECT * FROM aprobaciones WHERE id=$1 AND tipo='boletin' AND estado='pendiente'`, [r[1]])).rows[0];
    if (!ap) return json(res, 404, { error: 'Ese boletín ya no está en tu mesa.' });
    try { return json(res, 200, await boletin.enviarPrueba(ap, (await cuerpo(req)).para)); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (m === 'POST' && (r = p.match(/^\/api\/aprobaciones\/(\w+)$/))) {
    const b = await cuerpo(req);
    let ap;
    try { ap = await aprobaciones.resolver(r[1], b.resultado, b.texto || ''); } catch (e) { return json(res, 400, { error: e.message }); }
    if (ap?.pideTexto) return json(res, 400, { error: 'Escribe lo que te ha respondido.' });
    return ap ? json(res, 200, { ok: true }) : json(res, 409, { error: 'Ya estaba resuelta o no existe.' });
  }
  if (m === 'GET' && p === '/api/clima') return json(res, 200, (await (await import('./clima.js')).actual()) || { error: 'Sin datos del tiempo' });
  // Con fechas: el calendario. Sin ellas, más abajo, lo que el equipo tiene programado (la pantalla de la oficina)
  if (m === 'GET' && p === '/api/agenda' && (url.searchParams.has('desde') || url.searchParams.has('hasta'))) {
    const d = url.searchParams.get('desde'), h = url.searchParams.get('hasta');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '') || !/^\d{4}-\d{2}-\d{2}$/.test(h || '')) return json(res, 400, { error: 'Fechas no válidas' });
    const agenda = await import('./agenda.js');
    return json(res, 200, await agenda.entre(d, h, (url.searchParams.get('tipos') || agenda.TIPOS.join(',')).split(',')));
  }
  if ((m === 'GET' || m === 'POST') && p === '/api/agenda/movil') {
    const agenda = await import('./agenda.js');
    const t = await agenda.tokenIcs(m === 'POST' && (await cuerpo(req)).nuevo === true);
    const base = String(config.panelUrl || `https://${req.headers.host}`).replace(/\/+$/, '');
    return json(res, 200, { url: `${base}/cal/${t}.ics`, webcal: `${base.replace(/^https?:/, 'webcal:')}/cal/${t}.ics` });
  }
  if (m === 'POST' && p === '/api/recordatorios') {
    try { return json(res, 200, { id: await (await import('./agenda.js')).recordar(await cuerpo(req)) }); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (m === 'POST' && (r = p.match(/^\/api\/recordatorios\/(\d+)\/mover$/))) {
    try { await (await import('./agenda.js')).mover(Number(r[1]), await cuerpo(req)); return json(res, 200, { ok: true }); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (m === 'POST' && (r = p.match(/^\/api\/recordatorios\/(\d+)\/(hecho|pendiente|borrar)$/))) {
    const agenda = await import('./agenda.js');
    if (r[2] === 'borrar') await agenda.borrar(Number(r[1])); else await agenda.marcarHecho(Number(r[1]), r[2] === 'hecho');
    return json(res, 200, { ok: true });
  }
  if (m === 'POST' && p === '/api/calendario/externo') {
    try { return json(res, 200, { id: await aprobaciones.apuntarExterno(await cuerpo(req)) }); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (m === 'POST' && (r = p.match(/^\/api\/calendario\/externo\/(\w+)\/quitar$/))) {
    try { await aprobaciones.quitarExterno(r[1]); return json(res, 200, { ok: true }); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (m === 'POST' && p === '/api/vida/fiesta') { await vida.fiesta(); return json(res, 200, { ok: true }); }
  if (m === 'GET' && p === '/api/calendario') {
    const d = url.searchParams.get('desde'), h = url.searchParams.get('hasta');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '') || !/^\d{4}-\d{2}-\d{2}$/.test(h || '')) return json(res, 400, { error: 'Fechas no válidas' });
    return json(res, 200, await aprobaciones.calendario(d, h));
  }
  if (m === 'GET' && p === '/api/calendario/sugerencia') {
    const ap = url.searchParams.get('id') ? (await q(`SELECT id, canal, fecha_prevista FROM aprobaciones WHERE id=$1`, [url.searchParams.get('id')])).rows[0] : null;
    return json(res, 200, await aprobaciones.sugerencia(ap?.canal || url.searchParams.get('canal'), { fecha_prevista: ap?.fecha_prevista, excluir: ap?.id }));
  }
  if (m === 'POST' && (r = p.match(/^\/api\/aprobaciones\/(\w+)\/reprogramar$/))) {
    const b = await cuerpo(req);
    try { await aprobaciones.reprogramar(r[1], b.cuando, b.ambas); return json(res, 200, { ok: true }); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (m === 'POST' && (r = p.match(/^\/api\/aprobaciones\/(\w+)\/desprogramar$/))) {
    try { await aprobaciones.desprogramar(r[1]); return json(res, 200, { ok: true }); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (m === 'POST' && (r = p.match(/^\/api\/aprobaciones\/(\w+)\/posponer$/))) {
    const b = await cuerpo(req);
    try { return json(res, 200, await aprobaciones.posponer(r[1], { dias: b.dias, hasta: b.hasta, llamada: Boolean(b.llamada) })); }
    catch (e) { return json(res, e.status || 400, { error: e.message }); }
  }
  if (m === 'GET' && (r = p.match(/^\/api\/aprobaciones\/(\w+)\/sugerencia$/))) {
    try { return json(res, 200, await aprobaciones.sugerirCuando(r[1])); } catch (e) { return json(res, e.status || 400, { error: e.message }); }
  }
  if (m === 'POST' && (r = p.match(/^\/api\/aprobaciones\/(\w+)\/cambios$/))) {
    const b = await cuerpo(req);
    if (!b.texto?.trim()) return json(res, 400, { error: 'Escribe qué quieres cambiar.' });
    const ap = await aprobaciones.pedirCambios(r[1], b.texto.trim());
    return ap ? json(res, 200, { ok: true }) : json(res, 409, { error: 'Ya estaba resuelta o no existe.' });
  }

  if (m === 'POST' && (r = p.match(/^\/api\/agentes\/(\w+)\/gracias$/))) {
    const ag = nombreAgente(r[1]);
    if (!ag) return json(res, 404, { error: 'No existe ese agente' });
    const b = await cuerpo(req);
    return json(res, 200, { total: await darGracias(ag, b.motivo) });
  }
  // Objetivos: Rafa los convierte en un plan para el equipo
  if (m === 'GET' && p === '/api/objetivos') return json(res, 200, await (await import('./objetivos.js')).listar());
  if (m === 'POST' && p === '/api/objetivos') { try { return json(res, 201, await (await import('./objetivos.js')).crear((await cuerpo(req)).texto)); } catch (e) { return json(res, 400, { error: e.message }); } }
  if (m === 'GET' && (r = p.match(/^\/api\/objetivos\/(\d+)$/))) { const o = await (await import('./objetivos.js')).detalle(Number(r[1])); return o ? json(res, 200, o) : json(res, 404, { error: 'No existe ese objetivo' }); }
  if (m === 'POST' && (r = p.match(/^\/api\/objetivos\/(\d+)\/detener$/))) { try { return json(res, 200, await (await import('./objetivos.js')).detener(Number(r[1]))); } catch (e) { return json(res, 400, { error: e.message }); } }
  // Lo que suele costar un encargo a cada agente (para enseñarlo antes de encargar)
  if (m === 'GET' && p === '/api/estimar') return json(res, 200, await presupuesto.costesTipicos());
  // Chat de la oficina (tipo Slack)
  if (m === 'GET' && p === '/api/chat') return json(res, 200, { canales: await chat.canales({ vida: vida.estaActiva() }) });
  if (m === 'GET' && (r = p.match(/^\/api\/chat\/(\w+)$/))) {
    try { return json(res, 200, await chat.historial(r[1], { antes: url.searchParams.get('antes'), limite: url.searchParams.get('limite') })); }
    catch (e) { return json(res, 404, { error: e.message }); }
  }
  if (m === 'POST' && (r = p.match(/^\/api\/chat\/(\w+)$/))) {
    const b = await cuerpo(req);
    try { return json(res, 201, await chat.deDueno(r[1], b.texto)); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (m === 'GET' && (r = p.match(/^\/api\/agentes\/(\w+)\/conversacion$/))) {
    if (!AGENTES[r[1]]) return json(res, 404, { error: 'No existe ese agente' });
    const c = await q(`SELECT id, instruccion AS pregunta, resultado AS respuesta, estado, creada, terminada FROM tareas WHERE agente=$1 AND tipo='pregunta' ORDER BY id DESC LIMIT 15`, [r[1]]);
    return json(res, 200, c.rows.reverse());
  }
  if (m === 'POST' && (r = p.match(/^\/api\/agentes\/(\w+)\/pregunta$/))) {
    const ag = nombreAgente(r[1]);
    const b = await cuerpo(req);
    if (!ag || !b.texto?.trim()) return json(res, 400, { error: 'Indica el agente y la pregunta.' });
    await preguntar(ag, b.texto.trim(), { via: 'ficha' });
    return json(res, 201, { ok: true });
  }
  if (m === 'GET' && p === '/api/agenda') return json(res, 200, await planificador.agenda());
  if (m === 'GET' && p === '/api/informes') return json(res, 200, (await q(`SELECT id, agente, tipo, titulo, empresa_id, creada FROM informes ORDER BY id DESC LIMIT 50`)).rows);
  if (m === 'GET' && (r = p.match(/^\/api\/aprobaciones\/(\w+)\/documento\.pdf$/))) {
    const pdf = await (await import('./documento.js')).deAprobacion(r[1]);
    if (!pdf) return json(res, 404, { error: 'Ese documento ya no existe' });
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `${url.searchParams.has('descargar') ? 'attachment' : 'inline'}; filename="${pdf.nombre}"`, 'Cache-Control': 'no-store' });
    return res.end(pdf.datos);
  }
  // Enviar por correo desde cualquier tarjeta, por la cuenta que elijas; y las cuentas enlazadas
  if (m === 'GET' && (r = p.match(/^\/api\/aprobaciones\/(\w+)\/correo$/))) {
    const b = url.searchParams.get('documento') ? await correo.borradorDeDocumento(r[1]) : await correo.borradorDeTarjeta(r[1]);
    return b ? json(res, 200, b) : json(res, 404, { error: 'Esa tarjeta ya no está en la mesa' });
  }
  if (m === 'POST' && (r = p.match(/^\/api\/aprobaciones\/(\w+)\/correo$/))) {
    try { const b = await cuerpo(req); await (b.documento ? correo.enviarDocumento(r[1], b) : correo.enviarDesdeTarjeta(r[1], b)); return json(res, 200, { ok: true }); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (m === 'POST' && p === '/api/correo/vista') { const b = await cuerpo(req); return json(res, 200, { html: await correo.vista(b) }); }
  if (PRO.vigilante && m === 'GET' && p === '/api/vigilante') return json(res, 200, { ultimo: await ajuste('vigilante_ultimo', null), correo: await ajuste('vigilante_correo', null), cambios: await ajuste('cambios_rafa', []), fallos: await ajuste('fallos_app', []) });
  if (PRO.vigilante && m === 'POST' && p === '/api/vigilante') {
    const v = M.vigilante;
    if ((await cuerpo(req)).correo) await v.probarCorreo();
    return json(res, 200, await v.revisar());
  }
  if (m === 'GET' && p === '/api/correo/cuentas/comprobar') return json(res, 200, await cuentasCorreo.comprobar(url.searchParams.get('cuenta')));
  if (m === 'GET' && p === '/api/correo/cuentas') return json(res, 200, cuentasCorreo.listar());
  if (m === 'POST' && p === '/api/correo/cuentas') { try { return json(res, 200, await cuentasCorreo.guardar(await cuerpo(req))); } catch (e) { return json(res, 400, { error: e.message }); } }
  if (m === 'POST' && (r = p.match(/^\/api\/correo\/cuentas\/([\w-]+)\/(predeterminada|quitar)$/))) {
    try { return json(res, 200, await (r[2] === 'quitar' ? cuentasCorreo.quitar(r[1]) : cuentasCorreo.predeterminar(r[1]))); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  // Rehacer el documento con gráficos: lo prepara Nuria y sigue pasando por la mesa
  if (m === 'POST' && (r = p.match(/^\/api\/aprobaciones\/(\w+)\/documento\/rehacer$/))) {
    const a = (await q(`SELECT a.id, a.titulo, a.texto, a.empresa_id, e.nombre, e.email, e.decisor FROM aprobaciones a LEFT JOIN empresas e ON e.id=a.empresa_id WHERE a.id=$1`, [r[1]])).rows[0];
    if (!a) return json(res, 404, { error: 'Ese documento ya no existe' });
    await tareas.crear(PRO.ines ? 'ines' : 'nuria', `Rehaz este documento para ${a.nombre || 'el cliente'} con pedir_aprobacion (tipo 'propuesta') y su «documento» por partes, para que salga con gráficos. Sin inventar cifras. Lo que hay ahora:\n\n${String(a.texto || '').slice(0, 6000)}`, { empresa_id: a.empresa_id, origen: 'dueno' });
    return json(res, 200, { ok: true });
  }
  if (m === 'GET' && (r = p.match(/^\/api\/aprobaciones\/(\w+)\/imagen$/))) {
    const im = (await q(`SELECT png FROM imagenes WHERE aprobacion_id=$1`, [r[1]])).rows[0];
    if (!im) return json(res, 404, { error: 'Sin imagen' });
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=300' }); return res.end(im.png);
  }
  if (m === 'GET' && (r = p.match(/^\/api\/aprobaciones\/(\w+)\/video$/))) {
    const mp4 = await video.mp4De(r[1]);
    return mp4 ? servirVideo(req, res, mp4, url.searchParams.has('descargar') ? `video-${r[1]}.mp4` : null) : json(res, 404, { error: 'Todavía no hay vídeo.' });
  }
  if (m === 'POST' && (r = p.match(/^\/api\/aprobaciones\/(\w+)\/video$/))) {
    try { return json(res, 202, await video.generar(r[1])); } catch (e) { return json(res, e.status || 400, { error: e.message }); }
  }
  if (m === 'GET' && (r = p.match(/^\/api\/aprobaciones\/(\w+)$/))) {
    const ap = (await q(`SELECT id, agente, tipo, titulo, texto, estado, empresa_id, enlace, creada, resuelta FROM aprobaciones WHERE id=$1`, [r[1]])).rows[0];
    return ap ? json(res, 200, ap) : json(res, 404, { error: 'No existe' });
  }
  if (m === 'GET' && (r = p.match(/^\/api\/informes\/(\d+)$/))) {
    const i = (await q(`SELECT * FROM informes WHERE id=$1`, [Number(r[1])])).rows[0];
    return i ? json(res, 200, i) : json(res, 404, { error: 'No existe ese informe' });
  }
  if (m === 'GET' && p === '/api/presupuesto') return json(res, 200, { ...(await presupuesto.ajustes()), ...(await presupuesto.gastoMes()), ritmo: await presupuesto.ritmo() });
  if (m === 'POST' && p === '/api/presupuesto') {
    try {
      const b = await cuerpo(req), antes = await presupuesto.ajustes();
      const g = await presupuesto.cambiar(b);
      const per = g.periodo === 'semana' ? 'esta semana' : 'este mes';
      if (b.extra) await bus.log('dueno', `ha añadido ${b.extra} € al presupuesto de IA de ${per}.`);
      if (b.turbo !== undefined && Boolean(b.turbo) !== antes.turbo) await bus.log('dueno', b.turbo ? 'ha activado el modo turbo: el equipo busca, puntúa y prepara dossiers sin topes diarios mientras quede presupuesto.' : 'ha vuelto al ritmo normal de trabajo.');
      if (b.turbo && !antes.turbo) planificador.arrancarTurbo().catch(e => console.error('Turbo:', e.message));
      if (b.esteperiodo !== undefined) await bus.log('dueno', b.esteperiodo === 0 || b.esteperiodo === '0' ? `deja el presupuesto de IA de ${per} a 0 €: el equipo descansa.` : `pone el presupuesto de IA de ${per} en ${g.limite} €.`);
      if (b.modo || b.eur !== undefined) await bus.log('dueno', `cambia el presupuesto de IA a ${g.base} € ${g.modo === 'semanal' ? 'por semana' : 'al mes'}.`);
      await bus.emitir({ tipo: 'gasto', ...g });
      return json(res, 200, { ...g, ritmo: await presupuesto.ritmo() });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (m === 'GET' && p === '/api/busqueda/objetivo') return json(res, 200, { ...(await busqueda.estado()), maps: fuentes.estadoMaps() });
  if (m === 'GET' && p === '/api/busqueda/estimar') {
    try { return json(res, 200, await busqueda.estimar({ cantidad: url.searchParams.get('cantidad'), periodo: url.searchParams.get('periodo') })); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (m === 'POST' && p === '/api/busqueda/objetivo') {
    try {
      const o = await busqueda.fijar(await cuerpo(req));
      const st = await busqueda.estado();
      await bus.log('dueno', !o ? 'ha quitado el objetivo de empresas: Lucía busca cuando se vacía la cola.' : !o.cantidad ? 'ha decidido que esta oficina no busque empresas nuevas.'
        : `quiere encontrar ${o.cantidad} empresas ${o.periodo === 'dia' ? 'al día' : 'a la semana'}: unos ${st.estimacion.eur_mes_min}–${st.estimacion.eur_mes_max} € de IA al mes y unos ${st.estimacion.contactos_semana} contactos a la semana en su mesa.`);
      return json(res, 200, st);
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (m === 'POST' && p === '/api/fuentes/maps') { try { return json(res, 200, await fuentes.conectarMaps((await cuerpo(req)).clave)); } catch (e) { return json(res, 400, { error: e.message }); } }
  if (m === 'POST' && p === '/api/fuentes/maps/quitar') return json(res, 200, await fuentes.quitarMaps());
  if (m === 'GET' && p === '/api/gasto/ritmo') return json(res, 200, await presupuesto.ritmo());
  if (m === 'GET' && p === '/api/gasto/dias') return json(res, 200, await presupuesto.porDia(url.searchParams.get('dias')));
  if (m === 'GET' && p === '/api/gasto/resumen') return json(res, 200, await presupuesto.resumen());
  if (m === 'GET' && p === '/api/reunion') return json(res, 200, (await reunion.ultima()) || {});
  if (m === 'POST' && p === '/api/reunion') {
    reunion.celebrar({ convoca: 'dueno' }).catch(e => bus.log('rafa', `no ha podido cerrar la reunión: ${e.message}`));
    return json(res, 202, { ok: true });
  }
  if (m === 'POST' && p === '/api/reunion/respuesta') {
    const b = await cuerpo(req);
    try { await reunion.responder({ agente: b.agente, necesidad: b.necesidad, texto: b.texto }); } catch (e) { return json(res, 400, { error: e.message }); }
    return json(res, 200, { ok: true });
  }
  if (m === 'GET' && p === '/api/vida') return json(res, 200, await vida.paraPanel());
  if (m === 'POST' && p === '/api/vida') { const b = await cuerpo(req); await vida.fijar(b.activa); return json(res, 200, await vida.paraPanel()); }
  if (m === 'GET' && p === '/api/linkedin') return json(res, 200, await linkedin.estado());
  if (m === 'GET' && p === '/api/telegram') return json(res, 200, await telegram.estado());
  if (m === 'POST' && p === '/api/telegram') { try { return json(res, 200, await telegram.configurar((await cuerpo(req)).token)); } catch (e) { return json(res, 400, { error: e.message }); } }
  if (m === 'POST' && p === '/api/telegram/prueba') { try { await telegram.prueba(); return json(res, 200, { ok: true }); } catch (e) { return json(res, 400, { error: e.message }); } }
  if (m === 'GET' && p === '/api/chats') return json(res, 200, await chats.estado());
  if (m === 'POST' && p === '/api/chats/telegram') { try { return json(res, 200, await chats.guardarTelegram((await cuerpo(req)).token)); } catch (e) { return json(res, 400, { error: e.message }); } }
  if (m === 'POST' && p === '/api/chats/telegram/desconectar') { await chats.desconectarTelegram(); return json(res, 200, await chats.estado()); }
  // Claves de la IA (Claude o OpenRouter): se pegan en Configuración → Inteligencia artificial
  if (m === 'GET' && p === '/api/ia') return json(res, 200, await ia.estado());
  if (m === 'POST' && p === '/api/ia') { try { return json(res, 200, await ia.guardar(await cuerpo(req))); } catch (e) { console.warn('IA: no se guarda:', e.message); return json(res, 400, { error: e.message }); } }
  // Primer uso: Rafa ayuda a configurar el resto (arranque.js)
  if (m === 'GET' && p === '/api/arranque') return json(res, 200, await arranque.estado());
  if (m === 'POST' && p === '/api/arranque/mensaje') { try { return json(res, 200, await arranque.conversar((await cuerpo(req)).texto)); } catch (e) { return json(res, 400, { error: e.message }); } }
  if (m === 'POST' && p === '/api/arranque/terminar') return json(res, 200, await arranque.terminar(await cuerpo(req)));
  // Departamentos que usa esta empresa
  if (m === 'GET' && p === '/api/departamentos') return json(res, 200, await departamentos.paraConfiguracion());
  // Los que crea cada empresa: al guardar o borrar, el panel se recarga para dibujarlos
  if (m === 'POST' && p === '/api/departamentos/propio') {
    const b = await cuerpo(req);
    try { const d = await departamentos.guardarPropio(b); await bus.log('dueno', `ha ${b.id ? 'cambiado' : 'creado'} el departamento «${d.nombre}».`); return json(res, 200, d); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (m === 'POST' && p === '/api/departamentos/quitar') {
    try { const d = await departamentos.quitarPropio((await cuerpo(req)).id); await bus.log('dueno', `ha borrado el departamento «${d.nombre}». Lo que tenía pendiente pasa a Rafa.`); return json(res, 200, { ok: true }); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (m === 'GET' && p === '/api/modulos') return json(res, 200, modulos.listar());
  if (m === 'POST' && p === '/api/modulos') {
    const { activos } = await cuerpo(req);
    if (!Array.isArray(activos)) return json(res, 400, { error: 'Faltan los módulos.' });
    await modulos.guardar(activos);
    await bus.log('dueno', 'ha cambiado los módulos que usa la empresa.');
    return json(res, 200, modulos.listar());
  }
  if (m === 'POST' && p === '/api/departamentos') {
    try { await departamentos.guardar((await cuerpo(req)).activos); } catch (e) { return json(res, 400, { error: e.message }); }
    await bus.log('dueno', 'ha cambiado los departamentos de la empresa.');
    return json(res, 200, departamentos.listar());
  }
  if (m === 'POST' && p === '/api/ia/quitar') { try { return json(res, 200, await ia.quitar((await cuerpo(req)).cual)); } catch (e) { return json(res, 400, { error: e.message }); } }
  if (m === 'GET' && p === '/api/llamar/consejo') return json(res, 200, await (await import('./horario.js')).consejoHora(url.searchParams.get('empresa_id')));
  if (m === 'GET' && p === '/api/perfil') return json(res, 200, perfil.leer());
  if (m === 'POST' && p === '/api/perfil') {
    const r = await perfil.guardar(await cuerpo(req));
    await bus.log('dueno', 'ha actualizado la ficha de la empresa en Configuración: el equipo ya la tiene en cuenta.');
    return json(res, 200, r);
  }
  if (m === 'POST' && p === '/api/idioma') { try { return json(res, 200, await perfil.fijarIdioma((await cuerpo(req)).idioma)); } catch (e) { return json(res, 400, { error: e.message }); } }
  if (m === 'POST' && p === '/api/perfil/leer-web') { try { await perfil.leerWeb(); return json(res, 200, perfil.leer()); } catch (e) { return json(res, 400, { error: e.message }); } }
  if (m === 'GET' && p === '/api/marca') return json(res, 200, { ...marca.leer(), por_defecto: marca.POR_DEFECTO });
  if (m === 'POST' && p === '/api/marca') {
    const r = await marca.guardar(await cuerpo(req));
    await bus.log('dueno', 'ha actualizado la imagen de marca en Configuración: las próximas imágenes ya salen así.');
    return json(res, 200, { ...r, por_defecto: marca.POR_DEFECTO });
  }
  if (m === 'POST' && p === '/api/marca/muestra') {
    const b = await cuerpo(req);
    const imagen = disenio.png({ titular: String(b.titular || 'Así quedan tus imágenes.').slice(0, 140), destacado: String(b.destacado || '').slice(0, 140) }, marca.limpiar(b));
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    return res.end(imagen);
  }
  if (m === 'GET' && p === '/api/marca/logo') {
    const l = disenio.logoActual();
    if (!l) return json(res, 404, { error: 'Sin logo' });
    res.writeHead(200, { 'Content-Type': l.tipo, 'Cache-Control': 'no-store' });
    return res.end(l.bytes);
  }
  if (m === 'POST' && p === '/api/marca/logo') {
    try { return json(res, 200, await marca.ponerLogo(disenio.logoDeSubida((await cuerpo(req, 3_000_000)).imagen))); }
    catch (e) { return json(res, e.codigo || 400, { error: e.message }); }
  }
  if (m === 'DELETE' && p === '/api/marca/logo') return json(res, 200, await marca.ponerLogo(null));
  if (m === 'GET' && p === '/api/facebook') return json(res, 200, await facebook.estado());
  if (m === 'GET' && p === '/api/facebook/conectar') {
    try { res.writeHead(302, { Location: facebook.urlConexion() }); return res.end(); }
    catch (e) { res.writeHead(302, { Location: '/?facebook=error&motivo=' + encodeURIComponent(e.message) }); return res.end(); }
  }
  if (m === 'POST' && p === '/api/facebook/app') { try { return json(res, 200, await facebook.guardarApp(await cuerpo(req))); } catch (e) { return json(res, 400, { error: e.message }); } }
  if (m === 'POST' && p === '/api/facebook/desconectar') { await facebook.desconectar(); await aprobaciones.actualizarOpcionesPosts().catch(() => {}); return json(res, 200, await facebook.estado()); }
  if (m === 'GET' && p === '/api/linkedin/conectar') {
    try { res.writeHead(302, { Location: linkedin.urlConexion() }); return res.end(); }
    catch (e) { res.writeHead(302, { Location: '/?linkedin=error&motivo=' + encodeURIComponent(e.message) }); return res.end(); }
  }
  if (m === 'POST' && p === '/api/linkedin/app') { try { return json(res, 200, await linkedin.guardarApp(await cuerpo(req))); } catch (e) { return json(res, 400, { error: e.message }); } }
  if (m === 'POST' && p === '/api/facebook/auto') { const b = await cuerpo(req); await facebook.fijarAutopublicar(b.activa); await aprobaciones.actualizarOpcionesPosts().catch(() => {}); await bus.log('dueno', b.activa ? 'ha activado la publicación automática en Facebook: los posts salen solos en su fecha si no los para.' : 'ha desactivado la publicación automática en Facebook: nada se publica sin su clic.'); return json(res, 200, await facebook.estado()); }
  if (m === 'POST' && p === '/api/linkedin/auto') { const b = await cuerpo(req); await linkedin.fijarAutopublicar(b.activa); await bus.log('dueno', b.activa ? 'ha activado la publicación automática en LinkedIn: los posts salen solos en su fecha si no los para.' : 'ha desactivado la publicación automática en LinkedIn: nada se publica sin su clic.'); return json(res, 200, await linkedin.estado()); }
  if (m === 'POST' && p === '/api/linkedin/desconectar') { await linkedin.desconectar(); await aprobaciones.actualizarOpcionesPosts().catch(() => {}); return json(res, 200, await linkedin.estado()); }
  if (m === 'GET' && p === '/api/origenes') return json(res, 200, { por_origen: await empresas.embudoPorOrigen(), entradas: await entradas.recientes(20) });
  if (m === 'GET' && p === '/api/alianzas') return json(res, 200, await alianzas.listar({ tipo: url.searchParams.get('tipo') || undefined, limite: 200 }));
  if (m === 'GET' && p === '/api/premios') return json(res, 200, { mes: premios.mesDe(), clasificacion: await premios.clasificacion(), ultimo: await premios.ultimo() });
  if (m === 'GET' && p === '/api/contenido') {
    const pend = (await q(`SELECT id, agente, tipo, canal, fecha_prevista::text AS fecha_prevista, titulo, creada FROM aprobaciones
                            WHERE estado='pendiente' AND tipo IN ('post','video','articulo','boletin','anuncio') ORDER BY coalesce(fecha_prevista, creada::date)`)).rows;
    return json(res, 200, { pendiente: pend, publicado: await memoria.publicaciones(60) });
  }
  if (m === 'GET' && p === '/api/ausencia') return json(res, 200, await ausencia.estado());
  if (m === 'POST' && p === '/api/ausencia') {
    const b = await cuerpo(req);
    if (b.vacaciones) {
      if (b.hasta && (!/^\d{4}-\d{2}-\d{2}$/.test(b.hasta) || b.hasta < ausencia.hoy())) return json(res, 400, { error: 'La fecha de vuelta tiene que ser hoy o más adelante.' });
      await ausencia.irse(b.hasta || null);
    } else {
      const r = await ausencia.volver();
      if (r) await alVolver(r);
    }
    return json(res, 200, await ausencia.estado());
  }
  if (m === 'GET' && p === '/api/plantilla') return json(res, 200, plantilla.listar());
  if ((m === 'POST' || m === 'DELETE') && (r = p.match(/^\/api\/plantilla\/(\w+)$/))) {
    try { return json(res, 200, m === 'POST' ? await plantilla.guardar(r[1], await cuerpo(req)) : await plantilla.restablecer(r[1])); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (m === 'GET' && p === '/api/atascos') return json(res, 200, await (await import('./atascos.js')).paraPanel());
  if (m === 'POST' && (r = p.match(/^\/api\/atascos\/(\d+)$/))) {
    const hecho = await (await import('./atascos.js')).atender(Number(r[1]), await cuerpo(req));
    return hecho ? json(res, 200, hecho) : json(res, 404, { error: 'Ese atasco ya está resuelto.' });
  }
  if (m === 'GET' && p === '/api/reglas') return json(res, 200, await aprendizajes.reglas());
  if (m === 'POST' && p === '/api/reglas') {
    const b = await cuerpo(req);
    if (!b.texto?.trim()) return json(res, 400, { error: 'Escribe la regla.' });
    const rg = await aprendizajes.nuevaRegla(b.texto, nombreAgente(b.agente));
    await bus.log('dueno', `ha añadido una regla: «${rg.texto}»`);
    return json(res, 201, rg);
  }
  if (m === 'DELETE' && (r = p.match(/^\/api\/reglas\/(\d+)$/))) return json(res, 200, { ok: await aprendizajes.quitar(Number(r[1])) });

  if (m === 'POST' && p === '/api/pausa') {
    const b = await cuerpo(req);
    if (b.pausado) await motor.pausar('Pausa desde el panel'); else await motor.reanudar();
    return json(res, 200, { pausado: Boolean(b.pausado) });
  }
  if (m === 'GET' && p === '/api/gasto') return json(res, 200, { ...(await presupuesto.gastoMes()), por_agente: await presupuesto.porAgenteMes() });

  json(res, 404, { error: 'No encontrado' });
}

// ---------- gracias y preguntas ----------
async function darGracias(ag, motivo) {
  const total = await aprendizajes.gracias(ag, motivo);
  await bus.emitir({ tipo: 'gracias', agente: ag, total });
  await bus.log('dueno', `le ha dado las gracias a ${AGENTES[ag].nombre}${motivo ? `: «${motivo.slice(0, 140)}»` : '.'}`);
  vida.emitirAnimo().catch(() => {});
  return total;
}
async function preguntar(ag, texto, { contexto = '', via = 'telegram' } = {}) {
  const t = await tareas.crear(ag, texto + contexto, { origen: 'dueno', tipo: 'pregunta' });
  await bus.log('dueno', `le pregunta a ${AGENTES[ag].nombre}: «${texto.slice(0, 140)}»`);
  // También queda en vuestro privado del chat (y ahí te contesta)
  await chat.escribir({ canal: ag, autor: 'dueno', para: ag, texto, via, tarea_id: t.id }).catch(e => console.error('Chat:', e.message));
  return chat.avisarPausa(ag, ag);
}

// ---------- Telegram ----------
const esperandoRespuesta = new Map();   // mensaje de Telegram en el que te pedí la respuesta → aprobación
telegram.alPulsar(async (id, resultado, msgId) => {
  const ap = await aprobaciones.resolver(id, resultado).catch(async e => { console.error('Botón:', e.message); await telegram.avisar(`⚠️ No se ha podido: ${e.message}`, { ahora: true }); return null; });
  if (ap?.generando) await telegram.avisar('⏳ Generando el vídeo. Te aviso aquí cuando esté.', { ahora: true });
  if (ap?.pideTexto) {
    const m = await telegram.pedirRespuesta(msgId, '✍️ Contesta a ESTE mensaje con lo que te ha dicho (o un resumen) y Paula te prepara la respuesta.');
    if (m?.message_id) esperandoRespuesta.set(m.message_id, id);
  }
});

telegram.alResponder(async (msgId, texto, citado = '') => {
  const id = esperandoRespuesta.get(msgId) || await aprobaciones.porMensajeTelegram(msgId);
  if (!id) {
    // Contesta a un informe, a una opinión o a un aviso: se lo pasamos a quien lo escribió (o a Rafa)
    const m = citado.match(/^(?:📊 Informe de|💬)\s*([A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+)/u);
    const ag = (m && nombreAgente(m[1])) || 'rafa';
    const contexto = citado ? `\n\nLo que Dirección está contestando:\n«${citado.slice(0, 1500)}»` : '';
    if (ag === 'rafa') {
      await tareas.crear('rafa', `Dirección contesta por Telegram a un mensaje: «${texto}»${contexto}`, { origen: 'dueno' });
      await bus.log('dueno', `contesta a Rafa: «${texto.slice(0, 140)}»`);
      return chat.textoPausa('rafa');
    }
    return preguntar(ag, texto, { contexto });   // contesta el agente; en pausa, se avisa
  }
  const previa = (await q(`SELECT ref, estado FROM aprobaciones WHERE id=$1`, [id])).rows[0];
  if (previa && /^(paso|ctl):/.test(previa.ref || '')) {
    if (previa.estado !== 'pendiente') return 'Ese paso ya estaba resuelto.';
    esperandoRespuesta.delete(msgId);
    await aprobaciones.resolver(id, 'respondido', texto);
    return '💬 Apuntado. Paula te prepara la contestación y te la deja en la mesa.';
  }
  const ap = await aprobaciones.pedirCambios(id, texto);
  return ap ? `✏️ Hecho. ${AGENTES[ap.agente]?.nombre ?? ap.agente} lo rehace con tu corrección y la tendrá en cuenta a partir de ahora.` : 'Ese trabajo ya estaba resuelto.';
});

telegram.alEscribir(async texto => {
  // «Mateo, ¿por qué…?» o «Carmen: …» → habla directamente con ese agente
  const m = texto.match(/^\s*@?([A-Za-zÁÉÍÓÚáéíóúÑñ]+)\s*[,:]\s*([\s\S]+)$/);
  const ag = m && nombreAgente(m[1]);
  if (ag && ag !== 'rafa') return preguntar(ag, m[2].trim());
  const cuerpoTexto = ag === 'rafa' ? m[2].trim() : texto;
  await tareas.crear('rafa', `Dirección te escribe por Telegram: «${cuerpoTexto}»`, { origen: 'dueno' });
  await bus.log('dueno', `ha escrito a Rafa: «${cuerpoTexto.slice(0, 140)}»`);
  return chat.textoPausa('rafa');   // Rafa contesta él mismo; en pausa, se avisa
});

// ---------- modo ausencia ----------
telegram.fijarPolitica({
  silencio: async () => (await ausencia.estado()).silencio,
  encolar: ausencia.encolar,
  actividad: ausencia.marcarActividad,
});

/** Al despertar o al volver: un resumen y lo que haya en la mesa, en ese orden. */
async function vaciarAvisos(cabecera) {
  const r = await ausencia.vaciarCola(telegram, { cabecera });
  if (r && r.aprobaciones?.length) await aprobaciones.enviarPendientesTelegram();
  return r;
}
async function alVolver(r) {
  await vaciarAvisos(`🏠 Bienvenido, Dirección. Has estado fuera ${r.dias} día${r.dias === 1 ? '' : 's'}.
` +
    `Mientras tanto: ${r.empresas} empresa${r.empresas === 1 ? '' : 's'} nueva${r.empresas === 1 ? '' : 's'} y ${r.dossiers} dossier${r.dossiers === 1 ? '' : 's'}. ` +
    `Tienes ${r.mesa} cosa${r.mesa === 1 ? '' : 's'} en tu mesa. Las secuencias se han movido ${r.dias} días para que no se te junten.`);
}
export const despertar = () => vaciarAvisos('☀️ Buenos días, Dirección. Esto es lo que ha pasado mientras dormías:');
export { alVolver };

const fechaTelegram = s => {
  const m = String(s || '').match(/(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?/);
  if (!m) return null;
  const hoy = ausencia.hoy(); let y = m[3] ? Number(m[3].length === 2 ? '20' + m[3] : m[3]) : Number(hoy.slice(0, 4));
  let f = `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  if (!m[3] && f < hoy) f = `${y + 1}${f.slice(4)}`;
  return isNaN(new Date(f + 'T12:00:00Z')) ? null : f;
};

telegram.alComando(async (cmd, args) => {
  switch (cmd) {
    case 'vacaciones': {
      const hasta = args.trim() ? fechaTelegram(args) : null;
      if (args.trim() && !hasta) return 'No entiendo la fecha. Ejemplo: /vacaciones hasta 15/11';
      await ausencia.irse(hasta);
      return `🏖 Disfruta${hasta ? `. Te espero el ${new Date(hasta + 'T12:00:00Z').toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })}` : ''}.\n` +
        'Lucía, Mateo, Carmen y Sara siguen investigando. Javi, Álex y Nuria no preparan nada nuevo para tu mesa, y las secuencias se congelan.\n' +
        'No te escribo hasta que vuelvas (si me escribes, te contesto). Para volver: /vuelvo';
    }
    case 'vuelvo': {
      const r = await ausencia.volver();
      if (!r) return 'No constabas de vacaciones. ¡Bienvenido igualmente!';
      await alVolver(r);
      return null;
    }
    case 'reunion': {
      reunion.celebrar({ convoca: 'dueno' }).catch(e => telegram.avisar(`⚠️ La reunión no ha podido cerrarse: ${e.message}`, { ahora: true }));
      return '🗣 Convoco la reunión de equipo. En un par de minutos te mando el acta.';
    }
    case 'start':
    case 'ayuda':
      return 'Comandos:\n/estado — embudo, pendientes y gasto\n/encargar <agente> <instrucción>\n/pregunta <agente> <pregunta> — su opinión sincera\n/objetivo <texto> — Rafa prepara un plan con el equipo\n/gracias <agente> [motivo]\n/regla <texto> — norma fija para el equipo\n/reglas — ver reglas\n/quitar <n> — quitar una regla\n/reunion — reunión de equipo ahora\n/pausa · /reanudar\n/turbo [off] — trabajar sin topes diarios\n/empujon 10 — 10 € más este periodo\n/vacaciones [hasta 15/11] · /vuelvo\n\nResponde a un trabajo para pedir cambios.\nEmpieza con un nombre para hablar con ese agente («Mateo, …»).\nEscribe sin nombre para hablar con Rafa, el director.';
    case 'turbo': {
      const on = !/^(off|no|apagar|parar|0)$/i.test(args.trim());
      const g = await presupuesto.cambiar({ turbo: on });
      await bus.log('dueno', on ? 'ha activado el modo turbo: el equipo busca, puntúa y prepara dossiers sin topes diarios mientras quede presupuesto.' : 'ha vuelto al ritmo normal.');
      await bus.emitir({ tipo: 'gasto', ...g });
      if (on) planificador.arrancarTurbo().catch(e => console.error('Turbo:', e.message));
      return on ? `🚀 Turbo activado. Gastado ${g.eur.toFixed(2)} € de ${g.limite} € ${g.periodo === 'semana' ? 'esta semana' : 'este mes'}. Para pararlo: /turbo off` : '🐢 Ritmo normal.';
    }
    case 'empujon': {
      const n = Number(String(args).replace(',', '.').replace(/[^\d.]/g, ''));
      if (!(n > 0)) return 'Uso: /empujon 10 (añade 10 € al presupuesto de este periodo)';
      const g = await presupuesto.cambiar({ extra: n });
      await bus.log('dueno', `ha añadido ${n} € al presupuesto de IA ${g.periodo === 'semana' ? 'de esta semana' : 'de este mes'}.`);
      await bus.emitir({ tipo: 'gasto', ...g });
      return `💶 Hecho: ${g.eur.toFixed(2)} € de ${g.limite} € ${g.periodo === 'semana' ? 'esta semana' : 'este mes'}.`;
    }
    case 'estado': {
      const s = await snapshotCompleto();
      const e = s.embudo;
      return `📊 Embudo\nEncontradas ${e.universo} · Puntuadas ${e.puntuadas} · Dossier ${e.dossier}\nContactadas ${e.contactadas} · Conversación ${e.conversacion} · Reuniones ${e.reunion}\nPropuestas ${e.propuesta} · Clientes ${e.ganadas}\n\n📝 En tu mesa: ${s.aprobaciones.length}\n💶 Gasto de IA ${s.gasto.periodo === 'semana' ? 'de la semana' : 'del mes'}: ${s.gasto.eur.toFixed(2)} € de ${s.gasto.limite} €${s.gasto.turbo ? ' · 🚀 turbo' : ''}${s.pausado ? '\n⏸ Equipo en pausa (/reanudar)' : ''}`;
    }
    case 'encargar': {
      const [quien, ...resto] = args.split(/\s+/);
      const ag = nombreAgente(quien);
      if (!ag || !resto.length) return `Uso: /encargar <agente> <instrucción>\nAgentes: ${IDS.join(', ')}`;
      await tareas.crear(ag, resto.join(' '), { origen: 'dueno' });
      await bus.log('dueno', `ha encargado a ${AGENTES[ag].nombre}: «${resto.join(' ').slice(0, 140)}»`);
      return `👍 Encargado a ${AGENTES[ag].nombre}.${(await motor.estaPausado()) ? ' Empezará cuando reanudes el equipo.' : ''}`;
    }
    case 'gracias': {
      const [quien, ...resto] = args.split(/\s+/);
      const ag = nombreAgente(quien);
      if (!ag) return `Uso: /gracias <agente> [motivo]\nAgentes: ${IDS.join(', ')}`;
      const n = await darGracias(ag, resto.join(' '));
      return `💛 ${AGENTES[ag].nombre} lo ha recibido (${n} ${n === 1 ? 'agradecimiento' : 'agradecimientos'} en total).`;
    }
    case 'objetivo': {
      if (!args.trim()) return 'Uso: /objetivo <qué quieres conseguir y para cuándo>\nEj.: /objetivo 10 reuniones con gestorías de Getafe antes de fin de mes';
      try { await (await import('./objetivos.js')).crear(args.trim(), { via: 'telegram' }); } catch (e) { return e.message; }
      return '🎯 Apuntado. Rafa prepara el plan y te lo deja en la mesa (y aquí) para que lo apruebes.';
    }
    case 'pregunta': {
      const [quien, ...resto] = args.split(/\s+/);
      const ag = nombreAgente(quien);
      if (!ag || !resto.length) return `Uso: /pregunta <agente> <pregunta>\nAgentes: ${IDS.join(', ')}`;
      return (await preguntar(ag, resto.join(' '))) || `🤔 ${AGENTES[ag].nombre} lo está pensando. Te contesta aquí.`;
    }
    case 'regla': {
      if (!args.trim()) return 'Uso: /regla <texto>. Ej.: /regla No tutees a despachos de abogados';
      const rg = await aprendizajes.nuevaRegla(args);
      await bus.log('dueno', `ha añadido una regla: «${rg.texto}»`);
      return `📌 Regla ${rg.id} guardada para todo el equipo.`;
    }
    case 'reglas': {
      const rs = await aprendizajes.reglas();
      return rs.length ? '📌 Reglas activas:\n' + rs.map(x => `${x.id}. ${x.agente ? `[${AGENTES[x.agente]?.nombre}] ` : ''}${x.texto}`).join('\n') + '\n\n/quitar <n> para quitar una.' : 'No hay reglas todavía.';
    }
    case 'quitar':
      return (await aprendizajes.quitar(Number(args))) ? `Regla ${args} quitada.` : 'No encuentro esa regla.';
    case 'pausa': await motor.pausar('Pausa desde Telegram'); return null;
    case 'reanudar': await motor.reanudar(); return '▶️ Equipo trabajando.';
    default: return 'No conozco ese comando. Escribe /ayuda.';
  }
});

// ---------- arranque ----------
export async function arrancar({ conMotor = true } = {}) {
  const errores = validar();
  if (errores.length) throw new Error('Configuración no válida:\n- ' + errores.join('\n- '));
  await migrar();
  await ia.cargar();
  await modulos.cargar();
  await departamentos.cargar();
  await fuentes.cargar();
  await plantilla.cargar();
  await linkedin.cargarApp();
  await facebook.cargarApp();
  await perfil.cargar();
  await marca.cargar();
  await cuentasCorreo.cargar();
  await chats.cargar();
  await telegram.cargar();
  await secuencias.recortarBorradores().catch(e => console.error('Recortar secuencias:', e.message));
  await aprobaciones.actualizarOpcionesPosts().catch(e => console.error('Opciones de posts:', e.message));
  await boletin.ponerBotones().catch(e => console.error('Boletín:', e.message));
  await video.recuperar();
  await vida.cargar();
  await chat.importarPreguntas().catch(e => console.error('Chat (importar):', e.message));
  { const ch = await ajuste('charlas', null).catch(() => null); const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
    if (ch?.fecha === hoy && ch.lista?.length) chat.charlasAlCafe(ch.lista, ch.fecha).catch(e => console.error('Chat (#café):', e.message)); }
  const perdidas = await tareas.recuperar();
  if (perdidas.length) await bus.log('sistema', `${perdidas.length} tarea(s) se quedaron a medias por un reinicio y no se repiten solas para no duplicar nada. Revísalas.`);
  for (const id of IDS) await bus.estado(id, 'inactivo', 'Esperando trabajo', AGENTES[id].icono);
  const servidor = http.createServer((req, res) => {
    rutas(req, res).catch(e => { console.error(req.method, req.url, e.message); if (!res.headersSent) json(res, e.codigo || 500, { error: e.message }); });
  });
  await new Promise(ok => servidor.listen(config.puerto, ok));
  console.log(`Oficina de agentes en http://localhost:${config.puerto}`);
  if (!acceso.activo()) console.warn('AVISO: el panel está abierto sin contraseña (falta PANEL_PASSWORD en .env). Solo vale para probar en tu ordenador.');
  const e = await ia.estado();
  if (!e.listo) console.warn(`Falta la clave de ${e.nombre}: pégala en el panel (Configuración → Inteligencia artificial). Los agentes no podrán trabajar hasta entonces.`);
  else console.log(`IA: ${e.nombre}`);
  if (conMotor) { motor.arrancar(); planificador.arrancar(); telegram.escuchar(); }
  for (const b of await (await import('./atascos.js')).abiertos().catch(() => [])) await (await import('./atascos.js')).marcar(b.agente);
  if (await ajuste('pausado', config.pausadoInicial)) console.log('El equipo está en pausa.');
  return servidor;
}

// Se compara con la ruta real: en una carpeta con espacios o tildes, la URL va codificada y no coincidiría con el texto de argv
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  arrancar().catch(e => { console.error('No se pudo arrancar:', e); process.exit(1); });
}
