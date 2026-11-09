// La mesa tiene que decir la verdad de hoy. Cuando pasa algo con una empresa (se habla con ella, contesta, dice algo),
// lo que estaba pendiente de antes se retira, y Paula rehace con los datos de hoy lo que siga haciendo falta. A Dirección nunca le llega nada antiguo.
import { q } from './db.js';
import { PRO, M } from './modulos.js';
import { emitir, log } from './bus.js';
import { SOLO_ENTRADA } from './empresas.js';
import { T } from './en.js';

const fechaCorta = d => new Date(d).toLocaleDateString('es-ES', { day: 'numeric', month: 'numeric', timeZone: 'Europe/Madrid' });

/** Ha pasado algo con esta empresa. cuando: cuándo ocurrió; solo se toca lo anterior. Se puede llamar varias veces: lo ya revisado no cambia. */
export async function ocurrio(empresa_id, { cuando = new Date(), que = T('lo último que ha pasado'), excepto = null } = {}) {
  if (!empresa_id) return { retiradas: 0, marcadas: 0 };
  // La secuencia en frío ya no pinta nada
  await q(`UPDATE pasos SET estado='cancelado' WHERE secuencia_id IN (SELECT id FROM secuencias WHERE empresa_id=$1 AND actualizada < $2 AND estado IN ('activa','aparcada')) AND estado IN ('pendiente','programado','en_mesa')`, [empresa_id, cuando]);
  await q(`UPDATE secuencias SET estado='respondida', control=NULL, control_fecha=NULL, actualizada=now() WHERE empresa_id=$1 AND actualizada < $2 AND estado IN ('activa','aparcada')`, [empresa_id, cuando]);
  // La mesa solo tiene lo que vale hoy: lo anterior se retira, sin pedirle a Dirección que lo revise
  const retiradas = (await q(`UPDATE aprobaciones SET estado='superada', resuelta=now() WHERE empresa_id=$1 AND estado='pendiente' AND creada < $2 AND id IS DISTINCT FROM $3 RETURNING id, titulo, tipo, ref`, [empresa_id, cuando, excepto])).rows;
  // Los avisos de llamar que apuntaron los agentes antes de esto; los tuyos no se tocan
  await q(`UPDATE recordatorios SET hecho=now() WHERE empresa_id=$1 AND hecho IS NULL AND clase='llamada' AND creado_por <> 'dueno' AND creado < $2`, [empresa_id, cuando]);
  // Lo que los agentes iban a hacer con los datos de antes tampoco sigue. ponytail: lo que ya está en marcha termina; su tarjeta se retira en el siguiente repaso si es anterior al hecho
  await q(`UPDATE tareas SET estado='error', resultado=$3, terminada=now() WHERE empresa_id=$1 AND estado='pendiente' AND origen <> 'dueno' AND creada < $2`, [empresa_id, cuando, `Cancelada: ya no toca tras ${String(que).slice(0, 200)}`]);
  for (const r of retiradas) await emitir({ tipo: 'aprobacion_resuelta', id: r.id, resultado: 'superada' });
  if (retiradas.length) await log('paula', T`ha retirado de tu mesa lo que ya no toca tras ${que}: ${retiradas.map(r => `«${String(r.titulo).slice(0, 80)}»`).join(', ').slice(0, 300)}.`, { empresa_id });
  // Lo preparado para mandar: Paula decide con lo de hoy si hay que rehacerlo. Dirección solo ve el resultado
  const preparado = retiradas.filter(r => !['paso', 'ctl', 'sec'].includes(String(r.ref || '').split(':')[0]) && r.tipo !== 'llamada');
  if (preparado.length) await (await import('./tareas.js')).crear('paula', `Tras ${String(que).slice(0, 300)} he retirado de la mesa de Dirección: ${preparado.map(r => `«${String(r.titulo).slice(0, 100)}»`).join(', ')}. Lee la empresa y lo último hablado. Si algo sigue haciendo falta, vuelve a prepararlo con los datos de hoy (lo que sea un PDF, encárgaselo a ${PRO.ines ? 'Inés' : 'Nuria'}). Lo de antes solo puede aparecer como añadido a lo actual: «ahora es así; antes era de esta forma». Si no hace falta nada, no hagas nada y no avises a Dirección.`, { empresa_id, origen: 'sistema', animar: false });
  return { retiradas: retiradas.length };
}

