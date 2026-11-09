// Motor: reparte tareas a los agentes y ejecuta cada una con la API de Claude.
import { config } from './config.js';
import { q, ajuste, fijarAjuste } from './db.js';
import { emitir, estado, log, guardarInforme, panelAbierto } from './bus.js';
import { AGENTES, promptSistema } from './agentes.js';
import * as vida from './vida.js';
import * as herramientas from './herramientas.js';
import * as tareas from './tareas.js';
import * as departamentos from './departamentos.js';
import * as empresas from './empresas.js';
import * as presupuesto from './presupuesto.js';
import * as telegram from './telegram.js';
import * as aprendizajes from './aprendizajes.js';
import * as memoria from './memoria.js';
import { llamar, hayCredito } from './llm.js';
import * as ausencia from './ausencia.js';
import * as chat from './chat.js';
import * as oficina from './oficina.js';
import { T } from './en.js';

export class Pausado extends Error {}
const ocupados = new Set();
let enCiclo = false;
let temporizador = null;

export const estaPausado = async () => Boolean(await ajuste('pausado', config.pausadoInicial));

export async function pausar(motivo = T('Pausa manual'), { porCredito = false } = {}) {
  if (porCredito) { motivo += T(' El equipo sigue solo en cuanto vuelva.'); ultimaPrueba = Date.now(); }
  await fijarAjuste('pausado', true);
  await fijarAjuste('pausa_motivo', motivo);
  await fijarAjuste('pausa_credito', porCredito);
  await emitir({ tipo: 'pausa', pausado: true, motivo });
  await log('sistema', T`ha pausado el equipo: ${motivo}`);
  await telegram.avisar(`⏸ Equipo pausado: ${motivo}${porCredito ? '' : '\nEscribe /reanudar para seguir.'}`);
}
export async function reanudar() {
  await fijarAjuste('pausado', false);
  await emitir({ tipo: 'pausa', pausado: false });
  await log('sistema', T('ha reanudado el trabajo del equipo.'));
}

// Parado por falta de crédito: se prueba cada 15 minutos si ha vuelto y, si es así, sigue solo
const PROBAR_CREDITO_MS = 15 * 60_000;
let ultimaPrueba = 0;
export const _olvidarPrueba = () => { ultimaPrueba = 0; };   // pruebas: «ya toca» volver a probar
export async function revisarCredito() {
  const parado = async () => (await estaPausado()) && Boolean(await ajuste('pausa_credito', false));
  if (Date.now() - ultimaPrueba < PROBAR_CREDITO_MS || !(await parado())) return false;
  ultimaPrueba = Date.now();
  if (!(await hayCredito()) || !(await parado())) return false;   // Dirección ha podido pausarlo a mano mientras tanto
  await reanudar();
  await telegram.avisar('▶️ Ha vuelto el crédito de IA: el equipo sigue trabajando.');
  return true;
}

export function arrancar(intervaloMs = 3000) {
  temporizador = setInterval(ciclo, intervaloMs);
  ciclo();
}
export const detener = () => clearInterval(temporizador);

async function ciclo() {
  if (enCiclo) return;
  enCiclo = true;
  try {
    if (await estaPausado()) return;
    const frenados = await ausencia.frenados();
    await marcarEsperando(frenados);
    const turbo = (await presupuesto.ajustes().catch(() => ({}))).turbo;
    while (ocupados.size < config.concurrencia + (turbo ? 2 : 0)) {
      const t = await tareas.siguiente([...ocupados, ...departamentos.agentesApagados(), ...(await departamentos.agotados())], frenados);
      if (!t) break;
      ocupados.add(t.agente);
      ejecutar(t).catch(e => console.error('Error no controlado', e)).finally(() => ocupados.delete(t.agente));
    }
  } catch (e) {
    console.error('Ciclo del motor:', e.message);
  } finally { enCiclo = false; }
}

