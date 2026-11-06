// Departamentos de la oficina: cada empresa usa los que necesita. Los apagados no reciben trabajo ni gastan, y no salen en el panel.
// Rafa los propone en el primer uso (arranque.js) y se cambian en Configuración. Dirección (Rafa) y Recepción (Lola) no se apagan.
// Además de los cinco de siempre, cada empresa puede crear los suyos: se guardan en la base de datos, ocupan una sala libre y tienen su propio tope de gasto.
import { q, ajuste, fijarAjuste } from './db.js';
import { config } from './config.js';
import { AGENTES, IDS } from './agentes.js';
import { log, estado } from './bus.js';
import * as telegram from './telegram.js';
import { periodo } from './presupuesto.js';
import { MODULOS, INSTALADO, PRO } from './modulos.js';

export const DEPARTAMENTOS = [
  { id: 'investigacion', nombre: 'Investigación', agentes: ['lucia', 'mateo', 'carmen'], para: 'Busca empresas, las puntúa y prepara un dossier de cada una. Para quien vende a otras empresas.' },
  { id: 'ventas', nombre: 'Ventas', agentes: ['javi', 'paula'], para: 'Escribe los primeros contactos, hace el seguimiento y contesta a quien escribe.' },
  { id: 'marketing', nombre: 'Marketing', agentes: ['alex', 'sara'], para: 'Contenido, redes, vídeos y boletín, y vigila lo que pasa en el mercado.' },
  { id: 'preventa', nombre: 'Preventa y legal', agentes: ['nuria', 'pilar'], para: 'Prepara propuestas, les da forma de documento y revisa lo legal de lo que se envía.' },
  { id: 'alianzas', nombre: 'Alianzas y web', agentes: ['marta', 'leo'], para: 'Colaboradores y eventos; web, ficha de Google y anuncios.' },
];

const FIJOS = DEPARTAMENTOS.length;
// Cada departamento encendido ocupa una sala: las de los cinco de siempre y una que está libre. Los propios usan la libre y las de los apagados
const SALA_LIBRE = 'produccion', MAX_ENCENDIDOS = FIJOS + 1;
const MAX_PERSONAS = 3, TOPE_EUR = 5, MODELO_BARATO = 'anthropic/claude-haiku-5.5', WEB = { busquedas: 3, lecturas: 5 };
// Lo que puede hacer cada persona de un departamento propio. Con o sin permisos, nada sale fuera sin aprobación
const BASICAS = ['pedir_aprobacion', 'encargar', 'enviar_informe', 'anotar'];
export const PERMISOS = {
  internet: [],   // buscar_web y leer_web, con los topes de WEB (herramientas.js las añade a quien tiene «web»)
  clientes: ['listar_empresas', 'leer_empresa', 'consultar_oficina', 'guardar_empresas', 'actualizar_empresa'],
  contestar: ['preparar_correo', 'leer_chat', 'responder_chat', 'apuntar_en_calendario'],
};
export const NOMBRE = /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ' -]{2,20}$/;
const RESERVADOS = ['dueno', 'sistema', 'lola', 'trini', 'manolo', 'general', 'trabajo', 'actividad', 'cafe', 'web', 'telefono', 'secuencia'];   // otros de la oficina, canales del chat y orígenes de una tarea
const PIELES = ['#f1c29b', '#d9a27a', '#8d5a3b', '#f3cfb0', '#e8b48f', '#c98c63'], PELOS = ['#3b2416', '#1e1a17', '#a8642f', '#c9a15a', '#7a1f2b', '#4a2f1d'],
  CAMISAS = ['#3a7bd5', '#2f9e8f', '#c0507a', '#e0a33a', '#6b5bd2', '#d65a4a'], PEINADOS = ['short', 'long', 'curly', 'bun'];

let apagados = [];

export const propios = () => DEPARTAMENTOS.slice(FIJOS);
const encendidos = () => propios().filter(d => !apagados.includes(d.id));