/** La empresa se ha dado por perdida o descartada: nada de lo pendiente sigue en pie, ni en la mesa ni en la cola de los agentes. Tus recordatorios no se tocan. */
export async function cerrada(empresa_id, estado) {
  await q(`UPDATE pasos SET estado='cancelado' WHERE secuencia_id IN (SELECT id FROM secuencias WHERE empresa_id=$1) AND estado IN ('pendiente','programado','en_mesa')`, [empresa_id]);
  await q(`UPDATE secuencias SET estado='cerrada', control=NULL, control_fecha=NULL, actualizada=now() WHERE empresa_id=$1 AND estado IN ('borrador','activa','aparcada')`, [empresa_id]);
  await q(`UPDATE recordatorios SET hecho=now() WHERE empresa_id=$1 AND hecho IS NULL AND creado_por <> 'dueno'`, [empresa_id]);
  await q(`UPDATE tareas SET estado='error', resultado=$2, terminada=now() WHERE empresa_id=$1 AND estado='pendiente'`, [empresa_id, `Cancelada: la empresa está ${estado}`]);
  const retiradas = (await q(`UPDATE aprobaciones SET estado='superada', resuelta=now() WHERE empresa_id=$1 AND estado='pendiente' RETURNING id`, [empresa_id])).rows;
  for (const r of retiradas) await emitir({ tipo: 'aprobacion_resuelta', id: r.id, resultado: 'superada' });
  return retiradas.length;
}

/** Una sola vez: lo que se marcó como «nos han escrito» sin que nadie escribiera vuelve a ser de búsqueda. Su llamada «en caliente» se retira, o se rehace si la empresa da para llamarla, y también se rehacen los guiones de antes del método actual. La tarjeta sigue hasta que llega la nueva. */
export async function ponerAlDia() {
  const falsas = (await q(`UPDATE empresas e SET origen='busqueda' WHERE e.origen = ANY($1) AND NOT EXISTS (SELECT 1 FROM entradas x WHERE x.empresa_id=e.id) RETURNING e.id`, [SOLO_ENTRADA])).rows.map(e => e.id);
  await q(`UPDATE tareas SET estado='error', resultado='Cancelada: no nos han escrito, la encontramos buscando', terminada=now() WHERE agente='nuria' AND estado='pendiente' AND instruccion LIKE 'Llamada del día%' AND empresa_id = ANY($1)`, [falsas]);
  const tarjetas = (await q(`SELECT a.id, a.agente, a.texto, a.empresa_id, e.nombre, e.categoria, e.dossier IS NOT NULL AS con_dossier FROM aprobaciones a JOIN empresas e ON e.id=a.empresa_id
    WHERE a.estado='pendiente' AND a.opciones::text LIKE '%Ya he llamado%'`)).rows;
  const tareas = await import('./tareas.js');
  let retiradas = 0, rehechas = 0;
  for (const t of tarjetas) {
    const enCalienteFalsa = t.agente === 'nuria' && falsas.includes(t.empresa_id);
    if (enCalienteFalsa && !(['A', 'B'].includes(t.categoria) && t.con_dossier)) {
      await q(`UPDATE aprobaciones SET estado='superada', resuelta=now() WHERE id=$1`, [t.id]);
      await q(`UPDATE secuencias SET estado='descartada', actualizada=now() WHERE empresa_id=$1 AND estado='borrador'`, [t.empresa_id]);
      await q(`UPDATE empresas SET estado='puntuada' WHERE id=$1 AND estado='dossier' AND dossier IS NULL`, [t.empresa_id]);   // así vuelve al camino normal, con su dossier primero
      await emitir({ tipo: 'aprobacion_resuelta', id: t.id, resultado: 'superada' });
      retiradas++;
    } else if (enCalienteFalsa || (PRO.guiones && M.guiones.esAntiguo(t.texto))) {
      // Con la mesa llena tampoco espera: sustituye a la que hay, no añade otra
      await tareas.crear(enCalienteFalsa ? 'javi' : t.agente, `Rehaz el guion de la llamada a ${t.nombre} (id ${t.empresa_id}): el que tiene Dirección en la mesa es de antes del método actual${enCalienteFalsa ? ' y da por hecho que nos conocen, pero no nos han escrito: la encontramos buscando' : ''}. Lee con leer_empresa la empresa, su dossier y lo hablado, comprueba en su web qué usan hoy y entrégalo con guardar_secuencia (un solo paso: clave «llamada», canal «telefono»): sustituye al anterior. Si ya no tiene sentido llamarla, díselo a Dirección con anotar.`, { empresa_id: t.empresa_id, origen: 'secuencia' });
      rehechas++;
    }
  }
  if (retiradas || rehechas) await log('rafa', T`ha puesto la mesa al día: ${retiradas} llamadas retiradas porque no eran en caliente y ${rehechas} guiones antiguos para rehacer.`);
  return { falsas: falsas.length, retiradas, rehechas };
}

