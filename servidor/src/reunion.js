// Reunión de equipo: cada cierto tiempo (los lunes, o cuando Dirección la convoca) todos vuelcan lo que llevan,
// en qué están y qué necesitan. Rafa la modera y deja el acta. Lo que necesitan de Dirección va enlazado a su mesa.
// Una sola llamada barata con datos reales de la base de datos: nadie inventa trabajo.
import { q, ajuste, fijarAjuste } from './db.js';
import { AGENTES, IDS } from './agentes.js';
import * as departamentos from './departamentos.js';
import { config } from './config.js';
import * as miEmpresa from './empresa.js';
import { emitir, log, guardarInforme } from './bus.js';
import { llamar } from './llm.js';
import { idiomaEquipo } from './perfil.js';
import * as presupuesto from './presupuesto.js';
import * as tareas from './tareas.js';
import * as vida from './vida.js';
import { PERSONAJES } from './personajes.js';

const corto = (t, n = 140) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
let enCurso = false;

/** Lo que ha hecho y tiene cada agente desde la última reunión (máx. 7 días). */
async function datos(desde) {
  const atascos = (await q(`SELECT agente, motivo, necesita, creado FROM bloqueos WHERE resuelto IS NULL`).catch(() => ({ rows: [] }))).rows;
  const [hechas, pendientes, mesa, resueltas, logs] = await Promise.all([
    q(`SELECT agente, instruccion FROM tareas WHERE estado='hecha' AND terminada >= $1 ORDER BY terminada DESC`, [desde]),
    q(`SELECT agente, estado, instruccion FROM tareas WHERE estado IN ('pendiente','en_curso') ORDER BY creada`),
    q(`SELECT id, agente, tipo, titulo, creada FROM aprobaciones WHERE estado='pendiente' ORDER BY creada`),
    q(`SELECT agente, estado, count(*)::int n FROM aprobaciones WHERE resuelta >= $1 GROUP BY 1,2`, [desde]),
    q(`SELECT datos->>'agente' agente, datos->>'texto' texto FROM eventos WHERE datos->>'tipo'='log' AND ts >= $1 ORDER BY id DESC LIMIT 300`, [desde]),
  ]);
  const por = {};
  for (const id of IDS) por[id] = { hechas: 0, ejemplos: [], pendientes: [], mesa: [], aprobadas: 0, descartadas: 0, actividad: [] };
  for (const t of hechas.rows) if (por[t.agente]) { por[t.agente].hechas++; if (por[t.agente].ejemplos.length < 4) por[t.agente].ejemplos.push(corto(t.instruccion)); }
  for (const t of pendientes.rows) if (por[t.agente] && por[t.agente].pendientes.length < 4) por[t.agente].pendientes.push(`${t.estado === 'en_curso' ? '[ahora] ' : ''}${corto(t.instruccion)}`);
  for (const a of mesa.rows) if (por[a.agente]) por[a.agente].mesa.push({ id: a.id, titulo: corto(a.titulo, 120) });
  for (const r of resueltas.rows) if (por[r.agente]) { if (r.estado === 'aprobada' || r.estado === 'publicada' || r.estado === 'programada') por[r.agente].aprobadas += r.n; if (r.estado === 'descartada') por[r.agente].descartadas += r.n; }
  for (const l of logs.rows) if (por[l.agente] && por[l.agente].actividad.length < 5) por[l.agente].actividad.push(corto(l.texto));
  for (const b of atascos) if (por[b.agente]) por[b.agente].atascado = `${corto(b.motivo)} (lo puede resolver: ${b.necesita})`;
  return por;
}