// Los redactores frenados lo dicen en la oficina (una vez por cambio, sin ruido)
let frenoAnterior = '';
async function marcarEsperando(frenados) {
  const clave = frenados.join(',');
  if (clave === frenoAnterior) return;
  frenoAnterior = clave;
  const e = await ausencia.estado();
  await emitir({ tipo: 'ausencia', ...e });   // el panel muestra «mesa llena» o lo quita
  if (!frenados.length) return;
  for (const id of frenados) {
    if (ocupados.has(id)) continue;
    const n = (await q(`SELECT count(*)::int n FROM tareas WHERE agente=$1 AND estado='pendiente'`, [id])).rows[0].n;
    if (n) await estado(id, 'inactivo', e.vacaciones ? `Dirección está de vacaciones: ${n} trabajo${n === 1 ? '' : 's'} esperando` : `Tu mesa está llena: ${n} trabajo${n === 1 ? '' : 's'} esperando`, 'zz');
  }
}

const recortar = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const hostDe = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return 'una web'; } };

async function contexto(t) {
  const hoy = new Intl.DateTimeFormat('es-ES', { timeZone: config.zona, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date());
  const quien = AGENTES[t.origen]?.nombre || (t.origen === 'dueno' ? 'Dirección' : 'el sistema');
  let txt = t.tipo === 'pregunta'
    ? `Hoy es ${hoy}.\nDirección te pregunta directamente:\n«${t.instruccion}»\n\nContéstale tú, en primera persona y en 2–6 frases, con tu opinión sincera y concreta. Puedes consultar la base de datos o buscar si lo necesitas. Si no estás de acuerdo con lo que propone, díselo. No uses pedir_aprobacion ni anotar: tu respuesta final es lo que le llega.`
    : `Hoy es ${hoy}.\nTarea nº ${t.id}, encargada por ${quien}:\n${t.instruccion}`;
  // Si viene del chat (o es una pregunta directa), lo que llevabais hablado, para seguir el hilo
  const canal = t.canal || (t.tipo === 'pregunta' ? t.agente : null);
  if (canal) { const hilo = await chat.contexto(canal, t.creada).catch(() => ''); if (hilo) txt += `\n\n${hilo}`; }
  if (t.empresa_id) {
    const e = await empresas.leer(t.empresa_id);
    if (e) {
      const ficha = Object.fromEntries(Object.entries(e).filter(([k, v]) => v != null && !['nombre_norm', 'creada', 'actualizada', 'etapa_max'].includes(k)));
      txt += `\n\nFicha actual de la empresa (id ${e.id}):\n${paraAgente(ficha, 2)}`;
      const personas = await (await import('./contactos.js')).lineaTelefonos(e.id);
      if (personas) txt += `\n\nA quién se puede llamar en esta empresa: ${personas}`;
      // Lo último con ella, para no hablarle a Dirección de memoria
      const { llamadas } = (await empresas.expediente(e.id)).historial;
      if (llamadas.length) txt += `\n\nÚltimas llamadas con esta empresa:\n${paraAgente(llamadas, 1)}`;
      const mesa = (await q(`SELECT id, agente, titulo, to_char(creada AT TIME ZONE 'Europe/Madrid', 'DD/MM HH24:MI') AS desde FROM aprobaciones WHERE empresa_id=$1 AND estado='pendiente' ORDER BY creada DESC LIMIT 6`, [e.id])).rows;
      if (mesa.length) txt += `\n\nEn la mesa de Dirección sobre esta empresa:\n${mesa.map(a => `- ${a.id}: ${a.agente} ${a.titulo} (${a.desde})`).join('\n')}`;
    }
  }
  return txt;
}

/** Lo que se le pasa a un agente en JSON, con las fechas en hora de Madrid: en UTC diría las 9:57 de una llamada de las 10:57. */
export const paraAgente = (v, sangria) => JSON.stringify(v, function (k, x) {
  return this[k] instanceof Date ? new Intl.DateTimeFormat('sv-SE', { timeZone: config.zona, dateStyle: 'short', timeStyle: 'short' }).format(this[k]) : x;
}, sangria);

const esErrorDefinitivo = e => [400, 401, 402, 403, 404, 413, 422].includes(e?.status);
const leerArgs = t => { try { return JSON.parse(t || '{}'); } catch { return null; } };

export async function ejecutar(t) {
  const a = AGENTES[t.agente];
  if (!a) return void await tareas.fallar(t, 'Quien la tenía ya no está en la oficina.', { reintentar: false });   // se borró su departamento con la tarea a medias y luego se reinició
  const modelo = config.modelos[t.agente];
  const ctx = { agente: t.agente, tarea: t, anotado: false, esperando: false, efectos: false, encargos: 0,
    web: { busquedas: a.web?.busquedas ?? 0, lecturas: a.web?.lecturas ?? 0 } };   // topes por TAREA
  const titulo = recortar(t.instruccion.split('\n')[0], 90);
  await estado(t.agente, 'trabajando', titulo, a.icono);
  let final = '';

  try {
    // Instrucciones: la parte fija se cachea (los modelos de Anthropic lo aprovechan, directamente o vía OpenRouter)
    const system = [{ type: 'text', text: promptSistema(t.agente), cache_control: { type: 'ephemeral' } }];
    const personaje = vida.paraAgente(t.agente);
    if (personaje) system.push({ type: 'text', text: personaje });
    const adaptado = await aprendizajes.paraPrompt(t.agente);
    if (adaptado) system.push({ type: 'text', text: adaptado });
    const recuerdos = await memoria.paraPrompt(t.agente);
    if (recuerdos) system.push({ type: 'text', text: recuerdos });
    const pizarra = await oficina.pizarra();
    if (pizarra) system.push({ type: 'text', text: pizarra });
    // Segundo punto de caché al final de las instrucciones (personaje, aprendizajes y memoria no cambian durante la tarea)
    if (system.length > 1) system[system.length - 1] = { ...system[system.length - 1], cache_control: { type: 'ephemeral' } };
    const tools = herramientas.paraAgente(t.agente);
    const messages = [{ role: 'user', content: await contexto(t) }];

    for (let turno = 0; turno < config.maxTurnos; turno++) {
      if (await estaPausado()) throw new Pausado('El equipo se ha pausado');
      if (await presupuesto.comprobar()) {
        const g = await presupuesto.gastoMes();
        await telegram.avisar(`⚠️ Llevas ${g.eur.toFixed(2)} € de ${g.limite} € de IA ${g.periodo === 'semana' ? 'esta semana' : 'este mes'} (80 %). Puedes darle un empujón desde el panel (clic en «IA: …») o con /empujon 10.`);
      }
      const r = await llamar({ modelo, system, messages: conCache(messages), tools });
      await presupuesto.registrar(t.agente, t.id, modelo, r.coste, r.uso);
      await emitir({ tipo: 'gasto', ...(await presupuesto.gastoMes()) });

      const m = r.mensaje;
      const llamadas = (m.tool_calls || []).filter(c => c.type === 'function' || c.function);
      messages.push({ role: 'assistant', content: m.content ?? '', ...(llamadas.length ? { tool_calls: llamadas } : {}) });
      if (m.content?.trim()) final = m.content.trim();
      if (!llamadas.length) break;

      for (const c of llamadas) {
        const nombre = c.function?.name, args = leerArgs(c.function?.arguments);
        if (nombre === 'buscar_web') await estado(t.agente, 'trabajando', `Buscando «${recortar(args?.consulta || '', 60)}»`);
        if (nombre === 'leer_web') await estado(t.agente, 'trabajando', `Leyendo ${hostDe(args?.url)}`);
        if (nombre === 'consultar_borme') await estado(t.agente, 'trabajando', 'Mirando el Registro Mercantil');
        if (nombre === 'buscar_maps') await estado(t.agente, 'trabajando', `Buscando en Google Maps «${recortar(args?.consulta || '', 50)}»`);
        let contenido;
        if (!args) contenido = JSON.stringify({ error: 'Los argumentos no son JSON válido. Vuelve a intentarlo.' });
        else {
          try { contenido = paraAgente((await herramientas.ejecutar(ctx, nombre, args)) ?? { ok: true }); }
          catch (e) {
            if (e instanceof presupuesto.PresupuestoAgotado || e?.sinCredito) throw e;
            console.warn(`Herramienta ${nombre} (${t.agente}, tarea ${t.id}):`, String(e.message || e).slice(0, 200));   // si no, el error solo lo ve el modelo
            contenido = JSON.stringify({ error: String(e.message || e) });
          }
        }
        messages.push({ role: 'tool', tool_call_id: c.id, content: recortar(contenido, 20000) });
      }
      if (turno === config.maxTurnos - 1) final += ' (cortado por el límite de turnos)';
    }

    await reglasDespues(t);
    if (t.tipo === 'pregunta') {
      await emitir({ tipo: 'opinion', agente: t.agente, pregunta: t.instruccion, texto: final });
      const informe_id = await guardarInforme({ agente: t.agente, tipo: 'opinion', titulo: `Pregunta de Dirección: ${recortar(t.instruccion, 110)}`, texto: final, empresa_id: t.empresa_id });
      await log(t.agente, T`responde: «${recortar(final, 280)}»`, { informe_id, empresa_id: t.empresa_id });
      await chat.escribir({ canal: t.canal || t.agente, autor: t.agente, para: 'dueno', texto: final || 'No sé qué decirte con lo que tengo. ¿Me lo concretas?', tarea_id: t.id, informe_id, empresa_id: t.empresa_id }).catch(e => console.error('Chat:', e.message));
      // Si se lo preguntaste en el chat del panel y lo tienes abierto, la respuesta ya la estás viendo
      if (!t.canal || !panelAbierto()) await telegram.avisar(`💬 ${a.nombre}: ${final}`);
    } else {
      let informe_id = null;
      if (!ctx.esperando && final) {
        // Aunque haya dejado una línea con anotar, el texto entero se guarda: si no, de un trabajo solo queda el resumen
        informe_id = final.length > 280 ? await guardarInforme({ agente: t.agente, tipo: 'resumen', titulo: recortar(t.instruccion, 110), texto: final, empresa_id: t.empresa_id }) : null;
        if (!ctx.anotado) await log(t.agente, T`informa: «${recortar(final, 280)}»`, { informe_id, empresa_id: t.empresa_id });
        else if (informe_id) await log(t.agente, T('ha dejado el texto completo de lo anterior.'), { informe_id, empresa_id: t.empresa_id });
      }
      // Lo que te contesta en el chat, o lo que le devuelve al compañero que se lo encargó (en #trabajo)
      if (t.canal) await chat.escribir({ canal: t.canal, autor: t.agente, para: 'dueno', texto: final || 'Hecho.', tarea_id: t.id, informe_id, empresa_id: t.empresa_id }).catch(e => console.error('Chat:', e.message));
      else if (AGENTES[t.origen] && t.origen !== t.agente && final) await chat.escribir({ canal: 'trabajo', autor: t.agente, para: t.origen, texto: final, tarea_id: t.id, informe_id, empresa_id: t.empresa_id }).catch(e => console.error('Chat:', e.message));
    }
    await tareas.terminar(t.id, final);
    // Lo que le encargas sobre una empresa te lo dice al acabar: no hay que ir a buscarlo
    if (t.origen === 'dueno' && t.empresa_id && !t.canal && !ctx.esperando) await emitir({ tipo: 'encargo_hecho', tarea: t.id, agente: t.agente, empresa_id: t.empresa_id, texto: recortar(final || 'Hecho.', 240) });
    if (t.objetivo_id != null && t.paso != null) (await import('./objetivos.js')).pasoTerminado(t, final).catch(e => console.error('Objetivo:', e.message));
    if (ctx.atascado) await (await import('./atascos.js')).marcar(t.agente);
    else if (ctx.esperando) await estado(t.agente, 'inactivo', 'Esperando trabajo', 'zz');   // un solo canal: lo que te toca está en tu mesa, ningún agente te reclama por su cuenta
    else await estado(t.agente, 'inactivo', 'Esperando trabajo', 'zz');
  } catch (e) {
    const msg = String(e?.message || e);
    const sinCredito = Boolean(e?.sinCredito);   // se acabó el crédito de la API (Claude u OpenRouter)
    const interrumpida = e instanceof presupuesto.PresupuestoAgotado || e instanceof Pausado || sinCredito;
    if (interrumpida && !ctx.efectos) {
      // No había hecho nada todavía: vuelve a la cola y se retoma al reanudar
      await q(`UPDATE tareas SET estado='pendiente', intentos=greatest(intentos-1,0) WHERE id=$1`, [t.id]);
      await estado(t.agente, 'inactivo', e instanceof Pausado ? 'En pausa' : sinCredito ? 'Pausado: sin crédito de IA' : 'Pausado: presupuesto del mes agotado', 'zz');
      if (e instanceof presupuesto.PresupuestoAgotado) await pausar(msg);
      if (sinCredito && !(await estaPausado())) await pausar(msg, { porCredito: true });
      return;
    }
    console.error(`Tarea ${t.id} (${t.agente}):`, msg);
    // Si ya escribió algo, o el error no se arregla repitiendo, no se reintenta (evita duplicados y gasto)
    const r = await tareas.fallar(t, msg, { reintentar: !ctx.efectos && !esErrorDefinitivo(e) && !interrumpida });
    if (e instanceof presupuesto.PresupuestoAgotado) await pausar(msg);
    if (sinCredito && !(await estaPausado())) await pausar(msg, { porCredito: true });
    if (r === 'error') {
      const porque = ctx.efectos ? T('Se quedó a medias después de guardar cambios; revísalo antes de volver a encargarlo') : T('No se reintenta');
      await estado(t.agente, 'error', `No he podido terminar: ${recortar(msg, 70)}`, 'excl');
      await log('sistema', T`${a.nombre} no ha podido terminar «${titulo}»: ${recortar(msg, 160)}. ${porque}.`);
      if (t.objetivo_id != null && t.paso != null) (await import('./objetivos.js')).pasoTerminado(t, msg, { error: true }).catch(e => console.error('Objetivo:', e.message));
      if (t.canal || t.tipo === 'pregunta') await chat.escribir({ canal: t.canal || t.agente, autor: 'sistema', para: 'dueno', texto: `${a.nombre} no ha podido contestar (${recortar(msg, 120)}). Vuelve a escribírselo en un rato.`, tarea_id: t.id }).catch(() => {});
      await telegram.avisar(`❗ ${a.nombre} no ha podido terminar «${titulo}»: ${recortar(msg, 300)}\n${porque}.`);
    } else {
      await estado(t.agente, 'inactivo', 'Ha fallado; lo reintenta en 5 minutos', 'zz');
    }
  }
}

/** Traspasos automáticos del embudo: Mateo → Carmen → Javi. */
async function reglasDespues(t) {
  if (!t.empresa_id) return;
  const e = await empresas.leer(t.empresa_id);
  if (!e) return;
  if (t.agente === 'mateo' && e.estado === 'puntuada' && ['A', 'B'].includes(e.categoria) && !e.dossier && !(await tareas.pendientesDe('carmen', e.id))) {
    await tareas.crear('carmen', `Prepara el dossier de ${e.nombre} (id ${e.id}): categoría ${e.categoria}, ${e.puntuacion ?? '¿?'}/100.`, { empresa_id: e.id, origen: 'mateo' });
  }
  if (t.agente === 'carmen' && departamentos.trabaja('javi') && e.dossier && e.estado === 'dossier' && !(await tareas.pendientesDe('javi', e.id))) {
    const ya = await q(`SELECT 1 FROM aprobaciones WHERE empresa_id=$1 AND tipo='mensaje' AND estado='pendiente'
                        UNION SELECT 1 FROM secuencias WHERE empresa_id=$1 AND estado IN ('borrador','activa','respondida','aparcada')`, [e.id]);
    if (!ya.rows.length) await tareas.crear('javi', `Prepara el primer contacto con ${e.nombre} (id ${e.id}).`, { empresa_id: e.id, origen: 'carmen' });
  }
}

/** Marca el último mensaje para la caché: en cada vuelta de la tarea, todo lo anterior se cobra a ~10 % del precio. */
function conCache(messages) {
  const out = messages.slice();
  const i = out.length - 1, m = out[i];
  if (!m || !['user', 'tool'].includes(m.role)) return out;
  const texto = typeof m.content === 'string' ? m.content : null;
  if (texto === null || texto.length < 200) return out;
  out[i] = { ...m, content: [{ type: 'text', text: texto, cache_control: { type: 'ephemeral' } }] };
  return out;
}