/** Una vez (6-nov): los guiones de la mesa que no se presentan primero, como empresa y para esa empresa, se rehacen. La tarjeta vieja sigue hasta que llega la nueva. */
export async function presentarseEnLosGuiones() {
  if (!PRO.guiones) return 0;   // sin el módulo de guiones no hay método que cumplir
  const tarjetas = (await q(`SELECT a.id, a.agente, a.texto, a.empresa_id, e.nombre FROM aprobaciones a JOIN empresas e ON e.id=a.empresa_id
    WHERE a.estado='pendiente' AND a.opciones::text LIKE '%Ya he llamado%'
      AND NOT EXISTS (SELECT 1 FROM tareas t WHERE t.empresa_id=a.empresa_id AND t.estado IN ('pendiente','en_curso') AND t.instruccion LIKE 'Rehaz el guion%')`)).rows
    .filter(t => !M.guiones.esAntiguo(t.texto) && M.guiones.revisar(t.texto).some(f => /presentarse/.test(f)));
  const tareas = await import('./tareas.js');
  for (const t of tarjetas) await tareas.crear(t.agente, `Rehaz el guion de la llamada a ${t.nombre} (id ${t.empresa_id}): el que tiene Dirección en la mesa entra hablando de su web sin presentarse. Dirección se presenta primero, como empresa y en plural, con lo que hacemos dicho para este tipo de empresa. Lee con leer_empresa la empresa, su dossier y lo hablado y entrégalo con guardar_secuencia (un solo paso: clave «llamada», canal «telefono»): sustituye al anterior.`, { empresa_id: t.empresa_id, origen: 'secuencia' });
  if (tarjetas.length) await log('rafa', T`ha pedido rehacer ${tarjetas.length} guiones de la mesa para que Dirección se presente primero, como empresa.`);
  return tarjetas.length;
}

/** Una vez (6-nov): las tarjetas de la mesa que le piden a Dirección descartar otra pierden esa frase (la otra ya se retiró sola). */
export async function sinOtrasTarjetasEnLaMesa() {
  const { sinOtrasTarjetas } = await import('./aprobaciones.js');
  for (const a of (await q(`SELECT id, texto FROM aprobaciones WHERE estado='pendiente' AND texto ~* 'tarjetas? (anterior )?\\(?[0-9a-f]{10}'`)).rows) {
    await q(`UPDATE aprobaciones SET texto=$2 WHERE id=$1`, [a.id, sinOtrasTarjetas(a.texto)]);
    await emitir({ tipo: 'aprobacion_editada', id: a.id });
  }
}

/** Una vez (6-nov): el texto para Lola que espera en la mesa se aplica al aprobarlo, y el atasco por no poder configurarla sobra. */
export async function lolaDesdeLaMesa() {
  await q(`UPDATE aprobaciones SET tipo='lola' WHERE estado='pendiente' AND tipo <> 'lola' AND titulo ~* '^texto de lola'`);
  for (const { id } of (await q(`UPDATE aprobaciones SET estado='superada', resuelta=now() WHERE estado='pendiente' AND texto ~* 'herramienta para configurar a Lola' RETURNING id`)).rows) await emitir({ tipo: 'aprobacion_resuelta', id, resultado: 'superada' });
  await q(`UPDATE bloqueos SET resuelto=now(), como='Lo que dice Lola se cambia con una tarjeta «lola»: al aprobarla, se aplica sola' WHERE resuelto IS NULL AND motivo ~* 'configurar a Lola'`);
}

