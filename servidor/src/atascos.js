// Cuando un agente no puede seguir (le falta un dato, un permiso, algo de un compañero), lo dice con «estoy_atascado».
// Se ve en la oficina (en rojo), se le encarga a quien puede resolverlo y, si sigue igual horas después, se avisa a Dirección.
import { q } from './db.js';
import { AGENTES } from './agentes.js';
import { log, estado, estadoDe, emitir } from './bus.js';
import * as tareas from './tareas.js';
import { T } from './en.js';

export async function abrir({ agente, motivo, necesita = 'dueno', tarea_id = null, empresa_id = null }) {
  const quien = AGENTES[necesita] && necesita !== agente ? necesita : 'dueno';
  const ya = (await q(`SELECT id FROM bloqueos WHERE agente=$1 AND resuelto IS NULL AND motivo=$2`, [agente, motivo])).rows[0];
  if (ya) return ya.id;
  const b = (await q(`INSERT INTO bloqueos (agente, motivo, necesita, tarea_id, empresa_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [agente, String(motivo).slice(0, 600), quien, tarea_id, empresa_id])).rows[0];
  const n = AGENTES[agente]?.nombre ?? agente;
  if (quien !== 'dueno') {
    const ayuda = await tareas.crear(quien, `${n} está atascado y dice que lo puedes resolver tú: «${motivo}». Dale lo que necesita: búscalo con tus herramientas y pásaselo con encargar (al terminar esta tarea, su atasco se da por resuelto). Si tampoco puedes, díselo a Dirección con anotar.`, { empresa_id, origen: agente });
    await q(`UPDATE bloqueos SET ayuda_tarea_id=$1 WHERE id=$2`, [ayuda.id, b.id]);
  } else {
    const aprobaciones = await import('./aprobaciones.js');
    await aprobaciones.crear({ agente, tipo: 'otro', empresa_id, ref: `atasco:${b.id}`,
      titulo: T`está atascado y te necesita: ${String(motivo).slice(0, 110)}`,
      texto: `QUÉ LE FALTA (no se envía)\n${motivo}`,
      opciones: [{ r: 'responder', t: '💬 Contestarle', texto: `Escribe lo que necesita ${n}…` }, { r: 'aprobada', t: '✅ Ya está resuelto' }, { r: 'descartada', t: 'Que lo deje' }],
      importancia: 'alta', motivo: `${n} está parado hasta que le contestes` });
  }
  await log(agente, T`está atascado: ${String(motivo).slice(0, 200)}. ${quien === 'dueno' ? T('Te pregunta a ti.') : T`Se lo pide a ${AGENTES[quien].nombre}.`}`, { empresa_id });
  await marcar(agente);
  return b.id;
}

/** Se resuelve: porque Dirección contesta, porque alguien le encarga lo que faltaba o porque termina bien otra tarea. */
export async function resolver(agente, como = '') {
  const r = await q(`UPDATE bloqueos SET resuelto=now(), como=$2 WHERE agente=$1 AND resuelto IS NULL RETURNING id`, [agente, como || null]);
  if (r.rows.length) await emitir({ tipo: 'atasco', agente, abierto: false });
  return r.rows.length;
}

export async function abiertos() {
  return (await q(`SELECT id, agente, motivo, necesita, creado, aviso FROM bloqueos WHERE resuelto IS NULL ORDER BY creado`)).rows;
}

/** Deja al agente en rojo («Necesita ayuda») con el motivo a la vista. */
export async function marcar(agente) {
  const b = (await q(`SELECT motivo FROM bloqueos WHERE agente=$1 AND resuelto IS NULL ORDER BY creado DESC LIMIT 1`, [agente])).rows[0];
  if (!b) return false;
  await estado(agente, 'error', `Atascado: ${String(b.motivo).slice(0, 80)}${String(b.motivo).length > 80 ? '…' : ''}`, 'excl');
  await emitir({ tipo: 'atasco', agente, abierto: true, motivo: b.motivo });
  return true;
}

// Si ya no le queda ningún atasco, deja de estar en rojo
async function trasCerrar(agente) {
  if (await marcar(agente)) return;
  await emitir({ tipo: 'atasco', agente, abierto: false });
  if (estadoDe(agente)?.estado === 'error') await estado(agente, 'inactivo', 'Esperando trabajo', 'zz');
}

/** Cuando termina la tarea de quien podía ayudar, el atasco queda resuelto. */
async function cerrarAyudados() {
  const r = await q(`UPDATE bloqueos b SET resuelto=now(), como='Lo ha resuelto ' || b.necesita FROM tareas t
                      WHERE b.resuelto IS NULL AND t.id=b.ayuda_tarea_id AND t.estado='hecha' RETURNING b.agente`);
  for (const agente of new Set(r.rows.map(x => x.agente))) await trasCerrar(agente);
  return r.rows.length;
}

/** Para el botón «Cómo ayudar»: el motivo entero, a quién se lo pidió y cómo va esa ayuda. */
export async function paraPanel() {
  return (await q(`SELECT b.id, b.agente, b.motivo, b.necesita, b.creado, b.empresa_id, e.nombre AS empresa, t.estado AS ayuda_estado
                     FROM bloqueos b LEFT JOIN empresas e ON e.id=b.empresa_id LEFT JOIN tareas t ON t.id=b.ayuda_tarea_id
                    WHERE b.resuelto IS NULL ORDER BY b.creado`)).rows;
}

/** Dirección atiende un atasco desde el panel: le contesta y el agente sigue, o lo da por resuelto. */
export async function atender(id, { accion, texto } = {}) {
  const b = (await q(`SELECT * FROM bloqueos WHERE id=$1 AND resuelto IS NULL`, [id])).rows[0];
  if (!b) return null;
  const respuesta = String(texto || '').trim();
  if (accion === 'contestar' && !respuesta) throw Object.assign(new Error(T('Escribe qué le contestas.')), { codigo: 400 });
  if (accion === 'contestar') await tareas.crear(b.agente, `Estabas atascado («${b.motivo}»). Dirección te contesta: «${respuesta}». Sigue con lo que tenías pendiente.`, { empresa_id: b.empresa_id, origen: 'dueno' });
  await q(`UPDATE bloqueos SET resuelto=now(), como=$2 WHERE id=$1`, [id, accion === 'contestar' ? `Dirección: ${respuesta.slice(0, 200)}` : 'Dirección lo da por resuelto']);
  // Si te lo preguntaba a ti, también sale de tu mesa
  const enMesa = (await q(`UPDATE aprobaciones SET estado='aprobada', resuelta=now() WHERE ref=$1 AND estado='pendiente' RETURNING id, telegram_msg_id`, [`atasco:${id}`])).rows;
  for (const ap of enMesa) {
    await emitir({ tipo: 'aprobacion_resuelta', id: ap.id, resultado: 'aprobada' });
    await (await import('./telegram.js')).marcarResuelta(ap.telegram_msg_id, 'aprobada');
  }
  await trasCerrar(b.agente);
  const n = AGENTES[b.agente]?.nombre ?? b.agente;
  await log('dueno', accion === 'contestar' ? T`le ha contestado a ${n} lo que necesitaba.` : T`ha desatascado a ${n}.`, { empresa_id: b.empresa_id });
  return { ok: true };
}

/** Revisión periódica: cierra lo ya resuelto y los atascos de más de 4 horas se le cuentan a Dirección (una vez). */
export async function revisar() {
  await cerrarAyudados();
  const viejos = (await q(`SELECT * FROM bloqueos WHERE resuelto IS NULL AND aviso IS NULL AND creado < now() - interval '4 hours'`)).rows;
  if (!viejos.length) return 0;
  const telegram = await import('./telegram.js');
  const lista = viejos.map(b => `• ${AGENTES[b.agente]?.nombre ?? b.agente}: ${b.motivo}${b.necesita !== 'dueno' ? ` (se lo pidió a ${AGENTES[b.necesita]?.nombre ?? b.necesita})` : ''}`).join('\n');
  await telegram.avisar(`🧱 Hay ${viejos.length} agente${viejos.length === 1 ? '' : 's'} atascado${viejos.length === 1 ? '' : 's'} desde hace horas:\n${lista}\n\nEn la oficina los ves en rojo.`);
  await q(`UPDATE bloqueos SET aviso=now() WHERE id = ANY($1::int[])`, [viejos.map(b => b.id)]);
  return viejos.length;
}
