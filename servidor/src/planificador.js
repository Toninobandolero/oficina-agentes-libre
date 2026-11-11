// Rutinas programadas (hora de Madrid). Cada una se ejecuta como mucho una vez al día.
import { config } from './config.js';
import { PRO, M } from './modulos.js';
import { empezada } from './arranque.js';
import { q, ajuste, fijarAjuste } from './db.js';
import { log } from './bus.js';
import * as tareas from './tareas.js';
import * as departamentos from './departamentos.js';
import * as empresas from './empresas.js';
import * as telegram from './telegram.js';
import * as secuencias from './secuencias.js';
import * as ausencia from './ausencia.js';
import * as correo from './correo.js';
import * as alianzas from './alianzas.js';
import * as premios from './premios.js';
import { AGENTES } from './agentes.js';
import { emitir } from './bus.js';

// Lo programado no se le encarga a un departamento apagado
const encargar = (agente, ...resto) => (departamentos.trabaja(agente) ? tareas.crear(agente, ...resto) : null);
import * as aprobaciones from './aprobaciones.js';
import * as linkedin from './linkedin.js';
import * as vida from './vida.js';
import * as reunion from './reunion.js';
import * as perfil from './perfil.js';
import * as busqueda from './busqueda.js';
import * as boletin from './boletin.js';
import { T, LOCALE } from './en.js';

const DIAS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 };
export function madrid(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: config.zona, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(d).map(x => [x.type, x.value]));
  return { fecha: `${p.year}-${p.month}-${p.day}`, hora: `${p.hour}:${p.minute}`, dia: DIAS[p.weekday] };
}

async function unaVez(clave, fn) {
  if (await ajuste(clave)) return;
  await fijarAjuste(clave, true);
  await fn();
}

/** Topes diarios del trabajo automático. En turbo, el límite es el presupuesto (no hay topes por día). Con objetivo de empresas, los topes crecen para que quepa. */
export async function topes() {
  const turbo = (await (await import('./presupuesto.js')).ajustes().catch(() => ({}))).turbo;
  const dia = busqueda.porDia(await busqueda.leer());
  return turbo ? { turbo, mateo: Math.max(config.maxAnalisisDia, 250), lucia: 40, carmen: 30, stock: 40 }
               : { turbo, mateo: Math.max(config.maxAnalisisDia, dia), lucia: Math.max(6, Math.ceil(dia / config.empresasPorBusqueda) + 2), carmen: Math.max(8, Math.ceil(dia * 0.8)), stock: Math.max(10, dia * 3) };
}

export async function encolarAnalisisPendientes() {
  const tp = await topes();
  const hueco = Math.min(tp.mateo - (await tareas.creadasHoy('mateo')), tp.turbo ? 6 : 1000);   // en turbo, de 6 en 6 (que se repartan)
  if (hueco <= 0) {
    // Que no se pare la cadena en silencio: si quedan empresas sin puntuar, se ve en la actividad (una vez al día)
    const n = (await q(`SELECT count(*)::int n FROM empresas WHERE estado='nueva'`)).rows[0].n;
    if (n) await unaVez('tope-mateo:' + new Date().toISOString().slice(0, 10), () => log('mateo', T`ha llegado a su tope de ${tp.mateo} análisis de hoy y quedan ${n} empresas por puntuar: sigue mañana a primera hora (o activa el modo turbo en el panel, en «IA: …»).`));
    return 0;
  }
  const r = await q(`SELECT e.id, e.nombre FROM empresas e
                      WHERE e.estado = 'nueva' AND NOT EXISTS (SELECT 1 FROM tareas t WHERE t.agente='mateo' AND t.empresa_id=e.id)
                      ORDER BY e.creada LIMIT $1`, [Math.max(0, hueco - (await q(`SELECT count(*)::int n FROM tareas WHERE agente='mateo' AND estado IN ('pendiente','en_curso')`)).rows[0].n)]);
  for (const e of r.rows) await encargar('mateo', `Puntúa la empresa ${e.nombre} (id ${e.id}).`, { empresa_id: e.id, origen: 'sistema' });
  return r.rows.length;
}

async function avisoSeguimientos() {
  const v = await empresas.seguimientosVencidos();
  if (!v.length) return;
  const lista = v.map(e => `• ${e.nombre}: ${e.proximo_paso || 'seguimiento'} (${e.fecha_proximo_paso})`).join('\n');
  await telegram.avisar(`📅 Seguimientos para hoy (${v.length}):\n${lista}\n\nLos textos de seguimiento están en el mensaje que aprobaste de cada empresa.`);
  await log('sistema', T`recuerda ${v.length} seguimiento${v.length === 1 ? '' : 's'} para hoy: ${v.slice(0, 3).map(e => e.nombre).join(', ')}${v.length > 3 ? '…' : ''}`);
}

/** Clientes que llevan meses sin noticias nuestras (ajuste meses_toque, 6 por defecto): como mucho una vez al día, Paula le propone a Dirección
 *  un toque a uno de ellos, si Ventas está activo. No se repite: ni con trabajo pendiente sobre esa empresa, ni si ya se le propuso hace
 *  menos de un mes, ni mientras tenga apuntado un siguiente paso. Al aprobar el toque queda anotado el último contacto. */
export async function toqueClientes() {
  const meses = Number(await ajuste('meses_toque', 6)) || 6;
  const e = (await q(`SELECT id, nombre, coalesce(ultimo_contacto, actualizada::date)::text AS ultimo FROM empresas e
                       WHERE estado = 'ganada' AND coalesce(ultimo_contacto, actualizada::date) < CURRENT_DATE - make_interval(months => $1)
                         AND (fecha_proximo_paso IS NULL OR fecha_proximo_paso <= CURRENT_DATE)
                         AND NOT EXISTS (SELECT 1 FROM tareas t WHERE t.empresa_id = e.id AND t.estado IN ('pendiente','en_curso'))
                         AND NOT EXISTS (SELECT 1 FROM tareas t WHERE t.empresa_id = e.id AND t.instruccion LIKE 'Toque a un cliente:%' AND t.creada > now() - interval '30 days')
                       ORDER BY coalesce(ultimo_contacto, actualizada::date) LIMIT 1`, [meses])).rows[0];
  if (!e) return 0;
  const t = await encargar('paula', `Toque a un cliente: ${e.nombre} (id ${e.id}) ya es cliente y no hablamos con ellos desde ${e.ultimo}. Lee su ficha con leer_empresa y proponle a Dirección un mensaje corto para retomar el contacto (interesarse por cómo les va y si necesitan algo; sin vender), con pedir_aprobacion (tipo 'mensaje'): no se envía nada sin que él lo apruebe. Después apunta el siguiente toque con actualizar_empresa (proximo_paso y fecha_proximo_paso, dentro de ${meses} meses) para que no se repita.`, { empresa_id: e.id, origen: 'sistema' });
  return t ? 1 : 0;
}

