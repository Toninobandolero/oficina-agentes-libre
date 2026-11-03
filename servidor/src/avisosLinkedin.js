// Avisos de LinkedIn por correo. LinkedIn no deja leer mensajes ni comentarios por su API, pero manda un correo
// cada vez que alguien acepta tu invitación, te escribe o comenta. Dirección reenvía esos correos a oficina@ y aquí se leen:
// - acepta la conexión → la secuencia sigue sola (Javi escribe el mensaje 1), sin preguntarle a Dirección;
// - te escribe → la empresa pasa a «en conversación», se paran los seguimientos y Paula prepara la respuesta;
// - comenta un post → aviso y Álex propone la respuesta.
import { q } from './db.js';
import { log } from './bus.js';
import * as tareas from './tareas.js';
import * as telegram from './telegram.js';

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/** ¿Es un aviso de LinkedIn? (directo o reenviado por Dirección) */
export function esAviso(m) {
  const de = String(m.from?.value?.[0]?.address || '').toLowerCase();
  const txt = `${m.subject || ''}\n${String(m.text || '').slice(0, 3000)}`;
  if (/@([a-z]+\.)?linkedin\.com$/.test(de)) return true;                      // llega tal cual (redirigido)
  if (m.headers?.get?.('x-linkedin-class')) return true;
  // reenviado por Dirección: el remitente es él y dentro va el aviso de LinkedIn
  return /linkedin\.com\/(comm|in|feed|messaging)/i.test(txt) && /(@|\b)linkedin\.com\b/i.test(txt.slice(0, 1500)) && /^(fwd?|rv):/i.test(String(m.subject || ''));
}

