// Objetivos: Dirección plantea un objetivo («10 reuniones con gestorías de Getafe este mes»), Máximo lo convierte en un plan
// de pasos para el equipo (quién hace qué y en qué orden, con su coste estimado), Dirección lo aprueba en la mesa y el equipo
// lo ejecuta paso a paso: cada paso arranca cuando terminan los que necesita y recibe lo que hicieron. Al final Máximo resume.
// Nada sale hacia fuera sin pasar por la mesa, como siempre.
import { q } from './db.js';
import { emitir, log } from './bus.js';
import { config } from './config.js';
import { AGENTES, IDS } from './agentes.js';
import * as departamentos from './departamentos.js';
import * as tareas from './tareas.js';
import * as presupuesto from './presupuesto.js';

const recortar = (s, n) => (String(s || '').length > n ? String(s).slice(0, n - 1) + '…' : String(s || ''));
const nombre = id => AGENTES[id]?.nombre || id;
const chat = () => import('./chat.js');

async function leer(id) { return (await q(`SELECT * FROM objetivos WHERE id=$1`, [id])).rows[0] || null; }
async function gastado(id) {
  return Math.round(Number((await q(`SELECT coalesce(sum(g.usd),0)::float AS usd FROM gasto g JOIN tareas t ON t.id=g.tarea_id WHERE t.objetivo_id=$1`, [id])).rows[0].usd) * config.usdEur * 1000) / 1000;
}
async function avisarCambio(id) { const o = await detalle(id).catch(() => null); if (o) await emitir({ tipo: 'objetivo', objetivo: o }); }

/** Dirección plantea un objetivo: Máximo prepara el plan. */
export async function crear(texto, { via = 'panel' } = {}) {
  texto = recortar(String(texto || '').trim(), 1500);
  if (texto.length < 8) throw new Error('Cuéntale a Máximo el objetivo en una frase (qué quieres conseguir y para cuándo).');
  const o = (await q(`INSERT INTO objetivos (texto) VALUES ($1) RETURNING *`, [texto])).rows[0];
  await (await chat()).escribir({ canal: 'general', autor: 'dueno', para: 'rafa', texto: `🎯 Objetivo: ${texto}`, via });
  await tareas.crear('rafa', `Dirección plantea un OBJETIVO (nº ${o.id}): «${texto}»

Prepara el plan para conseguirlo con el equipo y entrégaselo con proponer_plan (objetivo_id ${o.id}):
- Entre 2 y 8 pasos concretos. Cada uno para el compañero adecuado (su id), con una instrucción completa: qué, cuánto, con qué criterio y qué debe entregar.
- En depende_de, los números de los pasos que tienen que terminar antes (si no depende de ninguno, déjalo vacío: arranca en cuanto Dirección apruebe).
- Mira antes lo que ya tenemos (resumen_embudo, listar_empresas) para no repetir trabajo.
- Nadie contacta a nadie por su cuenta: lo que salga hacia fuera pasa por la mesa de Dirección, como siempre.
- Di cómo sabremos que se ha conseguido (medida).
- Si el objetivo no está claro del todo, propón el plan más razonable y di en el resumen qué has supuesto.
No uses enviar_informe: el plan le llega a Dirección a su mesa y al chat.`, { origen: 'dueno', objetivo_id: o.id });
  await log('dueno', `plantea un objetivo: «${recortar(texto, 140)}». Máximo prepara el plan.`);
  await avisarCambio(o.id);
  return detalle(o.id);
}