// Qué buscar: lo configurado o, si no, lo que diga la ficha de la empresa
function objetivosBusqueda(obj) {
  if (obj?.focos?.length) return obj.focos;
  if (config.busquedasAuto.length) return config.busquedasAuto;
  const e = perfil.leer().empresa || {};
  return [e.cliente_ideal, e.sectores].map(x => String(x || '').trim()).filter(Boolean).map(x => (e.zona ? `${x} en ${e.zona}` : x));
}

export async function lanzarBusqueda() {
  const obj = await busqueda.leer();
  if (obj?.cantidad === 0) return;   // esta oficina no busca
  const focos = objetivosBusqueda(obj), n = focos.length;
  if (!n) return;
  const i = Number(await ajuste('busqueda_idx', 0)) || 0;
  await fijarAjuste('busqueda_idx', i + 1);
  const objetivo = focos[i % n];
  const cuantas = obj ? Math.min(config.empresasPorBusqueda, (await busqueda.progreso(obj)).falta_hoy) : config.empresasPorBusqueda;
  if (cuantas > 0) await encargar('lucia', `Busca ${cuantas} empresas nuevas: ${objetivo}. Prioriza las que mejor encajen con el cliente ideal.`, { origen: 'sistema' });
}

let ultimaVoz = 0;
let ultimoRepasoMesa = 0;
export async function tick() {
  const m = madrid();
  correo.revisarBuzon().catch(e => console.error('Correo:', e.message));   // cada 5 minutos como mucho
  unaVez('dolores-rellenos', rellenarDolores).catch(e => console.error('Dolores:', e.message));
  unaVez('decisores-a-contactos-2', async () => (await import('./contactos.js')).migrarDecisores()).catch(e => console.error('Decisores:', e.message));
  unaVez('contactos-arreglados', async () => (await import('./contactos.js')).arreglarRecogidos()).catch(e => console.error('Contactos:', e.message));
  unaVez('sin-otras-tarjetas', async () => (await import('./mesaViva.js')).sinOtrasTarjetasEnLaMesa()).catch(e => console.error('Sin otras tarjetas:', e.message));
  unaVez('lola-desde-la-mesa', async () => (await import('./mesaViva.js')).lolaDesdeLaMesa()).catch(e => console.error('Lola desde la mesa:', e.message));
  unaVez('guiones-con-presentacion', async () => (await import('./mesaViva.js')).presentarseEnLosGuiones()).catch(e => console.error('Guiones con presentación:', e.message));
  unaVez('mesa-puesta-al-dia', async () => (await import('./mesaViva.js')).ponerAlDia()).catch(e => console.error('Mesa al día:', e.message));
  import('./motor.js').then(x => x.revisarCredito()).catch(e => console.error('Crédito de IA:', e.message));   // parado sin crédito: cada 15 minutos como mucho
  if (PRO.vigilante && Date.now() - ultimoVigilante > 30 * 60_000) { ultimoVigilante = Date.now(); M.vigilante.revisar().catch(e => console.error('Vigilante:', e.message)); }
  if (PRO.vigilante && m.hora >= '08:30') await unaVez('pruebaCorreo:' + m.fecha, () => M.vigilante.probarCorreo());
  if (PRO.vigilante && m.hora >= '09:10') await unaVez('repasoDatos:' + m.fecha, () => M.vigilante.repasarDatos());
  if (Date.now() - ultimoRepasoMesa > 10 * 60_000) { ultimoRepasoMesa = Date.now(); import('./mesaViva.js').then(x => x.repasar()).catch(e => console.error('Mesa viva:', e.message)); }
  boletin.revisar().catch(e => console.error('Boletín:', e.message));      // uno por vuelta
  if (m.hora >= '08:30') await unaVez('analisis:' + m.fecha, encolarAnalisisPendientes);
  if (m.hora >= '09:00') await unaVez('seguimientos:' + m.fecha, avisoSeguimientos);
  // Modo ausencia: vuelta automática el día indicado, resumen al despertar, secuencias congeladas mientras estás fuera
  const vac = await ausencia.vacaciones();
  if (vac?.hasta && m.fecha >= vac.hasta && m.hora >= config.suenoHasta) {
    const r = await ausencia.volver();
    if (r) await (await import('./index.js')).alVolver(r);
  }
  if (!vac && m.hora >= config.suenoHasta && !ausencia.esHoraDeDormir(m.hora)) await unaVez('despertar:' + m.fecha, async () => (await import('./index.js')).despertar());
  if (!vac && m.hora >= '09:00') await unaVez('secuencias:' + m.fecha, secuencias.revisar);   // Paula te pone en la mesa lo que toca hoy
  if (!vac && m.hora >= '09:05') await unaVez('toque:' + m.fecha, toqueClientes);   // y propone un toque a un cliente que lleva meses sin noticias
  if (m.hora >= '04:00') await unaVez('mantenimiento:' + m.fecha, () => mantenimiento().catch(e => console.error('Mantenimiento:', e.message)));
  if (m.dia === config.inteligenciaDia && m.hora >= config.inteligenciaHora) await unaVez('inteligencia:' + m.fecha, () => encargar('sara', 'Prepara el informe semanal de inteligencia (mercado, competencia, ayudas y canales) y envíaselo a Dirección.', { origen: 'sistema' }));
  if (m.dia === 1 && m.hora >= '08:45') await unaVez('informe:' + m.fecha, () => encargar('rafa', 'Prepara el informe semanal del embudo y envíaselo a Dirección.', { origen: 'sistema' }));
  await captacion(m, vac);
}

