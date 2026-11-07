// Cola de tareas: cada agente coge sus tareas de aquí, una a una.
import { q } from './db.js';
import { emitir } from './bus.js';
import { AGENTES } from './agentes.js';
import * as departamentos from './departamentos.js';

// En el chat se lee como lo diría una persona: sin los «(id …)» internos y sin textos larguísimos
const limpiar = t => { const x = String(t).replace(/\s*\(id [\w-]+\)/g, '').trim(); return x.length > 700 ? x.slice(0, 699) + '…' : x; };

export async function crear(agente, instruccion, { empresa_id = null, origen = 'dueno', no_antes = null, animar = true, tipo = 'trabajo', canal = null, objetivo_id = null, paso = null } = {}) {
  if (!AGENTES[agente]) throw new Error(`No existe el agente ${agente}`);
  if (!departamentos.trabaja(agente)) {
    const nombre = AGENTES[agente].nombre;
    // Lo que no tiene departamento pasa por Rafa, que lo reparte. Si es él quien lo encarga, se le dice, para que no vuelva a sí mismo
    if (origen === 'rafa') throw new Error(`${nombre} está en un departamento que esta empresa no tiene activo. Repártelo entre los que hay o díselo a Dirección.`);
    instruccion = `(Le tocaba a ${nombre}, pero su departamento no está activo en esta empresa: repártelo entre los que hay, hazlo tú o avisa a Dirección.)\n${instruccion}`;
    agente = 'rafa';
  }
  // Lo que escribe Dirección: se nota cómo lo escribe y el agente lo sabe al leer el encargo
  if (origen === 'dueno') {
    try {
      const tono = await import('./tono.js');
      const citas = String(instruccion).match(/«([^»]{3,})»/g);
      const e = await tono.registrar(citas ? citas.join(' ') : instruccion);
      instruccion = tono.aviso(e) + instruccion;
    } catch (e) { console.error('Tono:', e.message); }
  }
  const r = await q(`INSERT INTO tareas (agente, instruccion, empresa_id, origen, no_antes, tipo, canal, objetivo_id, paso)
                     VALUES ($1,$2,$3,$4, coalesce($5, now()), $6, $7, $8, $9) RETURNING *`, [agente, instruccion, empresa_id, origen, no_antes, tipo, canal, objetivo_id, paso]);
  // Si se lo pasa un compañero, en el panel se le ve llevarle el trabajo… y en #trabajo se lee lo que le pide
  if (AGENTES[origen] && origen !== agente) {
    if (animar) await emitir({ tipo: 'traspaso', de: origen, a: agente, carga: true });
    try { await (await import('./chat.js')).escribir({ canal: 'trabajo', autor: origen, para: agente, texto: limpiar(instruccion), tarea_id: r.rows[0].id, empresa_id }); }
    catch (e) { console.error('Chat (#trabajo):', e.message); }
  }
  // Su departamento ha llegado a su tope del mes: la tarea espera, y quien se lo pide tiene que saberlo
  if ((await departamentos.agotados()).includes(agente)) {
    r.rows[0].espera = true;
    const chatDe = canal || (tipo === 'pregunta' ? agente : null), id = r.rows[0].id;
    // Un momento después, para que salga detrás de lo que acaba de escribir Dirección
    if (chatDe) setTimeout(async () => (await import('./chat.js')).escribir({ canal: chatDe, autor: 'sistema', para: 'dueno', texto: `${AGENTES[agente]?.nombre} no puede contestar todavía: su departamento ha llegado a su tope de gasto del mes. Súbelo en Configuración o espera al mes que viene.`, tarea_id: id }).catch(e => console.error('Chat:', e.message)), 300).unref();
  }
  return r.rows[0];
}

/** Coge la siguiente tarea pendiente de un agente que no esté ocupado. */
/** Siguiente tarea. «frenados»: agentes que no empiezan trabajo nuevo (salvo encargos o preguntas directas de Dirección, o pasos de un plan que él ha aprobado). */
export async function siguiente(ocupados = [], frenados = []) {
  const r = await q(`UPDATE tareas SET estado='en_curso', empezada=now(), intentos=intentos+1
                      WHERE id = (SELECT id FROM tareas
                                   WHERE estado='pendiente' AND no_antes <= now() AND intentos < 3 AND NOT (agente = ANY($1::text[]))
                                     AND NOT (agente = ANY($2::text[]) AND origen NOT IN ('dueno','web','secuencia') AND tipo <> 'pregunta' AND objetivo_id IS NULL)
                                   ORDER BY no_antes, id LIMIT 1 FOR UPDATE SKIP LOCKED)
                      RETURNING *`, [ocupados, frenados]);
  return r.rows[0] || null;
}

