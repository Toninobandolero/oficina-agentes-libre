// El protocolo comercial, en un solo sitio: qué se hace según lo que dice cada cliente, qué hay que saber antes de contactar y cuándo se deja de insistir.
// Lo leen los agentes, lo aplica el sistema y Dirección lo ve en Configuración y en la ficha de cada empresa.
import { q } from './db.js';
import { emitir, log } from './bus.js';
import * as empresas from './empresas.js';
import * as agenda from './agenda.js';
import { opciones as telefonos, deEmpresa as personas } from './contactos.js';
import { siguienteHueco } from './horario.js';
import { T } from './en.js';

// De lo más frío a lo más caliente. «dias» es cuándo se vuelve si no dijo fecha (sin «dias», no se vuelve) e «intentos», cuántas veces se insiste antes de dejarlo.
export const NIVELES = {
  baja: { emoji: '🛑', nombre: 'No quiere que le contactemos', dice: '«No me llaméis más», «borradme»', estado: 'descartada', cierra: true,
    hacer: 'Confirmarle que no volveremos a escribirle.', vuelve: 'Nunca', hasta: 'Se cierra para siempre.' },
  rechazo: { emoji: '🚫', nombre: 'No le interesa', dice: '«No me interesa lo más mínimo», «no lo necesitamos, gracias»', estado: 'perdida', cierra: true,
    hacer: 'Agradecerle el tiempo y no insistir.', vuelve: 'Nunca, salvo que venga él', hasta: 'Se cierra.' },
  ahora_no: { emoji: '🕓', nombre: 'Ahora no', dice: '«Más adelante», «estamos liados», «hablamos en enero»', dias: 90, intentos: 1,
    hacer: 'Agradecerle y volver una sola vez, en la fecha que dijo.', objetivo: 'ver si ya es buen momento', vuelve: 'En la fecha que dijo o a los 3 meses', hasta: 'Una vez. Si vuelve a decir que no, se deja.' },
  objecion: { emoji: '🤔', nombre: 'Tiene pegas', dice: '«Es caro», «ya tenemos a alguien», «no me fío de la IA»', estado: 'conversacion', dias: 5, intentos: 2,
    hacer: 'Responder a la pega con una pregunta, sin discutir.', objetivo: 'resolver la pega y conseguir 15 minutos', vuelve: 'A los 5 días', hasta: 'Dos intentos.' },
  deriva: { emoji: '👉', nombre: 'Nos manda a otra persona', dice: '«Eso lo lleva el dueño», «habla con Juan»', estado: 'conversacion', dias: 2, intentos: 2,
    hacer: 'Guardar a esa persona con su teléfono y hablar con ella citando a quien nos deriva.', objetivo: 'llegar a quien decide', vuelve: 'A los 2 días', hasta: 'Dos intentos.' },
  informacion: { emoji: '📄', nombre: 'Quiere información', dice: '«Mándame algo por correo»', estado: 'conversacion', dias: 3, intentos: 2,
    hacer: 'Mandarle hoy un diagnóstico de una página y llamarle después para comentarlo.', objetivo: 'saber si lo ha leído y conseguir 15 minutos', vuelve: 'A los 3 días', hasta: 'Dos intentos.' },
  interes: { emoji: '🙂', nombre: 'Le interesa', dice: '«Cuéntame más», «llámame el martes»', estado: 'conversacion', dias: 2, intentos: 3,
    hacer: 'Proponerle dos huecos concretos de 15 a 30 minutos.', objetivo: 'cerrar una reunión con día y hora', vuelve: 'En la fecha que dijo o a los 2 días', hasta: 'Tres intentos.' },
  urgente: { emoji: '🔥', nombre: 'Quiere verse cuanto antes', dice: '«Necesito que nos veamos cuanto antes»', estado: 'reunion', dias: 0, intentos: 3, urgente: true,
    hacer: 'Es lo primero de la oficina: cerrar hoy día y hora, y preparar lo que Dirección debe llevar.', objetivo: 'cerrar hoy día y hora', vuelve: 'Hoy mismo', hasta: 'Tres intentos.' },
};
export const SIN_HABLAR = [
  { emoji: '📵', nombre: 'No contesta, contestador o no está', hacer: 'Otro intento en otra franja horaria.', vuelve: 'Otro día bueno para su sector', hasta: 'Tres intentos en dos semanas. Después decides tú.' },
  { emoji: '☎️', nombre: 'El número no es suyo', hacer: 'Buscar otro teléfono.', vuelve: 'Cuando lo tengamos', hasta: 'Hasta encontrarlo o descartarla.' },
];
export const listado = () => Object.entries(NIVELES).map(([id, n]) => ({ id, ...n })).reverse();

