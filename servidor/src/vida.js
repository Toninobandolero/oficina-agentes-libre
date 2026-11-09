// Módulo «Vida de oficina»: personajes con su vida, su forma de ser y charlas entre ellos.
// Se puede apagar: entonces los agentes solo trabajan y el panel no simula nada personal.
import { ajuste, fijarAjuste, q } from './db.js';
import { AGENTES, IDS } from './agentes.js';
import * as departamentos from './departamentos.js';
import { config } from './config.js';
import * as miEmpresa from './empresa.js';
import { emitir, log } from './bus.js';
import { llamar } from './llm.js';
import { idiomaEquipo } from './perfil.js';
import * as presupuesto from './presupuesto.js';
import { PERSONAJES, paraPrompt, eventosDeHoy } from './personajes.js';
import { T } from './en.js';

let activa = true;
export const estaActiva = () => activa;
export async function cargar() { activa = (await ajuste('vida_oficina', true)) !== false; }
export async function fijar(on) {
  activa = Boolean(on);
  await fijarAjuste('vida_oficina', activa);
  await emitir({ tipo: 'vida', activa });
  await log('dueno', activa ? T('ha activado la vida de oficina: los agentes vuelven a tener su vida, sus charlas y sus descansos.') : T('ha desactivado la vida de oficina: los agentes solo trabajan.'));
  return activa;
}

const hoy = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const nombres = () => Object.fromEntries(IDS.map(id => [id, AGENTES[id].nombre]));

/** Bloque de personaje para las instrucciones del agente (vacío si el módulo está apagado). */
export function paraAgente(id) {
  if (!activa) return '';
  return paraPrompt(id, { nombres: nombres(), fecha: hoy() });
}

/** Lo que el panel necesita para pintar la vida: personajes y charlas de hoy. */
export async function paraPanel() {
  const ch = await ajuste('charlas', null);
  return { activa, personajes: PERSONAJES, charlas: ch?.fecha === hoy() ? ch.lista : [] };
}

let ultimoIntento = 0;
/** Genera las charlas de hoy si aún no las hay (como mucho un intento cada 30 minutos). */
export async function charlasSiFaltan() {
  if (Date.now() - ultimoIntento < 30 * 60_000) return;
  if ((await ajuste('charlas', null))?.fecha === hoy()) return;
  ultimoIntento = Date.now();
  await generarCharlas();
}

/**
 * Charlas del día: una llamada barata al modelo más económico con las vidas y lo que pasó ayer en la oficina.
 * Devuelve una lista de { de, a, texto, respuesta } que el panel va soltando a lo largo del día.
 */
export async function generarCharlas() {
  if (!activa) return null;
  const f = hoy();
  const ya = await ajuste('charlas', null);
  if (ya?.fecha === f) return ya.lista;
  const ayer = (await q(`SELECT datos->>'agente' agente, datos->>'texto' texto FROM eventos WHERE datos->>'tipo'='log' AND ts > now() - interval '30 hours' ORDER BY id DESC LIMIT 25`)).rows;
  const n = nombres();
  const fichas = IDS.filter(departamentos.trabaja).map(id => { const p = PERSONAJES[id]; return p ? `${id} (${n[id]}, ${AGENTES[id].rol}): ${p.familia} ${p.aficion} Es ${p.personalidad.toLowerCase()} Relaciones: ${Object.entries(p.relaciones || {}).map(([k, t]) => `${n[k] || k}: ${t}`).join(' ')}` : ''; }).filter(Boolean).join('\n');
  const prompt = `Escribe 10 charlas cortas de oficina para hoy (${f}) entre los agentes de ${miEmpresa.nombre()}, ${config.empresa.oficina}. Son personajes con vida propia:
${fichas}

Hoy: ${eventosDeHoy(f, n).join(' ') || 'un día normal'}
Lo que ha pasado en el trabajo en las últimas horas (puedes comentarlo, sin inventar cifras ni empresas):
${ayer.map(l => `- ${n[l.agente] || l.agente}: ${l.texto}`).join('\n') || '- (nada destacable)'}

Reglas: en ${idiomaEquipo()}, natural y con humor amable; cada frase de menos de 140 caracteres; mezcla vida personal (coherente con las fichas, sin cambiar hechos) y comentarios del trabajo; nada ofensivo; sin emojis salvo Álex.
Responde SOLO con JSON: {"charlas":[{"de":"id","a":"id","texto":"...","respuesta":"..."}]} usando los id de la lista.`;
  const modelo = config.modelos.rafa;
  const r = await llamar({ modelo, messages: [{ role: 'user', content: prompt }], maxTokens: 8000, razonamiento: { max_tokens: 800 } });
  await presupuesto.registrar('rafa', null, modelo, r.coste, r.uso);
  let lista = [];
  try {
    const t = String(r.mensaje.content || '');
    const id = x => { const s = String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim(); return AGENTES[s] ? s : IDS.find(k => AGENTES[k].nombre.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '') === s) || null; };
    lista = (JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)).charlas || [])
      .map(c => ({ ...c, de: id(c.de), a: id(c.a) }))
      .filter(c => c.de && c.a && c.de !== c.a && c.texto)
      .map(c => ({ de: c.de, a: c.a, texto: String(c.texto).slice(0, 180), respuesta: String(c.respuesta || '').slice(0, 180) })).slice(0, 12);
  } catch (e) { console.error('Charlas: respuesta no válida', e.message, 'fin:', r.fin, String(r.mensaje.content || '').slice(0, 200)); lista = []; }
  if (!lista.length) return [];   // no se guarda: se reintenta en la siguiente vuelta del planificador
  await fijarAjuste('charlas', { fecha: f, lista });
  await emitir({ tipo: 'charlas', lista });
  (await import('./chat.js')).charlasAlCafe(lista, f).catch(e => console.error('Chat (#café):', e.message));
  return lista;
}