/** Máximo entrega el plan (herramienta proponer_plan): va a la mesa de Dirección con el coste estimado de cada paso. */
export async function proponer({ objetivo_id, resumen, medida, pasos }) {
  const o = await leer(Number(objetivo_id));
  if (!o) throw new Error(`No existe el objetivo ${objetivo_id}.`);
  if (['en_marcha', 'hecho', 'descartado', 'detenido'].includes(o.estado)) throw new Error(`El objetivo ${o.id} ya está ${o.estado.replace('_', ' ')}.`);
  if (!Array.isArray(pasos) || pasos.length < 1 || pasos.length > 10) throw new Error('El plan necesita entre 1 y 10 pasos.');
  const plan = [];
  for (const [i, p] of pasos.entries()) {
    const equipo = IDS.filter(departamentos.trabaja);
    if (!equipo.includes(p.agente)) throw new Error(`Paso ${i + 1}: «${p.agente}» no es nadie del equipo. Usa uno de: ${equipo.join(', ')}.`);
    if (!String(p.instruccion || '').trim()) throw new Error(`Paso ${i + 1}: falta la instrucción.`);
    const dep = [...new Set((p.depende_de || []).map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= i))].map(n => n - 1);
    const est = await presupuesto.costeTipico(p.agente, 'trabajo');
    plan.push({ agente: p.agente, instruccion: recortar(String(p.instruccion).trim(), 1500), depende: dep, estado: 'pendiente', est_eur: est.eur });
  }
  const total = Math.round(plan.reduce((s, p) => s + (p.est_eur || 0), 0) * 100) / 100;
  await q(`UPDATE objetivos SET plan=$2, resumen=$3, medida=$4, estimado_eur=$5, estado='propuesto' WHERE id=$1`,
    [o.id, JSON.stringify(plan), recortar(resumen, 1500), recortar(medida, 500), total]);
  const md = [`**Objetivo:** ${o.texto}`, '', resumen ? String(resumen) : '', '',
    ...plan.map((p, i) => `${i + 1}. **${nombre(p.agente)}** — ${p.instruccion}${p.depende.length ? ` _(cuando termine${p.depende.length > 1 ? 'n' : ''} el paso ${p.depende.map(d => d + 1).join(' y ')})_` : ''}${p.est_eur != null ? ` · ≈ ${p.est_eur.toFixed(2).replace('.', ',')} €` : ''}`),
    '', medida ? `**Cómo sabremos que se ha conseguido:** ${medida}` : '', '', `**Coste estimado del plan:** ≈ ${total.toFixed(2).replace('.', ',')} € de IA (lo que suele costar cada paso).`].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
  const aprobaciones = await import('./aprobaciones.js');
  // Si había un plan anterior (Dirección pidió cambios), su tarjeta ya no vale
  await aprobaciones.sustituir(`plan:${o.id}`);
  const apId = await aprobaciones.crear({ agente: 'rafa', tipo: 'otro', titulo: `propone un plan para «${recortar(o.texto, 70)}»: ${plan.length} pasos, ≈ ${total.toFixed(2).replace('.', ',')} €`, texto: md,
    ref: `plan:${o.id}`, importancia: 'alta', motivo: 'Plan para un objetivo tuyo',
    opciones: [{ r: 'aprobada', t: '✅ Adelante con el plan' }, { r: 'cambios', t: '✏️ Pedir cambios' }, { r: 'descartada', t: '🗑 Descartar' }] });
  await q(`UPDATE objetivos SET aprobacion_id=$2 WHERE id=$1`, [o.id, apId]);
  await (await chat()).escribir({ canal: 'general', autor: 'rafa', para: 'dueno', texto: `He preparado el plan para «${recortar(o.texto, 120)}»: ${plan.length} pasos (${[...new Set(plan.map(p => nombre(p.agente)))].join(', ')}), ≈ ${total.toFixed(2).replace('.', ',')} € de IA. Lo tienes en tu mesa: si te vale, dale a «Adelante» y arrancamos.` });
  await avisarCambio(o.id);
  return { ok: true, aprobacion: apId, pasos: plan.length, estimado_eur: total };
}

/** Lo que Dirección decide en la mesa sobre el plan. */
export async function alResolver(id, resultado) {
  if (resultado === 'aprobada') return lanzar(id);
  if (resultado === 'descartada') {
    await q(`UPDATE objetivos SET estado='descartado', terminado=now() WHERE id=$1`, [id]);
    await (await chat()).escribir({ canal: 'general', autor: 'rafa', para: 'dueno', texto: 'Entendido, aparcamos ese objetivo. Si quieres retomarlo, plantéamelo de nuevo.' });
    await avisarCambio(id);
  }
}

function contextoPrevio(o, i) {
  const previos = o.plan[i].depende.map(d => ({ n: d + 1, p: o.plan[d] })).filter(x => x.p.resultado);
  return previos.length ? `\n\nLo que ya han hecho tus compañeros en los pasos anteriores:\n${previos.map(x => `- Paso ${x.n} (${nombre(x.p.agente)}): ${recortar(x.p.resultado, 700)}`).join('\n')}` : '';
}
async function arrancarPaso(o, i) {
  const p = o.plan[i];
  const t = await tareas.crear(p.agente, `${p.instruccion}\n\n(Paso ${i + 1} de ${o.plan.length} del objetivo «${recortar(o.texto, 200)}» que coordina Máximo. Al terminar, resume en 2–4 frases qué has hecho y qué has dejado en la mesa de Dirección, si algo.)${contextoPrevio(o, i)}`,
    { origen: 'rafa', objetivo_id: o.id, paso: i });
  p.estado = 'en_curso'; p.tarea_id = t.id;
}
async function guardarPlan(o) { await q(`UPDATE objetivos SET plan=$2 WHERE id=$1`, [o.id, JSON.stringify(o.plan)]); }

/** Dirección aprueba: arrancan los pasos que no esperan a nadie. */
export async function lanzar(id) {
  const o = await leer(id);
  if (!o || !Array.isArray(o.plan) || o.estado === 'en_marcha') return;
  await q(`UPDATE objetivos SET estado='en_marcha', aprobado=now() WHERE id=$1`, [id]);
  o.estado = 'en_marcha';
  const iniciales = o.plan.map((p, i) => i).filter(i => !o.plan[i].depende.length);
  for (const i of iniciales) await arrancarPaso(o, i);
  await guardarPlan(o);
  await (await chat()).escribir({ canal: 'general', autor: 'rafa', texto: `🎯 ¡Arrancamos con «${recortar(o.texto, 120)}»! Empiezan ${iniciales.map(i => nombre(o.plan[i].agente)).join(' y ')}; el resto, en cuanto les toque. Os lo dejo en #trabajo paso a paso.` });
  await log('rafa', `arranca el plan del objetivo «${recortar(o.texto, 100)}» (${o.plan.length} pasos).`);
  await avisarCambio(id);
}