let ultimoFlujo = 0, ultimoVigilante = 0;
/** Cada 15 minutos en horario de oficina (en turbo, en cada vuelta y a cualquier hora): si la cadena se queda sin trabajo, se le da a quien toca. */
async function flujo() {
  const tp = await topes();
  if (Date.now() - ultimoFlujo < (tp.turbo ? 25_000 : 15 * 60_000)) return;
  ultimoFlujo = Date.now();
  const n = async sql => Number((await q(sql)).rows[0].n);
  const ocupado = async ag => (await n(`SELECT count(*)::int n FROM tareas WHERE agente='${ag}' AND estado IN ('pendiente','en_curso')`)) > 0;
  // 1) Puntuar lo nuevo sin esperar a mañana (con el tope diario)
  await encolarAnalisisPendientes();
  // 2) La cola tira de la búsqueda: siempre tiene que haber al menos una empresa esperando análisis.
  //    Se busca si el inicio de la cola está vacío, o si toda la cadena está parada; no, si ya hay trabajo de sobra por delante.
  const nuevas = await n(`SELECT count(*)::int n FROM empresas WHERE estado='nueva'`);
  const stock = await n(`SELECT count(*)::int n FROM empresas e WHERE e.estado='nueva' OR (e.estado='puntuada' AND e.categoria IN ('A','B') AND e.dossier IS NULL)
                          OR (e.estado='dossier' AND NOT EXISTS (SELECT 1 FROM secuencias s WHERE s.empresa_id=e.id AND s.estado IN ('borrador','activa','respondida','aparcada')))`);
  const cadenaParada = !(await ocupado('mateo')) && !(await ocupado('carmen')) && !(await ocupado('javi'));
  // Con objetivo, se busca lo que falte para ir al día (0 = esta oficina no busca, ni en turbo). Sin objetivo, cuando la cola se vacía.
  // Turbo: Lucía busca sin parar mientras no se acumule demasiado por puntuar
  const obj = await busqueda.leer();
  let cuantas = config.empresasPorBusqueda;
  let hayQueBuscar;
  if (obj?.cantidad === 0) hayQueBuscar = false;
  else if (tp.turbo) hayQueBuscar = nuevas < 15 && stock < tp.stock;
  else if (obj) { cuantas = Math.min(cuantas, (await busqueda.progreso(obj)).falta_hoy); hayQueBuscar = cuantas > 0 && stock < tp.stock; }
  else hayQueBuscar = (nuevas === 0 || cadenaParada) && stock < tp.stock;
  const focos = objetivosBusqueda(obj);
  if (hayQueBuscar && !(await ocupado('lucia')) && (await tareas.creadasHoy('lucia')) < tp.lucia && focos.length) {
    const i = Number(await ajuste('busqueda_idx', 0)) || 0;
    await fijarAjuste('busqueda_idx', i + 1);
    const foco = focos[i % focos.length];
    await encargar('lucia', `${obj?.cantidad ? 'Para llegar al objetivo de empresas de Dirección' : 'Quedan pocas empresas por trabajar'}: busca ${cuantas} empresas nuevas: ${foco}. Prioriza las que más se parezcan a las mejor puntuadas (categoría A y B) y evita las que ya tenemos.`, { origen: 'sistema' });
  }
  // 3) A/B puntuadas sin dossier → Carmen (como mucho 8 al día).
  // 3b) Las C «al límite» (≥ 45) suelen ser C por FALTA DE DATOS (sociedad, tamaño, decisor, señales de necesidad), no por
  //     mal encaje: Carmen investiga lo que falta y Mateo la vuelve a puntuar. Cada día, después de los dos primeros dossiers,
  //     se reservan dos huecos para esto (antes solo se hacía si no quedaba ninguna A/B y casi nunca llegaba).
  if (!(await ocupado('carmen')) && (await tareas.creadasHoy('carmen')) < tp.carmen) {
    const e = (await q(`SELECT id, nombre, categoria, puntuacion FROM empresas WHERE estado='puntuada' AND categoria IN ('A','B') AND dossier IS NULL ORDER BY categoria, puntuacion DESC NULLS LAST LIMIT 1`)).rows[0];
    const c = (await q(`SELECT id, nombre, puntuacion, confianza FROM empresas e WHERE estado='puntuada' AND categoria='C' AND coalesce(puntuacion,0) >= 45
                          AND coalesce(confianza,'baja') IN ('baja','media')
                          AND NOT EXISTS (SELECT 1 FROM tareas t WHERE t.empresa_id=e.id AND t.agente='carmen')
                        ORDER BY puntuacion DESC NULLS LAST LIMIT 1`)).rows[0];
    const hoy = await n(`SELECT count(*) FILTER (WHERE instruccion LIKE 'Prepara el dossier%')::int AS n FROM tareas WHERE agente='carmen' AND creada >= date_trunc('day', now() AT TIME ZONE 'Europe/Madrid') AT TIME ZONE 'Europe/Madrid'`);
    const enriq = await n(`SELECT count(*)::int n FROM tareas WHERE agente='carmen' AND instruccion LIKE '%se quedó en C%' AND creada >= date_trunc('day', now() AT TIME ZONE 'Europe/Madrid') AT TIME ZONE 'Europe/Madrid'`);
    const tocaEnriquecer = c && (!e || (hoy >= 2 && enriq < 2));
    if (e && !tocaEnriquecer) await encargar('carmen', `Prepara el dossier de ${e.nombre} (id ${e.id}): categoría ${e.categoria}, ${e.puntuacion ?? '¿?'}/100.`, { empresa_id: e.id, origen: 'sistema' });
    else if (c) await encargar('carmen', `${c.nombre} (id ${c.id}) se quedó en C (${c.puntuacion}/100, confianza ${c.confianza || 'baja'}) más por falta de datos que por mal encaje. Investiga a fondo lo que falta: la sociedad que hay detrás (razón social, CIF si es público, facturación o empleados aproximados), cuántos locales o centros tienen, quién decide (nombre y cargo, con su LinkedIn si lo encuentras) y señales de que pierden tiempo en tareas manuales (ofertas de empleo de administración o recepción, reservas por teléfono, quejas en reseñas por esperas o errores). Guárdalo con actualizar_empresa y después encárgale a Mateo con encargar que la vuelva a puntuar con los datos nuevos. No prepares dossier todavía: si Mateo la sube a A o B, el dossier llega solo.`, { empresa_id: c.id, origen: 'sistema' });
  }
  // 4) Con dossier y sin contacto → Javi prepara el primer contacto (si tu mesa no está llena)
  if (!(await ocupado('javi')) && !(await ausencia.frenados()).includes('javi')) {
    const e = (await q(`SELECT e.id, e.nombre FROM empresas e WHERE e.estado='dossier' AND e.dossier IS NOT NULL
                          AND NOT EXISTS (SELECT 1 FROM secuencias s WHERE s.empresa_id=e.id AND s.estado IN ('borrador','activa','respondida','aparcada'))
                          AND NOT EXISTS (SELECT 1 FROM aprobaciones a WHERE a.empresa_id=e.id AND a.estado='pendiente') ORDER BY e.actualizada LIMIT 1`)).rows[0];
    if (e) await encargar('javi', `Prepara el primer contacto con ${e.nombre} (id ${e.id}).`, { empresa_id: e.id, origen: 'sistema' });
  }
}