export async function terminar(id, resultado) {
  await q(`UPDATE tareas SET estado='hecha', resultado=$2, terminada=now() WHERE id=$1`, [id, resultado?.slice(0, 4000) ?? null]);
}

export async function fallar(tarea, error, { reintentar = true } = {}) {
  if (reintentar && tarea.intentos < 3) {
    await q(`UPDATE tareas SET estado='pendiente', resultado=$2, no_antes = now() + interval '5 minutes' WHERE id=$1`, [tarea.id, String(error).slice(0, 2000)]);
    return 'reintento';
  }
  await q(`UPDATE tareas SET estado='error', resultado=$2, terminada=now() WHERE id=$1`, [tarea.id, String(error).slice(0, 2000)]);
  return 'error';
}

/** Tras un reinicio: lo que estaba a medias vuelve a la cola, salvo que ya hubiera escrito algo o lleve 3 intentos. */
export async function recuperar() {
  const r = await q(`UPDATE tareas SET estado='error', terminada=now(),
                       resultado = CASE WHEN con_efectos THEN 'Interrumpida por un reinicio después de empezar a guardar cambios. Revísala y vuelve a encargarla si hace falta.'
                                        ELSE 'Interrumpida por reinicios repetidos.' END
                      WHERE estado='en_curso' AND (con_efectos OR intentos >= 3) RETURNING id, agente`);
  await q(`UPDATE tareas SET estado='pendiente' WHERE estado='en_curso'`);
  await q(`UPDATE tareas SET estado='error', resultado='Demasiados intentos', terminada=now() WHERE estado='pendiente' AND intentos >= 3`);
  return r.rows;
}

/** El gerente reordena el trabajo: lo adelanta o lo cancela. Lo que ha pedido Dirección y los pasos de un plan aprobado no se cancelan. */
export async function mover(id, accion, motivo = '') {
  const t = (await q(`SELECT * FROM tareas WHERE id=$1`, [id])).rows[0];
  if (!t || t.estado !== 'pendiente') throw new Error('Esa tarea ya no está pendiente. Míralo con ver_cola.');
  if (accion === 'adelantar') await q(`UPDATE tareas SET no_antes = now() - interval '30 days' WHERE id=$1`, [id]);   // la cola va por no_antes
  else if (accion === 'cancelar') {
    if (t.origen === 'dueno' || t.objetivo_id != null) throw new Error('Lo que ha pedido Dirección o un paso de un plan aprobado no se cancela: díselo a Dirección con enviar_informe.');
    await q(`UPDATE tareas SET estado='hecha', resultado=$2, terminada=now() WHERE id=$1`, [id, `Cancelada por Máximo: ${String(motivo).slice(0, 300)}`]);
  } else throw new Error('La acción es adelantar o cancelar.');
  return t;
}

export async function marcarEfectos(id) {
  await q(`UPDATE tareas SET con_efectos=true WHERE id=$1 AND NOT con_efectos`, [id]);
}

export async function creadasHoyPorOrigen(origen) {
  const r = await q(`SELECT count(*)::int n FROM tareas WHERE origen=$1 AND creada >= date_trunc('day', now() AT TIME ZONE 'Europe/Madrid') AT TIME ZONE 'Europe/Madrid'`, [origen]);
  return r.rows[0].n;
}

export async function creadasHoy(agente) {
  const r = await q(`SELECT count(*)::int n FROM tareas WHERE agente=$1 AND creada >= date_trunc('day', now() AT TIME ZONE 'Europe/Madrid') AT TIME ZONE 'Europe/Madrid'`, [agente]);
  return r.rows[0].n;
}

export async function pendientesDe(agente, empresaId) {
  const r = await q(`SELECT count(*)::int n FROM tareas WHERE agente=$1 AND empresa_id=$2 AND estado IN ('pendiente','en_curso')`, [agente, empresaId]);
  return r.rows[0].n;
}