const hoy = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(new Date());
const CALIENTES = ['web', 'google', 'gestoria', 'asociacion', 'evento', 'recomendacion', 'telegram', 'whatsapp', 'telefono'];

/** Lo mínimo antes de contactar. «A quién» no bloquea: una llamada puede servir para averiguarlo, pero el guion tiene que decirlo. */
export async function minimo(e) {
  const gente = await personas(e.id);
  const puntos = [
    { que: 'A quién dirigirse', ok: Boolean(e.decisor || gente.some(c => c.nombre)), aviso: true },
    { que: 'Cómo llegar a esa persona', ok: Boolean(e.telefono || e.email || e.whatsapp || e.linkedin_url || e.linkedin_empresa || e.direccion || gente.some(c => c.telefono || c.email)) },
    { que: 'A qué se dedican', ok: Boolean(e.sector || e.dossier) },
    { que: 'Por qué les puede interesar', ok: Boolean(e.dossier || e.notas || CALIENTES.includes(e.origen)) },
  ];
  return { puntos, faltan: puntos.filter(p => !p.ok && !p.aviso).map(p => p.que), avisos: puntos.filter(p => !p.ok && p.aviso).map(p => p.que) };
}

/** Lo que dice un cliente, con sus palabras. A partir de ahí el siguiente paso, su fecha y su motivo salen del protocolo, no del criterio de cada uno. */
export async function registrar(empresa_id, nivel, { frase = '', canal = '', cuando = null, por = 'paula' } = {}) {
  const n = NIVELES[nivel];
  if (!n) throw new Error(`Nivel no válido. Usa uno de: ${Object.keys(NIVELES).join(', ')}`);
  const e = await empresas.leer(empresa_id);
  if (!e) throw new Error(`No existe la empresa ${empresa_id}`);
  const dijo = String(frase).trim().slice(0, 300);
  if (!dijo) throw new Error('Falta lo que dijo, con sus palabras: es el motivo de todo lo que venga después.');
  const via = String(canal || '').trim().slice(0, 40) || null;
  const intento = e.interes === nivel ? (e.interes_intentos || 0) + 1 : 1;
  const agotado = Boolean(n.intentos) && intento > n.intentos;
  await q(`UPDATE empresas SET interes=$2, interes_frase=$3, interes_canal=$4, interes_fecha=now(), interes_intentos=$5 WHERE id=$1`, [e.id, nivel, dijo, via, intento]);

  // Ya ha contestado: la secuencia en frío se acaba, con sus tarjetas, y este paso sustituye a las llamadas que hubiera apuntadas
  await q(`UPDATE secuencias SET estado=$2, control=NULL, control_fecha=NULL, actualizada=now() WHERE empresa_id=$1 AND estado IN ('borrador','activa','aparcada')`, [e.id, n.cierra ? 'cerrada' : 'respondida']);
  await q(`UPDATE pasos SET estado='cancelado' WHERE secuencia_id IN (SELECT id FROM secuencias WHERE empresa_id=$1) AND estado IN ('pendiente','programado','en_mesa')`, [e.id]);
  const cartas = await q(`UPDATE aprobaciones SET estado='descartada', resuelta=now() WHERE empresa_id=$1 AND estado='pendiente' AND split_part(coalesce(ref,''), ':', 1) IN ('paso','ctl','sec') RETURNING id`, [e.id]);
  await q(`UPDATE recordatorios SET hecho=now() WHERE empresa_id=$1 AND hecho IS NULL AND clase='llamada' AND creado_por <> 'dueno'`, [e.id]);

  const dia = hoy();
  const fijada = String(cuando || '').match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/);
  let siguiente = null;
  if (n.dias != null && !agotado) {
    const hueco = fijada && fijada[1] >= dia ? { dia: fijada[1], hora: fijada[2] || '10:00' }
      : n.dias === 0 ? { dia, hora: new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date()) }
      : siguienteHueco(e.sector, '10:00', new Date(Date.parse(dia + 'T12:00:00Z') + (n.dias - 1) * 864e5).toISOString().slice(0, 10));
    const telefono = (await telefonos(e.id))[0]?.telefono || null;
    const quien = e.decisor && e.decisor !== e.nombre ? `${e.decisor} (${e.nombre})` : e.nombre;
    const fecha = new Date().toLocaleDateString('es-ES', { day: 'numeric', month: 'numeric', timeZone: 'Europe/Madrid' });
    const detalle = `Dijo: «${dijo}» (${[via, fecha].filter(Boolean).join(', ')}). ${n.nombre}. Objetivo: ${n.objetivo}. Intento ${intento} de ${n.intentos}.`;
    siguiente = { dia: hueco.dia, hora: hueco.hora, texto: `${telefono ? 'Llamar a' : 'Escribir a'} ${quien}`, detalle };
    await agenda.recordar({ ...siguiente, clase: telefono ? 'llamada' : null, creado_por: 'paula', empresa_id: e.id, telefono });
  }
  const proximo = agotado ? `Decidir si seguir: ${intento - 1} intentos sin avanzar` : siguiente ? siguiente.texto : null;
  await empresas.actualizar(e.id, { ...(n.estado ? { estado: n.estado } : {}), ultimo_contacto: dia, proximo_paso: proximo, fecha_proximo_paso: siguiente?.dia || null }, { desdeAgente: true });

  const linea = T`${n.emoji} ${e.nombre}: ${T(n.nombre).toLowerCase()}. Dijo «${dijo}».${agotado ? T` Van ${intento - 1} intentos sin avanzar: decide tú si seguir.` : siguiente ? T` Siguiente paso el ${siguiente.dia}.` : ''}`;
  await log(por, linea, { empresa_id: e.id, urgente: n.urgente || null });
  if (n.urgente) await (await import('./telegram.js')).avisar(`🔥 ${e.nombre} quiere verse cuanto antes.\nDijo: «${dijo}»\n${n.hacer}`);
  await (await import('./mesaViva.js')).ocurrio(e.id, { cuando: new Date(Date.now() - 120_000), que: T('lo que dijo') });   // con margen: lo recién preparado a raíz de esto no está desfasado
  for (const c of cartas.rows) await emitir({ tipo: 'aprobacion_resuelta', id: c.id, resultado: 'superada' });
  return { ok: true, nivel, hacer: agotado ? 'Ya se ha insistido lo que marca el protocolo: no prepares más, Dirección decide.' : n.hacer, siguiente, agotado };
}