const agenteDe = (d, p) => ({
  nombre: p.nombre, rol: p.rol, instrucciones: p.instrucciones, icono: 'doc', estilo: true,
  herramientas: [...BASICAS, ...p.permisos.flatMap(x => PERMISOS[x])],
  web: p.permisos.includes('internet') ? WEB : null,
  parte: `Trabajas en el departamento «${d.nombre}»: ${d.para}
Lo que vaya a salir hacia fuera o necesite el visto bueno de Dirección, entrégalo con pedir_aprobacion. Lo que sea solo para contárselo, con enviar_informe, en pocas líneas.
Si algo le toca a un compañero, encárgaselo con encargar; si no sabes a quién, a 'rafa', que lo reparte.
No estás conectado a los programas de la empresa (agenda, caja, facturación…): si te hace falta un dato de ahí, pídeselo a Dirección con estoy_atascado.`,
});

/** Pone en marcha una lista de departamentos propios: sus agentes entran en AGENTES e IDS y el resto de la oficina los trata como a los demás. */
function montar(lista) {
  for (const id of propios().flatMap(d => d.agentes)) { delete AGENTES[id]; delete config.modelos[id]; IDS.splice(IDS.indexOf(id), 1); }
  DEPARTAMENTOS.splice(FIJOS, Infinity, ...lista);
  for (const d of lista) for (const p of d.personas) { AGENTES[p.id] = agenteDe(d, p); IDS.push(p.id); config.modelos[p.id] = MODELO_BARATO; }
}

export async function cargar() {
  apagados = (await ajuste('departamentos_apagados', [])) || [];
  montar((await ajuste('departamentos_propios', [])) || []);
}
export const agentesApagados = () => [...DEPARTAMENTOS.filter(d => apagados.includes(d.id)).flatMap(d => d.agentes), ...MODULOS.filter(m => INSTALADO[m.id] && !PRO[m.id]).flatMap(m => m.agentes || [])];
export const trabaja = agente => !agentesApagados().includes(agente);
export const listar = () => DEPARTAMENTOS.map(d => ({ ...d, activo: !apagados.includes(d.id) }));

/** Guarda los departamentos que usa la empresa: los demás quedan apagados. */
export async function guardar(activos) {
  const ids = DEPARTAMENTOS.map(d => d.id);
  if (!Array.isArray(activos) || activos.some(a => !ids.includes(a))) throw new Error(`Los departamentos son: ${ids.join(', ')}.`);
  if (activos.length > MAX_ENCENDIDOS) throw new Error(`En la oficina caben ${MAX_ENCENDIDOS} departamentos encendidos: apaga alguno.`);
  apagados = ids.filter(id => !activos.includes(id));
  await fijarAjuste('departamentos_apagados', apagados);
  return listar();
}

