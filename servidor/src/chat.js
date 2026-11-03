// Chat de la oficina, al estilo de Slack. Canales:
//  · #general: tú y el equipo. Contesta Rafa; con «@Mateo …» contesta Mateo delante de todos. Aquí van también las reuniones.
//  · #trabajo: lo que se encargan y se contestan entre ellos (lo escriben solos).
//  · #actividad: lo mismo que el panel de Actividad, con su historial (se lee de los eventos: no se escribe nada aparte).
//  · #café: las charlas de la vida de oficina (si está activa).
//  · Un privado con cada agente: lo que le preguntas aquí, en su ficha o por Telegram, y lo que te contesta.
// Todo queda guardado y llega al panel al momento.
import { q } from './db.js';
import { emitir } from './bus.js';
import { AGENTES, IDS } from './agentes.js';
import * as departamentos from './departamentos.js';
import { idPorNombre } from './plantilla.js';
import * as tareas from './tareas.js';

export const CANALES = [
  { id: 'general', nombre: 'general', desc: 'Tú y el equipo. Te contesta Rafa; escribe «@Mateo …» para hablar con alguien delante de todos.' },
  { id: 'trabajo', nombre: 'trabajo', desc: 'Lo que se encargan y se contestan entre ellos. Lo escriben solos.', soloLectura: true },
  { id: 'actividad', nombre: 'actividad', desc: 'Todo lo que sale en Actividad, al momento. Lo escriben solos.', soloLectura: true },
  { id: 'cafe', nombre: 'café', desc: 'Las charlas de la oficina. Lo escriben ellos.', soloLectura: true },
];
const recortar = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
export const esCanal = c => CANALES.some(x => x.id === c) || IDS.includes(c);
const nombreCanal = c => (IDS.includes(c) ? `tu privado con ${AGENTES[c].nombre}` : `#${CANALES.find(x => x.id === c)?.nombre || c}`);

/** Escribe un mensaje en un canal y lo manda al panel. */
export async function escribir({ canal, autor, texto, para = null, via = null, tarea_id = null, empresa_id = null, informe_id = null, creado = null }) {
  texto = String(texto ?? '').trim();
  if (!esCanal(canal) || !texto) return null;
  const r = await q(`INSERT INTO chat (canal, autor, para, texto, via, tarea_id, empresa_id, informe_id, creado)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, coalesce($9, now())) RETURNING *`,
    [canal, autor, para, recortar(texto, 8000), via, tarea_id, empresa_id, informe_id, creado]);
  if (!creado) await emitir({ tipo: 'chat', mensaje: r.rows[0] });
  return r.rows[0];
}

/** Quién está contestando en un canal (tiene una pregunta tuya pendiente). */
async function escribiendo(canal) {
  const r = IDS.includes(canal)
    ? await q(`SELECT DISTINCT agente FROM tareas WHERE estado IN ('pendiente','en_curso') AND agente=$1 AND (canal=$1 OR (canal IS NULL AND tipo='pregunta'))`, [canal])
    : await q(`SELECT DISTINCT agente FROM tareas WHERE estado IN ('pendiente','en_curso') AND canal=$1`, [canal]);
  const parados = await departamentos.agotados();   // su tarea espera: no está contestando
  return r.rows.map(x => x.agente).filter(a => !parados.includes(a));
}