/** Celebra la reunión ahora. Devuelve el acta. */
export async function celebrar({ convoca = 'sistema' } = {}) {
  if (enCurso) throw new Error('Ya hay una reunión en marcha.');
  enCurso = true;
  try {
    const previa = await ajuste('reunion_ultima', null);
    const desde = previa?.fecha && Date.now() - new Date(previa.fecha) < 7 * 86_400_000 ? previa.fecha : new Date(Date.now() - 7 * 86_400_000).toISOString();
    await emitir({ tipo: 'reunion', fase: 'empieza', convoca });
    await log('rafa', convoca === 'dueno' ? 'convoca la reunión de equipo que ha pedido Dirección. Todos a la sala de reuniones.' : 'convoca la reunión de equipo. Todos a la sala de reuniones.');
    const d = await datos(desde);
    const activa = vida.estaActiva();
    const fichas = IDS.filter(departamentos.trabaja).map(id => {
      const a = AGENTES[id], x = d[id];
      return `### ${id} · ${a.nombre}, ${a.rol}${activa && PERSONAJES[id] ? ` (habla así: ${PERSONAJES[id].habla || PERSONAJES[id].personalidad})` : ''}
- Tareas terminadas: ${x.hechas}${x.ejemplos.length ? ` (p. ej.: ${x.ejemplos.join(' | ')})` : ''}
- Trabajo aprobado por Dirección: ${x.aprobadas}; descartado: ${x.descartadas}
- Pendiente o en curso: ${x.pendientes.join(' | ') || 'nada'}
- Esperando en la mesa de Dirección: ${x.mesa.map(m => `[${m.id}] ${m.titulo}`).join(' | ') || 'nada'}
- Actividad reciente: ${x.actividad.join(' | ') || 'ninguna'}${x.atascado ? `\n- ATASCADO: ${x.atascado}` : ''}`;
    }).join('\n\n');
    const prompt = `Eres Rafa, director de la oficina de agentes de ${miEmpresa.nombre()}${config.empresa.enReunion ? ` (${config.empresa.enReunion})` : ''}.
Celebramos la reunión de equipo. Cada agente cuenta, en primera persona y en 1–2 frases cada cosa: lo que ha hecho, en qué está ahora y lo que necesita (de Dirección o de un compañero). Usa SOLO estos datos reales; si alguien no ha hecho nada, que lo diga sin adornos. No inventes empresas, cifras ni trabajo.

${fichas}

Reglas:
- «necesita» solo si de verdad hace falta algo: aprobar lo que está en la mesa (pon su id entre corchetes en «aprobacion»), una decisión de Dirección, un dato, un contacto, o algo de un compañero (pon su id en «de»). Si no necesita nada, lista vacía.
- Tú cierras con un resumen de 2–3 frases y las 3 prioridades de la semana, concretas.
- En ${idiomaEquipo()}, directo, sin emojis${activa ? ', cada uno con su forma de hablar pero sin perder el foco' : ''}.
Responde SOLO con JSON:
{"agentes":[{"id":"…","hecho":"…","haciendo":"…","necesita":[{"texto":"…","de":"dueno|id","aprobacion":"id o vacío"}]}],"resumen":"…","prioridades":["…","…","…"]}`;
    const modelo = config.modelos.rafa;
    const r = await llamar({ modelo, messages: [{ role: 'user', content: prompt }], maxTokens: 9000, razonamiento: { max_tokens: 1000 } });
    await presupuesto.registrar('rafa', null, modelo, r.coste, r.uso);
    const t = String(r.mensaje.content || '');
    let j;
    try { j = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)); }
    catch (e) { console.error('Reunión: respuesta no válida', e.message, 'fin:', r.fin, t.slice(0, 200)); throw new Error('Rafa no ha podido redactar el acta. Inténtalo otra vez en un rato.'); }

    const pendientesIds = new Set(Object.values(d).flatMap(x => x.mesa.map(m => m.id)));
    const agentes = (j.agentes || []).filter(a => AGENTES[a.id]).map(a => ({
      id: a.id, hecho: corto(a.hecho, 400), haciendo: corto(a.haciendo, 400),
      necesita: (a.necesita || []).filter(n => n?.texto).slice(0, 4).map(n => {
        const ap = String(n.aprobacion || '').replace(/[[\]\s]/g, '');
        return { texto: corto(n.texto, 300), de: AGENTES[n.de] ? n.de : 'dueno', aprobacion: pendientesIds.has(ap) ? ap : null };
      }),
      en_mesa: d[a.id].mesa.length,
    }));
    const acta = { fecha: new Date().toISOString(), convoca, agentes, resumen: corto(j.resumen, 600), prioridades: (j.prioridades || []).slice(0, 3).map(p => corto(p, 200)) };

    const n = id => AGENTES[id]?.nombre ?? id;
    const md = [`# Reunión de equipo · ${new Date(acta.fecha).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Madrid' })}`, '', acta.resumen, '',
      '## Prioridades', ...acta.prioridades.map((p, i) => `${i + 1}. ${p}`), '',
      ...agentes.flatMap(a => [`## ${n(a.id)}`, `**Hecho:** ${a.hecho}`, `**Ahora:** ${a.haciendo}`, ...(a.necesita.length ? [`**Necesita:** ${a.necesita.map(x => `${x.texto}${x.de !== 'dueno' ? ` (de ${n(x.de)})` : ''}`).join(' · ')}`] : []), ''])].join('\n');
    acta.informe_id = await guardarInforme({ agente: 'rafa', tipo: 'reunion', titulo: 'Acta de la reunión de equipo', texto: md });
    await fijarAjuste('reunion_ultima', acta);

    // Lo que un compañero necesita de otro se le encarga directamente
    for (const a of agentes) for (const x of a.necesita) if (x.de !== 'dueno' && x.de !== a.id && departamentos.trabaja(x.de)) {
      await tareas.crear(x.de, `En la reunión de equipo, ${n(a.id)} ha dicho que necesita de ti: «${x.texto}». Ayúdale con lo que puedas con tus herramientas, o díselo a Dirección con anotar si no está en tu mano.`, { origen: a.id });
    }
    const paraDueno = agentes.reduce((s, a) => s + a.necesita.filter(x => x.de === 'dueno').length, 0);
    await emitir({ tipo: 'reunion', fase: 'acta', acta });
    try {
      const lista = agentes.flatMap(a => a.necesita.filter(x => x.de === 'dueno').map(x => `- ${n(a.id)}: ${x.texto}`));
      await (await import('./chat.js')).escribir({ canal: 'general', autor: 'rafa', texto: `🗣 **Reunión de equipo.** ${acta.resumen}\n\nPrioridades:\n${acta.prioridades.map((p, i) => `${i + 1}. ${p}`).join('\n')}${lista.length ? `\n\nLo que necesitamos de ti:\n${lista.join('\n')}` : ''}`, informe_id: acta.informe_id });
    } catch (e) { console.error('Reunión (chat):', e.message); }
    await log('rafa', `ha cerrado la reunión de equipo. ${paraDueno ? `Hay ${paraDueno} cosa${paraDueno === 1 ? '' : 's'} en las que te necesitamos.` : 'No necesitamos nada de ti por ahora.'}`, { informe_id: acta.informe_id });
    try {
      const telegram = await import('./telegram.js');
      const lista = agentes.flatMap(a => a.necesita.filter(x => x.de === 'dueno').map(x => `• ${n(a.id)}: ${x.texto}`));
      await telegram.avisar(`🗣 Reunión de equipo\n\n${acta.resumen}\n\nPrioridades:\n${acta.prioridades.map((p, i) => `${i + 1}. ${p}`).join('\n')}${lista.length ? `\n\nLo que necesitamos de ti:\n${lista.join('\n')}` : ''}\n\nEl acta completa está en el panel.`);
    } catch (e) { console.error('Reunión (Telegram):', e.message); }
    return acta;
  } catch (e) {
    await emitir({ tipo: 'reunion', fase: 'cancelada' });
    throw e;
  } finally { enCurso = false; }
}

export const ultima = () => ajuste('reunion_ultima', null);

/** Dirección contesta a algo que un agente pidió en la reunión: le llega como encargo suyo. */
export async function responder({ agente, necesidad, texto }) {
  if (!AGENTES[agente]) throw new Error('No existe ese agente.');
  if (!String(texto || '').trim()) throw new Error('Escribe la respuesta.');
  await tareas.crear(agente, `En la reunión de equipo dijiste que necesitabas: «${corto(necesidad, 300)}».\nDirección te responde: «${String(texto).trim().slice(0, 2000)}».\nActúa en consecuencia con tus herramientas y, si hay algo que preparar, déjalo en su mesa.`, { origen: 'dueno' });
  await log('dueno', `responde a ${AGENTES[agente].nombre} lo que pidió en la reunión: «${corto(texto, 140)}»`);
}