export const _flujo = () => { ultimoFlujo = 0; return flujo(); };   // pruebas

/** Al activar el turbo, el equipo empieza ya, sin esperar a la siguiente vuelta, y se cuenta quién se pone a trabajar. */
export async function arrancarTurbo() {
  if (await ajuste('pausado', config.pausadoInicial)) return log('rafa', T('tiene el turbo activado, pero el equipo está en pausa: reanúdalo para que empiecen.'));
  if (await ausencia.vacaciones()) return log('rafa', T('tiene el turbo activado, pero estás de vacaciones: no empezamos trabajo nuevo hasta que vuelvas.'));
  const inicio = new Date();
  ultimoFlujo = 0;
  await flujo();
  const r = await q(`SELECT DISTINCT agente FROM tareas WHERE origen='sistema' AND (estado IN ('pendiente','en_curso') OR creada >= $1)`, [inicio]);
  const quien = r.rows.map(x => AGENTES[x.agente]?.nombre ?? x.agente);
  return log('rafa', quien.length ? T`pone el turbo en marcha: ya se ponen a trabajar ${new Intl.ListFormat(LOCALE()).format(quien)}.` : T('tiene el turbo activado, pero ahora mismo no hay trabajo automático que lanzar.'));
}

// Llamadas en caliente (Nuria): a empresas que ya nos conocen (nos escribieron, están en conversación, aceptaron
// la conexión y ya recibieron un mensaje, o vienen recomendadas). El primer contacto lo lleva Javi en la secuencia:
// solicitud de LinkedIn y llamada al día siguiente sin esperar a que acepte (solo sociedades). Desde el 17/10/2026
// las llamadas comerciales deben salir de un número 400: pedírselo a Zadarma para esas llamadas.
/** Máximo, una vez al día: lo que le toca a Dirección hoy. Lo demás no le escribe. */
async function resumenDeHoy() {
  const r = (await q(`SELECT count(DISTINCT coalesce(empresa_id, id)) FILTER (WHERE split_part(coalesce(ref, ''), ':', 1) IN ('sec','paso') OR tipo IN ('mensaje','correo'))::int AS contactos,
                             count(DISTINCT coalesce(empresa_id, id)) FILTER (WHERE split_part(coalesce(ref, ''), ':', 1) NOT IN ('sec','paso') AND tipo NOT IN ('mensaje','correo') AND prioridad <= 2)::int AS importantes
                        FROM aprobaciones WHERE estado='pendiente' AND (pospuesta IS NULL OR pospuesta < now())`)).rows[0];
  if (!r.contactos && !r.importantes) return;
  await (await import('./telegram.js')).avisar(`☀️ Buenos días, Dirección. Hoy tienes ${r.contactos} empresa${r.contactos === 1 ? '' : 's'} para contactar${r.importantes ? ` y ${r.importantes} cosa${r.importantes === 1 ? '' : 's'} que solo puedes resolver tú` : ''}.${config.panelUrl ? `\n${config.panelUrl}` : ''}`);
}

/** Una sola vez: lo que ya contaron en llamadas de antes pasa a «Lo que nos ha contado» de su ficha. */
export async function rellenarDolores() {
  const r = await q(`SELECT DISTINCT e.id, e.nombre FROM empresas e JOIN llamadas l ON l.empresa_id=e.id WHERE e.dolores IS NULL AND l.resumen IS NOT NULL AND coalesce(l.segundos,0) >= 60 AND e.estado NOT IN ('perdida','descartada')`);
  for (const e of r.rows) await tareas.crear('paula', `Solo esto, sin preparar nada para Dirección ni escribir a nadie: lee con leer_empresa lo hablado con ${e.nombre} (id ${e.id}) y apunta en el campo dolores, con actualizar_empresa, lo que le duele con sus palabras: una línea por punto, con la fecha de la llamada. Si no contó nada, no apuntes nada.`, { empresa_id: e.id, origen: 'sistema' });
  return r.rows.length;
}