const sinTildes = s => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
// Nombres, puestos y frases cortas acaban en el panel; el texto puede venir de una web a través de Rafa
const limpio = (s, max) => String(s ?? '').replace(/[<>"`]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const texto = (s, max) => String(s ?? '').trim().slice(0, max);

function persona(p, previo, usados) {
  const yaEra = previo?.personas.find(x => x.id === p.id);
  const nombre = String(p.nombre ?? '').trim(), clave = sinTildes(nombre);
  const base = clave.replace(/[^a-z]/g, '');
  if (!NOMBRE.test(nombre) || base.length < 2) throw new Error('El nombre de cada persona solo puede tener letras y espacios (2–20 caracteres).');
  const repetido = usados.has(clave) || RESERVADOS.includes(clave) || IDS.some(k => !previo?.agentes.includes(k) && sinTildes(AGENTES[k].nombre) === clave);
  if (repetido) throw new Error(`Ya hay alguien que se llama ${nombre}: elige otro nombre.`);
  const rol = limpio(p.rol, 60), instrucciones = texto(p.instrucciones, 4000), permisos = Array.isArray(p.permisos) ? p.permisos : [];
  if (!rol) throw new Error(`Di cuál es el puesto de ${nombre}.`);
  if (!instrucciones) throw new Error(`Escribe las instrucciones de ${nombre}.`);
  if (permisos.some(x => !Object.hasOwn(PERMISOS, x))) throw new Error(`Los permisos son: ${Object.keys(PERMISOS).join(', ')}.`);
  let id = yaEra?.id || base;
  for (let n = 2; !yaEra && (AGENTES[id] || usados.has(id)); n++) id = base + n;
  usados.add(clave).add(id);
  const h = [...id].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7);
  return { id, nombre, rol, instrucciones, permisos, look: yaEra?.look || { skin: PIELES[h % 6], hair: PELOS[(h >>> 3) % 6], shirt: CAMISAS[(IDS.length + usados.size) % 6], style: PEINADOS[(h >>> 9) % 4] } };   // la camisa, distinta de la del compañero
}

function semanal(s) {
  if (!texto(s?.instruccion, 1)) return null;
  const dia = Number(s.dia), hora = String(s.hora ?? '');
  if (!Number.isInteger(dia) || dia < 0 || dia > 6 || !/^([01]\d|2[0-3]):[0-5]\d$/.test(hora)) throw new Error('El trabajo semanal necesita un día y una hora (HH:MM).');
  return { dia, hora, instruccion: texto(s.instruccion, 2000) };
}

function validar(datos, previo) {
  const nombre = limpio(datos.nombre, 40), para = limpio(datos.para, 300);
  const id = previo?.id || sinTildes(nombre).replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
  if (!id) throw new Error('Pon un nombre al departamento.');
  if (!para) throw new Error('Di para qué sirve el departamento.');
  if (DEPARTAMENTOS.some(d => d.id !== previo?.id && (d.id === id || sinTildes(d.nombre) === sinTildes(nombre)))) throw new Error(`Ya hay un departamento que se llama ${nombre}.`);
  const lista = Array.isArray(datos.personas) ? datos.personas : [];
  if (!lista.length || lista.length > MAX_PERSONAS) throw new Error(`Un departamento lleva de 1 a ${MAX_PERSONAS} personas.`);
  const usados = new Set(), personas = lista.map(p => persona(p, previo, usados));
  const tope_eur = datos.tope_eur === undefined || datos.tope_eur === '' ? (previo?.tope_eur ?? TOPE_EUR) : Number(String(datos.tope_eur).replace(',', '.'));
  if (!Number.isFinite(tope_eur) || tope_eur < 0 || tope_eur > 5000) throw new Error('Pon un tope entre 0 y 5000 € al mes.');
  return { id, nombre, para, propio: true, tope_eur: Math.round(tope_eur * 100) / 100, semanal: semanal(datos.semanal), personas, agentes: personas.map(p => p.id) };
}

/** Lo que tenía pendiente quien se va pasa a Rafa, que lo reparte. */
async function traspasar(ids) {
  await q(`UPDATE tareas SET agente='rafa', instruccion='(Era de alguien que ya no está en la oficina: repártelo, hazlo tú o avisa a Dirección.)' || chr(10) || instruccion WHERE agente = ANY($1) AND estado='pendiente'`, [ids]);
  await q(`UPDATE aprobaciones SET agente='rafa' WHERE agente = ANY($1) AND estado='pendiente'`, [ids]);
  await q(`UPDATE bloqueos SET resuelto=now(), como='Ya no está en la oficina' WHERE agente = ANY($1) AND resuelto IS NULL`, [ids]);
  await q(`DELETE FROM config_agentes WHERE id = ANY($1)`, [ids]);
}

async function aplicar(lista) {
  await fijarAjuste('departamentos_propios', lista);
  montar(lista);
  await (await import('./plantilla.js')).cargar();   // lo que se haya cambiado de cada agente (aspecto, modelo) sigue valiendo
}

/** Crea un departamento propio, encendido, o lo cambia si trae su id. El nombre y el puesto que manda pasan a ser los suyos. */
export async function guardarPropio(datos = {}) {
  const previo = datos.id ? propios().find(d => d.id === datos.id) : null;
  if (datos.id && !previo) throw new Error('Ese departamento ya no existe.');
  if (!previo && listar().filter(d => d.activo).length >= MAX_ENCENDIDOS) throw new Error(`No hay sala libre: en la oficina caben ${MAX_ENCENDIDOS} departamentos encendidos. Apaga otro antes de crear este.`);
  const d = validar(datos, previo);
  const fuera = previo ? previo.agentes.filter(id => !d.agentes.includes(id)) : [];
  if (fuera.length) await traspasar(fuera);
  await q(`UPDATE config_agentes SET nombre=NULL, rol=NULL WHERE id = ANY($1)`, [d.agentes]);
  await aplicar(previo ? propios().map(x => (x === previo ? d : x)) : [...propios(), d]);
  for (const id of d.agentes) await estado(id, 'inactivo', 'Esperando trabajo', AGENTES[id].icono);
  return d;
}

/** Borra un departamento propio. */
export async function quitarPropio(id) {
  const d = propios().find(x => x.id === id);
  if (!d) throw new Error('Ese departamento ya no existe.');
  await traspasar(d.agentes);
  apagados = apagados.filter(x => x !== id);
  await fijarAjuste('departamentos_apagados', apagados);
  await aplicar(propios().filter(x => x !== d));
  return d;
}

/** Lo que el panel necesita para dibujarlos: qué sala ocupa cada uno y quién se sienta en ella. */
export function paraPanel() {
  const libres = [SALA_LIBRE, ...DEPARTAMENTOS.slice(0, FIJOS).filter(d => apagados.includes(d.id)).map(d => d.id).reverse()];
  return encendidos().map((d, i) => ({ id: d.id, nombre: d.nombre, sala: libres[i], agentes: d.personas.map(({ id, nombre, rol, look }) => ({ id, nombre, rol, look })) }));
}

/** Datos de partida de un agente propio, para «Volver al original» en Configuración. */
export function basePropia(id) {
  const p = propios().flatMap(d => d.personas).find(x => x.id === id);
  return p && { nombre: p.nombre, rol: p.rol, modelo: MODELO_BARATO };
}

async function gastoDelMes() {
  const r = await q(`SELECT agente, sum(usd)::float AS usd FROM gasto WHERE agente = ANY($1) AND ts >= date_trunc('month', now() AT TIME ZONE 'Europe/Madrid') AT TIME ZONE 'Europe/Madrid' GROUP BY 1`, [propios().flatMap(d => d.agentes)]);
  return Object.fromEntries(r.rows.map(x => [x.agente, x.usd * config.usdEur]));
}
const gastoDe = (d, gasto) => d.agentes.reduce((n, id) => n + (gasto[id] || 0), 0);

/** Agentes de los departamentos propios que han llegado a su tope del mes: su trabajo espera. El resto de la oficina sigue. */
// ponytail: se mira entre tareas, así que una tarea empezada puede pasarse un poco del tope
export async function agotados() {
  if (!encendidos().length) return [];
  const gasto = await gastoDelMes(), fuera = encendidos().filter(d => gastoDe(d, gasto) >= d.tope_eur);
  for (const d of fuera) {
    const primera = await q(`INSERT INTO ajustes(clave, valor) VALUES ($1, 'true') ON CONFLICT (clave) DO NOTHING RETURNING 1`, [`tope-${d.id}:${periodo('mensual')}`]);   // el motor y las tareas pueden llegar a la vez
    if (!primera.rows.length) continue;
    for (const id of d.agentes) await estado(id, 'inactivo', 'Tope de gasto del mes alcanzado', 'zz');
    await log('rafa', `avisa: «${d.nombre}» ha llegado a su tope de ${d.tope_eur} € este mes. Su trabajo espera hasta el mes que viene o hasta que subas el tope en Configuración.`);
    await telegram.avisar(`⚠️ «${d.nombre}» ha llegado a su tope de ${d.tope_eur} € este mes. Su trabajo espera hasta el mes que viene o hasta que subas el tope en Configuración. El resto de la oficina sigue.`);
  }
  return fuera.flatMap(d => d.agentes);
}

/** La lista de Configuración: con los nombres de cada uno y lo que lleva gastado este mes cada departamento propio. */
export async function paraConfiguracion() {
  const gasto = propios().length ? await gastoDelMes() : {};
  return listar().map(d => ({ ...d, agentes: d.agentes.filter(id => !MODULOS.some(m => !PRO[m.id] && m.agentes?.includes(id))).map(id => AGENTES[id].nombre),   // sin los de un módulo apagado
    ...(d.propio ? { gastado: Math.round(gastoDe(d, gasto) * 100) / 100, personas: d.personas.map(p => ({ ...p, nombre: AGENTES[p.id].nombre, rol: AGENTES[p.id].rol })) } : {}) }));
}