/** Lo que enseña la ficha: cómo está, qué dijo, qué toca y por qué, y qué falta por saber. Qué toca sale de un solo sitio: el aviso pendiente más próximo o, si no hay, el siguiente paso de la ficha. */
export async function situacion(e) {
  const aviso = (await q(`SELECT id, dia, hora, texto, detalle, clase, telefono FROM recordatorios WHERE empresa_id=$1 AND hecho IS NULL ORDER BY dia, hora NULLS LAST LIMIT 1`, [e.id])).rows[0];
  const siguiente = aviso || (e.proximo_paso ? { texto: e.proximo_paso, dia: e.fecha_proximo_paso || null, de_ficha: true } : null);
  // Acaba de llamar: hasta que llegue la transcripción (unos minutos) no se sabe qué pasó, y qué toca aún no está al día
  const llamando = (await q(`SELECT m.creada FROM marcaciones m WHERE m.empresa_id=$1 AND m.creada > now() - interval '30 minutes'
    AND NOT EXISTS (SELECT 1 FROM llamadas l WHERE l.empresa_id=$1 AND l.estado NOT IN ('pendiente','transcrita') AND coalesce(l.inicio, l.creada) > m.creada - interval '2 minutes') ORDER BY m.creada DESC LIMIT 1`, [e.id])).rows[0]?.creada || null;
  return { nivel: NIVELES[e.interes] ? { id: e.interes, ...NIVELES[e.interes] } : null, frase: e.interes_frase, canal: e.interes_canal, fecha: e.interes_fecha, intentos: e.interes_intentos, siguiente, llamando, minimo: await minimo(e), niveles: listado() };
}

/** Para las instrucciones de quien trata con los clientes. */
export const textoParaAgentes = () => `## Protocolo comercial (obligatorio)
Cada vez que un contacto diga algo, por el canal que sea, usa registrar_interes con su frase literal: el sistema fija el siguiente paso, la fecha, el recordatorio con su motivo y cuándo dejar de insistir. No te inventes otros plazos. Y si cuenta algo que le duele, apúntalo en el campo dolores con actualizar_empresa: una línea por punto, con sus palabras y sin borrar lo que ya hubiera.
${listado().map(n => `- ${n.id} (${n.dice}): ${n.hacer} Se vuelve: ${n.vuelve}. ${n.hasta}`).join('\n')}
Si no se llegó a hablar con nadie, no es un nivel: lo lleva resultado_llamada.`;