export async function llamadasDelDia() {
  const r = await q(`SELECT e.id, e.nombre, e.telefono, e.estado, e.origen, x.acordada,
                            (SELECT p.clave FROM secuencias s JOIN pasos p ON p.secuencia_id=s.id WHERE s.empresa_id=e.id AND p.clave IN ('mensaje1','seguimiento1','seguimiento2') AND p.estado='hecho' ORDER BY p.hecho DESC LIMIT 1) AS ultimo_paso
                       FROM empresas e, LATERAL (SELECT EXISTS (SELECT 1 FROM recordatorios r WHERE r.empresa_id=e.id AND r.hecho IS NULL AND r.clase='llamada' AND r.dia = CURRENT_DATE) AS acordada) x
                      WHERE e.estado NOT IN ('ganada','perdida','descartada','nueva') AND (x.acordada OR (e.telefono IS NOT NULL AND e.telefono <> ''))
                        AND NOT EXISTS (SELECT 1 FROM tareas t WHERE t.empresa_id=e.id AND t.agente='nuria' AND t.instruccion LIKE 'Llamada del día%' AND t.creada > now() - interval '12 hours')
                        AND NOT EXISTS (SELECT 1 FROM aprobaciones a WHERE a.empresa_id=e.id AND a.estado='pendiente' AND a.opciones::text LIKE '%Ya he llamado%')
                        AND (x.acordada OR (
                          NOT EXISTS (SELECT 1 FROM tareas t WHERE t.empresa_id=e.id AND t.agente='nuria' AND t.instruccion LIKE 'Llamada del día%' AND t.creada > now() - interval '30 days')
                          -- Con fecha acordada o recién hablado, llamar hoy sería adelantarse
                          AND (e.fecha_proximo_paso IS NULL OR e.fecha_proximo_paso <= CURRENT_DATE)
                          AND NOT EXISTS (SELECT 1 FROM recordatorios r WHERE r.empresa_id=e.id AND r.hecho IS NULL AND r.dia > CURRENT_DATE)
                          AND NOT EXISTS (SELECT 1 FROM llamadas l WHERE l.empresa_id=e.id AND coalesce(l.inicio, l.creada) > now() - interval '3 days')
                          AND (e.estado IN ('conversacion','reunion','propuesta')
                               OR e.origen IN ('gestoria','asociacion','evento','recomendacion','telegram','whatsapp','telefono')
                               OR EXISTS (SELECT 1 FROM secuencias s JOIN pasos p ON p.secuencia_id=s.id WHERE s.empresa_id=e.id
                                            AND p.clave IN ('mensaje1','seguimiento1') AND p.estado='hecho' AND p.hecho < now() - interval '3 days'))))
                      ORDER BY x.acordada DESC, (e.estado IN ('conversacion','reunion','propuesta')) DESC, coalesce(e.puntuacion,0) DESC LIMIT 5`);
  for (const e of r.rows) {
    const porque = e.acordada ? 'tenéis una llamada acordada para hoy: parte de lo que ya contaron y proponle algo concreto' : ['conversacion', 'reunion', 'propuesta'].includes(e.estado) ? `ya estamos en conversación con ellos (estado «${e.estado}»)`
      : e.ultimo_paso ? `aceptaron la conexión en LinkedIn y ya les escribimos (${e.ultimo_paso}) hace más de 3 días sin respuesta`
      : `llegaron por ${e.origen} (nos conocen)`;
    const telefonos = await (await import('./contactos.js')).lineaTelefonos(e.id);
    await encargar('nuria', `Llamada del día (en caliente): ${e.nombre} (id ${e.id}). A quién se puede llamar: ${telefonos || e.telefono}. Di en el guion a quién y a qué número, mejor al de quien decide que al general. Por qué se le llama: ${porque}. Lee la empresa, su dossier y lo que ya se ha hablado con leer_empresa y escribe el guion de la llamada para Dirección con guardar_secuencia (un solo paso: clave «llamada», canal «telefono»):${PRO.guiones ? ' con el método de guiones de llamada,' : ''} abriendo por lo que ya hay entre nosotros (el mensaje, la conexión, su consulta). Si es un autónomo o un particular, no se llama: díselo a Dirección con anotar.`, { empresa_id: e.id, origen: 'sistema' });
  }
  return r.rows.length;
}

/** Lo que se repite en las llamadas de la semana. Con menos de dos no hay patrón que valga, y no se gasta. */
export async function repasoLlamadas() {
  const r = (await q(`SELECT l.resumen, l.mejoras, e.nombre FROM llamadas l LEFT JOIN empresas e ON e.id=l.empresa_id WHERE l.mejoras IS NOT NULL AND coalesce(l.inicio, l.creada) > now() - interval '7 days' ORDER BY coalesce(l.inicio, l.creada)`)).rows;
  if (r.length < 2) return 0;
  await tareas.crear('paula', `Repaso de las llamadas de Dirección de esta semana (${r.length}). Busca lo que se repite, no lo de una sola llamada: si necesitas lo que se dijo, leer_empresa con transcripciones. Tu respuesta final es lo que le llega, en 10 líneas como mucho: LO QUE TE FUNCIONA, LO QUE CAMBIARÍA (con su frase literal y cómo decirla) y UNA COSA para la semana que viene.\n\n` +
    r.map(l => `${l.nombre || 'Número sin empresa'}\nResumen: ${l.resumen || '(sin resumen)'}\nLo visto: ${l.mejoras}`).join('\n\n'), { origen: 'secuencia' });
  return r.length;
}