/** Qué ha pasado y quién: { tipo: 'aceptado'|'mensaje'|'comentario'|'otro', nombre, extracto } */
export function leer(m) {
  const asunto = String(m.subject || '').replace(/^(fwd?|rv|re):\s*/i, '').trim();
  const texto = String(m.text || '').replace(/\r/g, '');
  const pats = [
    ['aceptado', /^(.+?) (ha aceptado tu invitaci[oó]n|accepted your invitation|aceptó tu invitación)/i],
    ['aceptado', /(?:ahora estás conectado con|you are now connected with|you're now connected with) (.+?)[.!]?$/i],
    ['mensaje', /^(.+?) (te ha enviado un mensaje|te envió un mensaje|sent you a (new )?message|just messaged you|has sent you a message)/i],
    ['mensaje', /(?:nuevo mensaje de|new message from|tienes un mensaje nuevo de|mensaje de) (.+?)$/i],
    ['comentario', /^(.+?) (ha comentado|comentó|commented on|replied to your comment|ha respondido a tu comentario|te ha mencionado|mentioned you)/i],
  ];
  for (const [tipo, re] of pats) {
    const x = asunto.match(re);
    if (x) {
      const nombre = (tipo === 'aceptado' && re.source.startsWith('(?:') ? x[1] : x[1]).replace(/^(direccion|dueno),?\s*/i, '').replace(/["«»]/g, '').trim();
      const lineas = texto.split('\n').map(l => l.trim()).filter(l => l && !/^(ver|view|responder|reply|unsubscribe|darse de baja|linkedin|©|\[|https?:)/i.test(l));
      return { tipo, nombre, extracto: lineas.slice(0, 12).join('\n').slice(0, 1200) };
    }
  }
  return { tipo: 'otro', nombre: null, extracto: '' };
}

/** Busca a la persona entre los decisores de nuestras secuencias y empresas. */
async function buscar(nombre) {
  const n = norm(nombre); if (!n) return null;
  const tk = n.split(' ');
  const pareja = d => { const x = norm(d); if (!x) return false; if (x === n || x.includes(n) || n.includes(x)) return true; const t = x.split(' '); return t[0] === tk[0] && t.length > 1 && tk.length > 1 && t[t.length - 1] === tk[tk.length - 1]; };
  const secs = (await q(`SELECT s.id, s.empresa_id, s.estado, s.control, coalesce(s.decisor, e.decisor) AS decisor FROM secuencias s JOIN empresas e ON e.id=s.empresa_id WHERE s.estado IN ('activa','respondida','borrador') ORDER BY s.id DESC`)).rows;
  const sec = secs.find(s => pareja(s.decisor));
  if (sec) return { sec, empresa_id: sec.empresa_id };
  const emp = (await q(`SELECT id, decisor FROM empresas WHERE decisor IS NOT NULL AND estado NOT IN ('descartada','perdida')`)).rows.find(e => pareja(e.decisor));
  return emp ? { empresa_id: emp.id } : null;
}

/** Procesa un aviso. Devuelve una frase de lo hecho (o null si no era nada útil). */
export async function procesar(m) {
  const a = leer(m);
  if (a.tipo === 'otro') return null;
  const hit = await buscar(a.nombre);
  const secuencias = await import('./secuencias.js');
  const aprobaciones = await import('./aprobaciones.js');
  const empresas = await import('./empresas.js');
  const emp = hit?.empresa_id ? await empresas.leer(hit.empresa_id) : null;
  const de = emp ? `${a.nombre} (${emp.nombre})` : a.nombre;

  if (a.tipo === 'aceptado') {
    if (!hit?.sec || hit.sec.estado !== 'activa') { await log('sistema', `LinkedIn: ${de} ha aceptado tu invitación.`, { empresa_id: emp?.id }); return 'aceptado-sin-secuencia'; }
    await aprobaciones.sustituir(`ctl:${hit.sec.id}`);               // Paula ya no tiene que preguntarte
    const frase = await secuencias.resolver({ ref: `ctl:${hit.sec.id}` }, 'aceptado');
    await log('sistema', `LinkedIn avisa: ${de} ha aceptado tu invitación. ${frase ? frase.replace(/^ha confirmado que [^.]+\.\s*/, '') : ''}`.trim(), { empresa_id: emp?.id });
    await secuencias.emitirCambio?.(emp.id);
    return 'aceptado';
  }
  if (a.tipo === 'mensaje') {
    if (hit?.sec && hit.sec.estado === 'activa') {
      await aprobaciones.sustituir(`ctl:${hit.sec.id}`);
      await secuencias.resolver({ ref: `ctl:${hit.sec.id}` }, 'respondido', `(aviso de LinkedIn) ${a.extracto || 'te ha escrito por LinkedIn; el texto completo está en LinkedIn'}`);
      await secuencias.emitirCambio?.(emp.id);
    } else {
      if (emp && ['contactada', 'dossier', 'puntuada', 'nueva'].includes(emp.estado)) await empresas.actualizar(emp.id, { estado: 'conversacion', ultimo_contacto: new Date().toISOString().slice(0, 10) });
      await tareas.crear('paula', `${de} le ha escrito a Dirección por LinkedIn (aviso por correo; el texto completo está en LinkedIn):\n\n${a.extracto}\n\n` +
        `${emp ? 'Lee la empresa con leer_empresa, actualízala y' : 'No es una empresa de nuestra base. Si parece un posible cliente, guárdala con guardar_empresas (origen «linkedin") y'} prepara la respuesta para LinkedIn con pedir_aprobacion (tipo respuesta, canal linkedin), en su idioma.`, { empresa_id: emp?.id || null, origen: 'sistema' });
    }
    await telegram.avisar(`💬 ${de} te ha escrito por LinkedIn:\n${a.extracto.slice(0, 500)}\n\nPaula te prepara la respuesta.`);
    await log('sistema', `LinkedIn avisa: ${de} te ha escrito. Paula prepara la respuesta.`, { empresa_id: emp?.id });
    return 'mensaje';
  }
  if (a.tipo === 'comentario') {
    await tareas.crear('alex', `${de} ha comentado en LinkedIn (aviso por correo):\n\n${a.extracto}\n\nPropón a Dirección una respuesta corta y natural al comentario con pedir_aprobacion (tipo respuesta, canal linkedin), en el idioma del comentario. Si es spam o no merece respuesta, díselo con anotar.`, { empresa_id: emp?.id || null, origen: 'sistema' });
    await log('sistema', `LinkedIn avisa: ${de} ha comentado. Álex te propone la respuesta.`, { empresa_id: emp?.id });
    return 'comentario';
  }
  return null;
}