// ---------- Ánimo del equipo: uno solo para todas las pantallas ----------
// Se calcula en el servidor con datos reales (gracias, mesa, atascos, trabajo hecho), así el móvil,
// Chrome y la app ven el mismo número. Los adornos de cada pantalla (papeleras, cafés) ya no cuentan.
let animoAnterior = null;
const madrid = () => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date()).map(x => [x.type, x.value])); return { dia: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), h: Number(p.hour) % 24, m: Number(p.minute) }; };
export function esFiesta(t = madrid()) {
  const { dia, h } = t;
  return (dia === 5 && h >= 19) || (dia === 6 && (h >= 13 || h < 2)) || (dia === 0 && (h < 2 || (h >= 13 && h < 20)));
}
export async function animo() {
  const n = async (sql) => (await q(sql).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
  const [gracias, mesa, atascos, hechas, cliente] = await Promise.all([
    n(`SELECT count(*)::int n FROM eventos WHERE datos->>'tipo'='log' AND datos->>'agente'='dueno' AND (datos->>'texto' LIKE 'le ha dado las gracias%' OR datos->>'texto' LIKE 'thanked%') AND ts > now() - interval '3 hours'`),
    n(`SELECT count(*)::int n FROM aprobaciones WHERE estado='pendiente' AND (pospuesta IS NULL OR pospuesta < now())`),
    n(`SELECT count(*)::int n FROM bloqueos WHERE resuelto IS NULL`),
    n(`SELECT count(*)::int n FROM tareas WHERE estado='hecha' AND terminada > date_trunc('day', now() AT TIME ZONE 'Europe/Madrid') AT TIME ZONE 'Europe/Madrid'`),
    n(`SELECT count(*)::int n FROM eventos WHERE datos->>'tipo'='cliente' AND ts > now() - interval '2 hours'`),
  ]);
  const t = madrid(), fiestaHasta = Number(await ajuste('fiesta_hasta', 0)) || 0;
  const motivos = [];
  let v = 62;
  const sum = (x, txt) => { if (x) { v += x; motivos.push(`${x > 0 ? '+' : ''}${x} ${txt}`); } };
  sum(Math.min(20, gracias * 5), `gracias de Dirección (últimas 3 h: ${gracias})`);
  sum(Math.min(10, hechas), `trabajos terminados hoy (${hechas})`);
  if (esFiesta(t) || fiestaHasta > Date.now()) sum(15, 'fiesta');
  if (cliente) sum(15, 'cliente nuevo');
  if (t.h === 14 && t.m < 45) sum(4, 'hora de comer');
  sum(-Math.min(30, Math.max(0, mesa - 2) * 3), `cosas esperando en tu mesa (${mesa})`);
  sum(-Math.min(20, atascos * 5), `agentes atascados (${atascos})`);
  if (t.dia === 1 && t.h < 12) sum(-6, 'lunes por la mañana');
  const tonoDueno = await (await import('./tono.js')).actual().catch(() => ({ nivel: 0 }));
  if (tonoDueno.nivel) sum(tonoDueno.nivel === 2 ? -12 : -6, tonoDueno.nivel === 2 ? 'Dirección está muy estresado' : 'Dirección va con prisa');
  return { valor: Math.max(5, Math.min(100, Math.round(v))), motivos };
}
/** Se recalcula en cada vuelta del planificador y solo se avisa a las pantallas si cambia. */
export async function emitirAnimo(forzar = false) {
  if (!activa) return null;
  const a = await animo();
  if (forzar || !animoAnterior || animoAnterior.valor !== a.valor) { animoAnterior = a; await emitir({ tipo: 'animo', ...a }); }
  return a;
}
/** Dirección monta una fiesta: dura 2 minutos y se ve en todas las pantallas. */
export async function fiesta() {
  const hasta = Date.now() + 120_000;
  await fijarAjuste('fiesta_hasta', hasta);
  await emitir({ tipo: 'fiesta', hasta });
  await log('dueno', T('ha montado una fiesta improvisada. 🎉'));
  await emitirAnimo(true);
}