/** Red de seguridad, cada poco: repasa lo que haya quedado atrás, también lo acumulado de antes de existir esto. */
export async function repasar() {
  const llamadas = (await q(`SELECT DISTINCT ON (l.empresa_id) l.empresa_id, coalesce(l.inicio, l.creada) AS cuando FROM llamadas l
    WHERE l.empresa_id IS NOT NULL AND (l.resultado IN ('hablado','volver_a_llamar','no_interesa') OR l.resumen IS NOT NULL)
      AND coalesce(l.inicio, l.creada) > now() - interval '30 days' AND coalesce(l.resultado,'') NOT IN ('no_contesta','buzon','no_esta','numero_equivocado')
      AND EXISTS (SELECT 1 FROM aprobaciones a WHERE a.empresa_id=l.empresa_id AND a.estado='pendiente' AND a.creada < coalesce(l.inicio, l.creada))
    ORDER BY l.empresa_id, coalesce(l.inicio, l.creada) DESC`)).rows;
  for (const l of llamadas) await ocurrio(l.empresa_id, { cuando: l.cuando, que: T('tu llamada') });
  const correos = (await q(`SELECT DISTINCT ON (c.empresa_id) c.empresa_id, c.creada AS cuando FROM correos c
    WHERE c.direccion='entrada' AND c.empresa_id IS NOT NULL AND c.creada > now() - interval '30 days'
      AND EXISTS (SELECT 1 FROM aprobaciones a WHERE a.empresa_id=c.empresa_id AND a.estado='pendiente' AND a.creada < c.creada)
    ORDER BY c.empresa_id, c.creada DESC`)).rows;
  for (const c of correos) await ocurrio(c.empresa_id, { cuando: c.cuando, que: T('su correo') });
  // Una llamada en la mesa no sigue si ya hay otra acordada para más adelante
  for (const { id } of (await q(`UPDATE aprobaciones a SET estado='superada', resuelta=now() WHERE a.estado='pendiente' AND a.empresa_id IS NOT NULL AND a.opciones::text LIKE '%Ya he llamado%'
    AND EXISTS (SELECT 1 FROM recordatorios r WHERE r.empresa_id=a.empresa_id AND r.hecho IS NULL AND r.clase='llamada' AND r.dia > CURRENT_DATE AND r.aprobacion_id IS DISTINCT FROM a.id) RETURNING a.id`)).rows) await emitir({ tipo: 'aprobacion_resuelta', id, resultado: 'superada' });
  // El aviso de una tarjeta pospuesta se va con ella, la resuelvas tú o se retire sola
  await q(`UPDATE recordatorios r SET hecho=now() FROM aprobaciones a WHERE r.hecho IS NULL AND r.aprobacion_id=a.id AND a.estado <> 'pendiente'`);
  // «Mandarle…» ya está hecho si después ha salido algo para esa empresa. Las llamadas y lo que apuntaste tú siguen en pie
  await q(`UPDATE recordatorios r SET hecho=now() WHERE r.hecho IS NULL AND r.clase IS NULL AND r.creado_por <> 'dueno' AND r.empresa_id IS NOT NULL AND r.texto ~* '^\\s*(mandar|enviar|pasar)'
    AND (EXISTS (SELECT 1 FROM aprobaciones a WHERE a.empresa_id=r.empresa_id AND a.estado='aprobada' AND a.tipo IN ('mensaje','respuesta','propuesta') AND a.resuelta > r.creado)
      OR EXISTS (SELECT 1 FROM correos c WHERE c.empresa_id=r.empresa_id AND c.direccion='salida' AND c.enviado > r.creado))`);
  // Una conversación que aún espera transcripción: la tarjeta de llamar deja de pedir «Ya he llamado»
  await q(`UPDATE aprobaciones a SET llamada_en=l.inicio FROM llamadas l WHERE a.empresa_id=l.empresa_id AND a.estado='pendiente' AND a.llamada_en IS NULL AND a.opciones::text LIKE '%Ya he llamado%'
    AND l.estado='pendiente' AND l.inicio > a.creada AND l.inicio > now() - interval '12 hours'`);
  // Lo que quedó marcado con el aviso de «revísalo», de cuando se hacía así
  const marcadas = (await q(`SELECT empresa_id, max(creada) + interval '1 second' AS cuando FROM aprobaciones WHERE estado='pendiente' AND desfasada IS NOT NULL AND empresa_id IS NOT NULL GROUP BY 1`)).rows;
  for (const m of marcadas) await ocurrio(m.empresa_id, { cuando: m.cuando, que: T('lo último que ha pasado') });
  // Una empresa cerrada no deja nada en la mesa, y las cartas en papel ya no se usan
  for (const { id, estado } of (await q(`SELECT DISTINCT e.id, e.estado FROM aprobaciones a JOIN empresas e ON e.id=a.empresa_id WHERE a.estado='pendiente' AND e.estado IN ('perdida','descartada')`)).rows) await cerrada(id, estado);
  for (const { id } of (await q(`UPDATE aprobaciones SET estado='superada', resuelta=now() WHERE estado='pendiente' AND titulo ~* 'preparado (una |la )?carta' RETURNING id`)).rows) await emitir({ tipo: 'aprobacion_resuelta', id, resultado: 'superada' });
  await q(`UPDATE empresas SET proximo_paso=NULL, fecha_proximo_paso=NULL WHERE proximo_paso ~* '\\mcarta\\M'`);
  await (await import('./aprobaciones.js')).ponerTelegramAlDia();
  return llamadas.length + correos.length + marcadas.length;
}