const sumar = (f, n) => { const d = new Date(f + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/** El encargo de contenido de los lunes. Un guion de vídeo cada vez: mientras haya uno en tu mesa, no se prepara otro. */
export async function encargoContenido(fecha) {
  const hayGuion = (await q(`SELECT 1 FROM aprobaciones WHERE tipo='video' AND estado='pendiente' LIMIT 1`)).rows.length > 0;
  return `Prepara el contenido de esta semana: ${hayGuion ? '' : `el guion del vídeo (tipo 'video') y `}2 ideas para redes (martes ${sumar(fecha, 1)} y jueves ${sumar(fecha, 3)}), cada una en un post para LinkedIn, otro para Facebook y otro para Instagram. Cada pieza con su canal y fecha_prevista.`;
}

/** El trabajo semanal de los departamentos propios, a la primera persona de cada uno. */
export async function semanales(m, vac) {
  if (!vac) for (const d of departamentos.propios()) if (d.semanal && m.dia === d.semanal.dia && m.hora >= d.semanal.hora) await unaVez(`semanal-${d.id}:${m.fecha}`, () => encargar(d.agentes[0], d.semanal.instruccion, { origen: 'sistema' }));
}

/** Dos veces al día, Máximo mira la oficina como gerente, sin esperar a que nadie le escriba. */
export const revisarGerencia = () => tareas.crear('rafa', 'Revisión del gerente. Mira ver_mesa, ver_cola y resumen_embudo. Lo primero, los contactos calientes: si alguien espera algo de Dirección hoy (ha pedido que le llamen, ha contestado con interés) y su tarjeta no está en urgente, súbela con priorizar_tarjeta; si no hay tarjeta, encárgasela a quien toque. Si algo importante espera detrás de trabajo que no corre prisa, adelántalo con mover_tarea. Si un trabajo ya no hace falta, cancélalo. Si algo lleva días parado y falta quien lo haga, encárgalo. No le escribas a Dirección por esto salvo que te necesite. Si no hay nada que cambiar, termina con «Sin cambios».', { origen: 'sistema' });

/** Captación: contenido, web, alianzas y eventos. No se programa nada nuevo para tu mesa si estás de vacaciones. */
/** Lo que gasta IA sin que nadie lo pida: en pausa, no. Si Dirección reanuda ese mismo lunes, la reunión se celebra. */
export async function reunionYCharlas(m, vac) {
  if (await ajuste('pausado', config.pausadoInicial)) return;
  // Reunión de equipo: los lunes a las 10:00 (después del informe del embudo)
  if (!vac && m.dia === config.reunionDia && m.hora >= config.reunionHora) await unaVez('reunion:' + m.fecha, async () => {
    await emitir({ tipo: 'aviso_agenda', clase: 'reunion', hora: config.reunionHora, titulo: T('Empieza la reunión de equipo'), detalle: T('Cada uno cuenta lo que lleva. Máximo te deja el acta en la actividad cuando acabe.') });
    await reunion.celebrar().catch(e => console.error('Reunión:', e.message));
    await emitir({ tipo: 'aviso_agenda', clase: 'reunion', titulo: T('Ha terminado la reunión de equipo'), detalle: T('El acta está en la actividad: lo que te piden va enlazado.') });
  });
  // Vida de oficina: las charlas del día, una sola llamada barata por la mañana
  if (vida.estaActiva() && m.hora >= '07:45' && m.hora < '20:00') await vida.charlasSiFaltan().catch(e => console.error('Charlas:', e.message));
}

/** Cada mañana: las llamadas apuntadas para hoy que no tienen guion en la mesa, Javi se lo prepara partiendo de las llamadas anteriores. Como mucho 8. */
export async function guionesDelDia() {
  const citas = (await q(`SELECT DISTINCT ON (r.empresa_id) r.empresa_id, r.texto, r.detalle, r.hora, e.nombre FROM recordatorios r JOIN empresas e ON e.id = r.empresa_id
    WHERE r.clase='llamada' AND r.hecho IS NULL AND r.dia = CURRENT_DATE AND e.estado NOT IN ('perdida','descartada')
      AND NOT EXISTS (SELECT 1 FROM aprobaciones a WHERE a.empresa_id = r.empresa_id AND a.estado='pendiente' AND a.texto ~* '(^|\n)\s*(LLAMADA|GUI[OÓ]N)')
      AND NOT EXISTS (SELECT 1 FROM tareas t WHERE t.agente='javi' AND t.empresa_id = r.empresa_id AND t.estado IN ('pendiente','en_curso'))
    ORDER BY r.empresa_id, r.hora LIMIT 8`)).rows;
  for (const c of citas) {
    const previas = (await q(`SELECT to_char(coalesce(inicio, creada) AT TIME ZONE 'Europe/Madrid', 'DD/MM HH24:MI') AS cuando, resultado, left(resumen, 600) AS resumen FROM llamadas WHERE empresa_id=$1 ORDER BY coalesce(inicio, creada) DESC LIMIT 3`, [c.empresa_id])).rows;
    await encargar('javi', `Prepara el guion de la llamada de hoy${c.hora ? ` a las ${c.hora}` : ''} a ${c.nombre} (id ${c.empresa_id}). Motivo apuntado: ${c.texto}${c.detalle ? ` (${c.detalle})` : ''}.`
      + (previas.length ? `\nLlamadas anteriores:\n${previas.map(x => `— ${x.cuando}: ${x.resultado || 'sin resultado'}${x.resumen ? `. ${x.resumen}` : ''}`).join('\n')}\nEl guion empieza por lo que pasó y sigue desde ahí; no lo escribas como si fuera la primera vez.` : '')
      + `\nEntrégalo con pedir_aprobacion: título «ha preparado la llamada a ${c.nombre}», con el bloque LLAMADA, su OBJETIVO en una línea y el GUION.`, { empresa_id: c.empresa_id, origen: 'sistema' });
  }
  return citas.length;
}

async function captacion(m, vac) {
  const dm = Number(m.fecha.slice(8, 10));
  if (!vac && m.dia >= 1 && m.dia <= 5 && m.hora >= '07:30') await unaVez('guiones-dia:' + m.fecha, () => guionesDelDia());
  if (!vac && m.dia === 1 && m.hora >= '09:15') await unaVez('contenido:' + m.fecha, async () => encargar('alex', await encargoContenido(m.fecha), { origen: 'sistema' }));
  if (!vac && m.dia === 2 && dm <= 7 && m.hora >= '09:15') await unaVez('boletin:' + m.fecha, () => encargar('alex',
    'Prepara el boletín de este mes (tipo \'boletin\', canal \'boletin\') para quien se ha apuntado en la web.', { origen: 'sistema' }));
  if (!vac && m.dia === 1 && m.hora >= '09:30') await unaVez('leo:' + m.fecha, () => encargar('leo',
    `Lunes: revisa resumen_origenes (si hay algo que decir, cuéntaselo a Dirección en 3–5 líneas con enviar_informe) y prepara la publicación de esta semana para la ficha de Google Business (tipo 'post', canal 'google').${dm <= 7 ? ' Esta semana toca también el artículo o la página del mes (tipo \'articulo\', canal \'web\').' : ''}`, { origen: 'sistema' }));
  await semanales(m, vac);
  if (m.dia === 3 && m.hora >= '10:00') await unaVez('marta:' + m.fecha, () => encargar('marta',
    'Revisión semanal de alianzas: añade hasta 5 gestorías o asesorías nuevas que encajen, actualiza la agenda de eventos de los próximos 3 meses y prepara el mensaje para Dirección de las 2 alianzas más prometedoras que aún no estén contactadas.', { origen: 'sistema' }));
  if (m.hora >= '09:00') await unaVez('eventos:' + m.fecha, async () => {
    const r = await q(`SELECT id, nombre, fecha::text AS fecha, estado FROM alianzas WHERE tipo='evento' AND estado IN ('apuntado','identificada') AND fecha IN ($1::date, $2::date)`, [sumar(m.fecha, 7), sumar(m.fecha, -1)]);
    for (const e of r.rows) {
      if (e.fecha === sumar(m.fecha, 7) && e.estado === 'apuntado') await encargar('marta', `Dentro de 7 días es «${e.nombre}» (${e.fecha}, alianza ${e.id}) y Dirección va. Prepárale la ficha: a quién ver (empresas de nuestra base de datos y asistentes públicos), qué decirle a cada uno en una frase y qué llevar. Envíasela con enviar_informe.`, { origen: 'sistema' });
      if (e.fecha === sumar(m.fecha, -1) && e.estado === 'apuntado') await encargar('marta', `Ayer fue «${e.nombre}» (alianza ${e.id}). Pregúntale a Dirección con enviar_informe con quién habló y qué quedó pendiente; marca el evento como 'asistido'.`, { origen: 'sistema' });
    }
  });
  // Posts programados: se publican a su hora (se mira en cada vuelta); y aviso antes de que caduque el permiso (dura 60 días)
  await aprobaciones.publicarProgramadas().catch(e => console.error('Publicar programadas:', e.message));
  await (await import('./presupuesto.js')).revisarPausa().catch(() => {});
  (await import('./vida.js')).emitirAnimo().catch(() => {});
  (await import('./agenda.js')).avisarRecordatorios().catch(e => console.error('Recordatorios:', e.message));
  if (m.hora >= '10:00') await unaVez('linkedin-aviso:' + m.fecha, async () => {
    const e = await linkedin.estado();
    if (e.conectado && [7, 3, 1, 0].includes(e.dias_restantes)) await telegram.avisar(`🔑 El permiso de LinkedIn caduca ${e.dias_restantes === 0 ? 'hoy' : `en ${e.dias_restantes} día${e.dias_restantes === 1 ? '' : 's'}`}. Entra en el panel (Tu mesa) y pulsa «Conectar LinkedIn»: es un clic.`);
  });
  if (!vac && m.dia >= 1 && m.dia <= 5) {
    if (m.hora >= '09:10') await unaVez('gerente-am:' + m.fecha, revisarGerencia);
    if (m.hora >= '16:00') await unaVez('gerente-pm:' + m.fecha, revisarGerencia);
  }
  // Flujo de trabajo: que nunca falte trabajo en la cadena (buscar → puntuar → dossier → primer contacto)
  const deOficina = m.dia >= 1 && m.dia <= 5 && m.hora >= '09:00' && m.hora < '19:30';
  if (!vac && (deOficina || (await topes()).turbo)) await flujo().catch(e => console.error('Flujo:', e.message));
  // Atascos: si un agente lleva horas parado esperando algo, se avisa a Dirección
  (await import('./atascos.js')).revisar().catch(e => console.error('Atascos:', e.message));
  if (!vac && m.dia >= 1 && m.dia <= 5 && m.hora >= '09:00') await unaVez('hoy:' + m.fecha, resumenDeHoy);
  // Llamadas del día: de lunes a viernes, Nuria prepara el guion de hasta 3 llamadas en caliente (empresas que ya nos conocen)
  if (!vac && m.dia >= 1 && m.dia <= 5 && m.hora >= '09:20') await unaVez('llamadas:' + m.fecha, llamadasDelDia);
  // Los viernes, Paula repasa cómo ha llamado Dirección esta semana
  if (!vac && m.dia === 5 && m.hora >= '17:00') await unaVez('repaso-llamadas:' + m.fecha, repasoLlamadas);
  // Licitaciones y peticiones públicas de proveedores: los martes, Sara busca contratos pequeños de lo que vende la empresa
  if (m.dia === 2 && m.hora >= '10:30') await unaVez('licitaciones:' + m.fecha, () => encargar('sara',
    'Busca licitaciones y contratos menores abiertos de lo que vende la empresa (mira la ficha «La empresa y su dueño») en su zona (ayuntamientos, diputación, universidades, empresas públicas): Plataforma de Contratación del Sector Público, perfiles del contratante y boletines. ' +
    'Solo las que estén abiertas y un autónomo pueda presentarse (importe, solvencia, plazo). Si hay alguna, cuéntasela a Dirección con enviar_informe: qué piden, importe, plazo y enlace. Si no hay ninguna que encaje, no envíes nada.', { origen: 'sistema' }));
  await reunionYCharlas(m, vac);
  // Premio del mes: el día 1 se entrega el del mes anterior
  if (dm === 1 && m.hora >= '09:05') await unaVez('premio:' + m.fecha, async () => {
    const g = await premios.entregar(premios.mesAnterior());
    if (!g) return;
    const nombre = AGENTES[g.agente]?.nombre ?? g.agente;
    const podio = g.podio.map((x, i) => `${['🥇', '🥈', '🥉'][i]} ${AGENTES[x.agente]?.nombre ?? x.agente}: ${x.puntos} puntos`).join('\n');
    await telegram.avisar(`🏆 Premio del mes: ${nombre}\n\n${podio}\n\nPuntos por trabajo aprobado, por tus «gracias» y, sobre todo, por contactos que avanzan (conversación, reunión, cliente).`);
    await log('rafa', T`entrega el premio del mes a ${nombre} (${g.puntos} puntos). ¡Enhorabuena!`);
    await emitir({ tipo: 'premio', agente: g.agente, mes: g.mes, puntos: g.puntos });
  });
}

/** Limpieza nocturna: lo que ya no sirve no se acumula. Nada de esto se enseña ni se consulta pasado ese tiempo. */
export async function mantenimiento() {
  const r = {};
  r.eventos = (await q(`DELETE FROM eventos WHERE ts < now() - interval '180 days'`)).rowCount;               // actividad del panel (se enseñan 40)
  r.busquedas = (await q(`DELETE FROM busquedas WHERE creada < now() - interval '30 days'`)).rowCount;        // caché de búsquedas (se usa 30 días)
  r.sesiones = (await q(`DELETE FROM sesiones WHERE expira < now()`)).rowCount;
  // Imágenes y vídeos (lo que más pesa) de tarjetas descartadas, sustituidas o superadas hace más de 60 días: ya no se van a publicar
  const viejas = `SELECT id FROM aprobaciones WHERE estado IN ('descartada','sustituida','superada','cambios') AND coalesce(resuelta, creada) < now() - interval '60 days'`;
  r.imagenes = (await q(`DELETE FROM imagenes WHERE aprobacion_id IN (${viejas})`)).rowCount;
  r.videos = (await q(`DELETE FROM videos WHERE aprobacion_id IN (${viejas})`)).rowCount;
  // Marcas de «esto ya se hizo ese día» (reunion:2026-10-27, analisis:…): solo hacen falta las recientes
  r.marcas = (await q(`DELETE FROM ajustes WHERE clave ~ '^[a-z-]+:[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND substring(clave from '[0-9]{4}-[0-9]{2}-[0-9]{2}$')::date < current_date - 30`)).rowCount;
  if (Object.values(r).some(Boolean)) console.log('Mantenimiento:', JSON.stringify(r));
  return r;
}

/** El primer día no tocan la reunión ni el trabajo semanal: todavía no hay nada de qué hablar. */
export async function saltarHoy() {
  const { fecha } = madrid();
  for (const k of ['reunion', 'informe', 'inteligencia', 'contenido', 'boletin', 'leo', 'marta', 'licitaciones', 'premio', ...departamentos.propios().map(d => `semanal-${d.id}`)]) await fijarAjuste(`${k}:${fecha}`, true);
}

let temporizador = null;
export function arrancar() {
  const seguro = () => empezada().then(ok => ok && tick()).catch(e => console.error('Planificador:', e.message));
  seguro();
  temporizador = setInterval(seguro, 30_000);
}
export const detener = () => clearInterval(temporizador);

/** Lo próximo que va a pasar en la oficina, para la pantalla de la pared. */
export async function agenda(limite = 6) {
  const ahora = new Date();
  const DIAS_TXT = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  const m = madrid(ahora);
  const proximo = (dias, hora) => {   // siguiente día de la semana (0–6) a esa hora, contando desde ahora
    for (let k = 0; k < 8; k++) {
      const d = new Date(ahora.getTime() + k * 86_400_000), md = madrid(d);
      if (dias.includes(md.dia) && (k > 0 || hora > m.hora)) return { fecha: md.fecha, dia: md.dia, k, hora };
    }
    return null;
  };
  const cuando = p => p.k === 0 ? `Hoy ${p.hora}` : p.k === 1 ? `Mañana ${p.hora}` : `${DIAS_TXT[p.dia]} ${p.hora}`;
  const items = [];
  // La búsqueda de Lucía no tiene día fijo: la lleva el objetivo de empresas o, sin él, la cola vacía
  const s = proximo([config.inteligenciaDia], config.inteligenciaHora);
  if (s) items.push({ orden: `${s.fecha} ${s.hora}`, cuando: cuando(s), texto: 'Informe de inteligencia de Sara' });
  const r = proximo([1], '08:45');
  if (r) items.push({ orden: `${r.fecha} ${r.hora}`, cuando: cuando(r), texto: 'Informe semanal de Máximo' });
  const pasos = await q(`SELECT p.titulo, p.fecha::text AS fecha, e.nombre FROM pasos p JOIN secuencias s ON s.id = p.secuencia_id JOIN empresas e ON e.id = s.empresa_id
                          WHERE p.estado = 'programado' AND s.estado = 'activa' ORDER BY p.fecha LIMIT 4`);
  const ctl = await q(`SELECT s.control, s.control_fecha::text AS fecha, e.nombre FROM secuencias s JOIN empresas e ON e.id = s.empresa_id
                        WHERE s.estado = 'activa' AND s.control_fecha IS NOT NULL ORDER BY s.control_fecha LIMIT 4`);
  const diaTxt = f => { const k = Math.round((new Date(f + 'T12:00:00Z') - new Date(m.fecha + 'T12:00:00Z')) / 86_400_000);
    return k <= 0 ? 'Hoy' : k === 1 ? 'Mañana' : DIAS_TXT[new Date(f + 'T12:00:00Z').getUTCDay()] + ' ' + f.slice(8, 10) + '/' + f.slice(5, 7); };
  const re = proximo([config.reunionDia], config.reunionHora);
  if (re) items.push({ orden: `${re.fecha} ${re.hora}`, cuando: cuando(re), texto: 'Reunión de equipo' });
  for (const e of await alianzas.proximosEventos(3)) items.push({ orden: `${e.fecha} 09:00`, cuando: diaTxt(e.fecha), texto: `Evento: ${e.nombre}` });
  const al = proximo([1], '09:15');
  if (al) items.push({ orden: `${al.fecha} ${al.hora}`, cuando: cuando(al), texto: 'Álex prepara el contenido de la semana' });
  const ma = proximo([3], '10:00');
  if (ma) items.push({ orden: `${ma.fecha} ${ma.hora}`, cuando: cuando(ma), texto: 'Marta revisa alianzas y eventos' });
  for (const p of pasos.rows) items.push({ orden: `${p.fecha} 09:00`, cuando: diaTxt(p.fecha), texto: `${p.titulo} a ${p.nombre.replace(/\s*\(.*$/, '')}` });
  for (const c of ctl.rows) items.push({ orden: `${c.fecha} 09:00`, cuando: diaTxt(c.fecha), texto: c.control === 'aceptacion' ? `¿Ha aceptado ${c.nombre.replace(/\s*\(.*$/, '')}?` : String(c.control).startsWith('redactar:') ? `Javi prepara el seguimiento: ${c.nombre.replace(/\s*\(.*$/, '')}` : `Sin respuesta: ${c.nombre.replace(/\s*\(.*$/, '')}` });
  const fuera = departamentos.agentesApagados().map(id => AGENTES[id].nombre);
  return items.filter(i => !fuera.some(n => i.texto.includes(n))).sort((a, b) => a.orden.localeCompare(b.orden)).slice(0, limite).map(({ cuando, texto }) => ({ cuando, texto }));
}