/** Mensajes de un canal (los últimos, o los anteriores a «antes»). En #café solo lo que ya ha pasado. */
export async function historial(canal, { antes = null, limite = 60 } = {}) {
  if (!esCanal(canal)) throw new Error('Ese canal no existe.');
  const n = Math.min(Math.max(Number(limite) || 60, 1), 200);
  if (canal === 'actividad') {
    const ev = await q(`SELECT id, ts, datos FROM eventos WHERE datos->>'tipo'='log' AND ($1::bigint IS NULL OR id < $1) ORDER BY id DESC LIMIT $2`, [antes ? Number(antes) : null, n + 1]);
    const mensajes = ev.rows.slice(0, n).reverse().map(({ id, ts, datos: d }) => {
      const deLola = d.agente === 'sistema' && /^📞 Lola /.test(d.texto);   // lo de Lola guardado antes de que tuviera su propio agente
      return { id, canal, autor: deLola ? 'lola' : d.agente, texto: deLola ? d.texto.replace(/^📞 Lola /, '📞 ') : d.texto, creado: d.ts || ts,
        empresa_id: d.empresa_id || null, informe_id: d.informe_id || null, aprobacion_id: d.aprobacion_id || null, url: d.url || null, llamada_id: d.llamada_id || null };
    });
    return { canal, mensajes, mas: ev.rows.length > n, escribiendo: [] };
  }
  const r = await q(`SELECT * FROM chat WHERE canal=$1 AND creado <= now() AND ($2::bigint IS NULL OR id < $2) ORDER BY creado DESC, id DESC LIMIT $3`, [canal, antes ? Number(antes) : null, n + 1]);
  const mas = r.rows.length > n;
  return { canal, mensajes: r.rows.slice(0, n).reverse(), mas, escribiendo: await escribiendo(canal) };
}

/** Los canales con su último mensaje (para marcar lo no leído). */
export async function canales({ vida = true } = {}) {
  const r = await q(`SELECT DISTINCT ON (canal) canal, id, autor, para, left(texto, 120) AS texto, creado FROM chat WHERE creado <= now() ORDER BY canal, creado DESC, id DESC`);
  const ult = Object.fromEntries(r.rows.map(x => [x.canal, x]));
  return [
    ...CANALES.filter(c => c.id !== 'cafe' || vida || ult.cafe).map(c => ({ ...c, tipo: 'canal', ultimo: ult[c.id] || null })),
    ...IDS.filter(departamentos.trabaja).map(id => ({ id, nombre: AGENTES[id].nombre, rol: AGENTES[id].rol, tipo: 'privado', ultimo: ult[id] || null })),
  ];
}

/** Lo que llevabais hablado en ese canal, para que quien contesta siga el hilo. */
export async function contexto(canal, hasta = null, n = 8) {
  if (!esCanal(canal)) return '';
  const r = await q(`SELECT autor, para, texto FROM chat WHERE canal=$1 AND creado < coalesce($2::timestamptz, now()) ORDER BY creado DESC, id DESC LIMIT $3`, [canal, hasta, n]);
  if (!r.rows.length) return '';
  const quien = a => (a === 'dueno' ? 'Dirección' : AGENTES[a]?.nombre || a);
  return `Lo último que se ha hablado en ${nombreCanal(canal)} (de más antiguo a más reciente):\n${r.rows.reverse().map(m => `- ${quien(m.autor)}${m.para && m.para !== 'dueno' && AGENTES[m.para] ? ` → ${quien(m.para)}` : ''}: ${recortar(m.texto.replace(/\s+/g, ' '), 400)}`).join('\n')}`;
}