/** Un paso ha terminado (o ha fallado del todo): arrancan los que esperaban por él; si era el último, Máximo resume. */
export async function pasoTerminado(t, resultado, { error = false } = {}) {
  if (!t.objetivo_id || t.paso == null) return;
  const o = await leer(t.objetivo_id);
  if (!o || o.estado !== 'en_marcha' || !o.plan?.[t.paso]) return;
  const p = o.plan[t.paso];
  if (['hecho', 'error'].includes(p.estado)) return;
  p.estado = error ? 'error' : 'hecho'; p.resultado = recortar(resultado || (error ? 'No se pudo completar.' : 'Hecho.'), 1200);
  if (error) await (await chat()).escribir({ canal: 'general', autor: 'sistema', texto: `El paso ${t.paso + 1} del objetivo «${recortar(o.texto, 80)}» (${nombre(p.agente)}) no se ha podido completar: ${recortar(resultado, 160)}. El plan sigue con lo demás.` });
  const fin = s => ['hecho', 'error', 'cancelado'].includes(s);
  for (const [i, q2] of o.plan.entries()) if (q2.estado === 'pendiente' && q2.depende.every(d => fin(o.plan[d].estado))) await arrancarPaso(o, i);
  await guardarPlan(o);
  if (o.plan.every(x => fin(x.estado))) await cerrar(o);
  await avisarCambio(o.id);
}

async function cerrar(o) {
  await q(`UPDATE objetivos SET estado='hecho', terminado=now() WHERE id=$1`, [o.id]);
  const eur = await gastado(o.id);
  await tareas.crear('rafa', `El plan del objetivo «${o.texto}» ha terminado. Esto es lo que ha hecho cada uno:
${o.plan.map((p, i) => `${i + 1}. ${nombre(p.agente)} (${p.estado}): ${recortar(p.resultado, 600)}`).join('\n')}
${o.medida ? `\nCómo íbamos a medirlo: ${o.medida}` : ''}
Coste real en IA: ${eur.toFixed(2)} € (estimado: ${Number(o.estimado_eur || 0).toFixed(2)} €).

Escríbele a Dirección en #general un resumen corto (4–6 frases): qué se ha conseguido, qué tiene pendiente en su mesa para que esto avance y el siguiente paso que recomiendas. Sin enviar_informe.`, { origen: 'sistema', canal: 'general', objetivo_id: o.id });
  try { await (await import('./telegram.js')).avisar(`🎯 Terminado el plan de «${recortar(o.texto, 100)}». Máximo te deja el resumen en el chat (#general). Coste: ${eur.toFixed(2)} €.`); } catch { }
}

/** Dirección lo para: lo que no ha empezado se cancela (lo que ya está en marcha termina). */
export async function detener(id) {
  const o = await leer(id);
  if (!o) throw new Error('No existe ese objetivo.');
  if (['hecho', 'descartado', 'detenido'].includes(o.estado)) return detalle(id);
  for (const p of o.plan || []) if (p.estado === 'pendiente') p.estado = 'cancelado';
  await q(`UPDATE tareas SET estado='error', resultado='Cancelada: Dirección ha detenido el objetivo', terminada=now() WHERE objetivo_id=$1 AND estado='pendiente'`, [id]);
  await q(`UPDATE objetivos SET estado='detenido', plan=$2, terminado=now() WHERE id=$1`, [id, JSON.stringify(o.plan || null)]);
  await (await import('./aprobaciones.js')).sustituir(`plan:${id}`);
  await (await chat()).escribir({ canal: 'general', autor: 'rafa', texto: `Paramos el objetivo «${recortar(o.texto, 120)}». Lo que ya estaba en marcha termina; lo demás queda cancelado.` });
  await avisarCambio(id);
  return detalle(id);
}

export async function detalle(id) {
  const o = await leer(id);
  if (!o) return null;
  const plan = (o.plan || []).map((p, i) => ({ ...p, n: i + 1, nombre: nombre(p.agente) }));
  return { ...o, plan, hechos: plan.filter(p => p.estado === 'hecho').length, total: plan.length, gastado_eur: await gastado(id) };
}
export async function listar() {
  const r = await q(`SELECT id FROM objetivos ORDER BY CASE estado WHEN 'en_marcha' THEN 0 WHEN 'propuesto' THEN 1 WHEN 'planificando' THEN 2 ELSE 3 END, id DESC LIMIT 30`);
  const out = [];
  for (const x of r.rows) out.push(await detalle(x.id));
  return out;
}