/** Lo que escribes tú en el chat del panel. */
export async function deDueno(canal, texto) {
  texto = String(texto ?? '').trim();
  if (!texto) throw new Error('Escribe algo.');
  texto = recortar(texto, 4000);
  const c = CANALES.find(x => x.id === canal);
  if (!c && !IDS.includes(canal)) throw new Error('Ese canal no existe.');
  if (c?.soloLectura) throw new Error(`En #${c.nombre} escriben ellos solos. Escríbeles en #general o por privado.`);
  if (IDS.includes(canal)) {
    const t = await tareas.crear(canal, texto, { origen: 'dueno', tipo: 'pregunta', canal });
    return escribir({ canal, autor: 'dueno', para: canal, texto, via: 'panel', tarea_id: t.id });
  }
  // #general: «@Mateo …» o «Mateo, …» → contesta ese agente aquí, delante de todos; si no, Rafa
  const m = texto.match(/^\s*@([A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+)[\s,:]+([\s\S]+)$/) || texto.match(/^\s*([A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+)\s*[,:]\s*([\s\S]+)$/);
  const ag = m && idPorNombre(m[1]);
  if (ag && ag !== 'rafa') {
    const t = await tareas.crear(ag, m[2].trim(), { origen: 'dueno', tipo: 'pregunta', canal: 'general' });
    return escribir({ canal: 'general', autor: 'dueno', para: ag, texto, via: 'panel', tarea_id: t.id });
  }
  const t = await tareas.crear('rafa', `Dirección escribe en #general, el canal del chat de la oficina que leéis todos:\n«${texto}»\n\nContéstale ahí mismo, breve (2–5 frases) y en tono de chat. Si hace falta que alguien haga algo, encárgaselo y dile a quién y qué. Si lo que plantea es un objetivo grande, prepárale un plan con proponer_plan solo si tiene número de objetivo; si no, dile que lo lance con el botón 🎯 Objetivo. No uses enviar_informe: tu respuesta final es lo que se publica en el chat.`, { origen: 'dueno', canal: 'general' });
  return escribir({ canal: 'general', autor: 'dueno', para: 'rafa', texto, via: 'panel', tarea_id: t.id });
}

/** Charlas de la vida de oficina → #café, repartidas a lo largo del día (de 9:30 a 18:30, o desde ahora). */
export async function charlasAlCafe(lista, fecha) {
  if (!Array.isArray(lista) || !lista.length) return;
  const ya = await q(`SELECT 1 FROM chat WHERE canal='cafe' AND (creado AT TIME ZONE 'Europe/Madrid')::date = $1::date LIMIT 1`, [fecha]);
  if (ya.rows.length) return;
  const ahora = (await q(`SELECT extract(hour FROM now() AT TIME ZONE 'Europe/Madrid')*60 + extract(minute FROM now() AT TIME ZONE 'Europe/Madrid') AS m`)).rows[0].m;
  const desde = Math.max(570, Number(ahora) + 5), hasta = Math.max(desde + 30, 1110);
  const paso = (hasta - desde) / lista.length;
  for (const [i, c] of lista.entries()) {
    if (!AGENTES[c.de] || !AGENTES[c.a] || !c.texto) continue;
    const min = Math.round(desde + paso * i + Math.random() * paso * 0.6);
    const cuando = (await q(`SELECT (($1::date + make_interval(mins => $2::int))::timestamp AT TIME ZONE 'Europe/Madrid') AS t`, [fecha, min])).rows[0].t;
    await escribir({ canal: 'cafe', autor: c.de, para: c.a, texto: c.texto, creado: cuando });
    if (c.respuesta) await escribir({ canal: 'cafe', autor: c.a, para: c.de, texto: c.respuesta, creado: new Date(new Date(cuando).getTime() + (1 + Math.floor(Math.random() * 3)) * 60_000) });
  }
}

/** La primera vez, lo que ya le habías preguntado a cada agente pasa a su privado. */
export async function importarPreguntas() {
  const hay = await q(`SELECT 1 FROM chat LIMIT 1`);
  if (hay.rows.length) return 0;
  const r = await q(`SELECT id, agente, instruccion, resultado, estado, creada, terminada FROM tareas WHERE tipo='pregunta' ORDER BY id`);
  for (const t of r.rows) {
    if (!AGENTES[t.agente]) continue;
    const texto = t.instruccion.replace(/^\[Cómo está Dirección ahora:[^\]]*\]\s*/, '').replace(/\n\nLo que Dirección está contestando:[\s\S]*$/, '');
    await q(`INSERT INTO chat (canal, autor, para, texto, tarea_id, creado) VALUES ($1,'dueno',$1,$2,$3,$4)`, [t.agente, texto, t.id, t.creada]);
    if (t.resultado && t.estado === 'hecha') await q(`INSERT INTO chat (canal, autor, para, texto, tarea_id, creado) VALUES ($1,$1,'dueno',$2,$3,$4)`, [t.agente, t.resultado, t.id, t.terminada || t.creada]);
  }
  return r.rows.length;
}
