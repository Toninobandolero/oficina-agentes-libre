// Configuración de la plantilla: nombre, puesto, aspecto y modelo de IA de cada agente (y tu aspecto).
// Lo que cambias aquí se guarda en la base de datos y se aplica al momento, sin reiniciar.
import { q, ajuste, fijarAjuste } from './db.js';
import { PERSONAJES, GRUPO } from './personajes.js';
import { AGENTES, IDS } from './agentes.js';
import * as departamentos from './departamentos.js';
import { config } from './config.js';
import { emitir, log } from './bus.js';

const FIJOS = {};
/** Lo de fábrica de un agente, para volver a ello. Los de un módulo (ines.js) se apuntan al montarse. */
export const fijo = id => { FIJOS[id] = { nombre: AGENTES[id].nombre, rol: AGENTES[id].rol, modelo: config.modelos[id] }; };
IDS.forEach(fijo);
const BASE = id => FIJOS[id] || departamentos.basePropia(id);
const ESTILOS = ['short', 'long', 'curly', 'bun', 'rapado', 'bald'];
const HEX = /^#[0-9a-f]{6}$/i;
const MODELO = /^[\w.-]+\/[\w.:-]+$/;

export const MODELOS = [
  { id: 'anthropic/claude-haiku-5.5', nombre: 'Haiku 5.5', nota: 'Económico. Para buscar, puntuar y tareas repetitivas.' },
  { id: 'anthropic/claude-sonnet-5.5', nombre: 'Sonnet 5.5', nota: 'Equilibrado. Para escribir en nombre de Dirección y razonar.' },
  { id: 'anthropic/claude-opus-5.5', nombre: 'Opus 5.5', nota: 'Máxima calidad, bastante más caro. Solo si de verdad hace falta.' },
];

let filas = {};

const azar = l => l[Math.floor(Math.random() * l.length)];
const PIELES = ['#f6d7bd', '#f1c29b', '#e8b48f', '#d9a27a', '#c98c63', '#8d5a3b', '#5c3a24'];
const PELOS = ['#140f0c', '#3b2416', '#5b3a24', '#a8642f', '#c9a15a', '#8e8e92', '#7a1f2b'];
const CAMISAS = ['#3a7bd5', '#2f9e8f', '#c0507a', '#e0a33a', '#6b5bd2', '#d65a4a', '#2f9e5a', '#5b4b8a', '#24395f', '#3aa0a8'];
/** Un aspecto al azar: piel, pelo, peinado, camisa y, a veces, gafas o barba. */
export function lookAlAzar(ella) {
  const look = { skin: azar(PIELES), hair: azar(PELOS), shirt: azar(CAMISAS), style: azar(ella ? ['long', 'long', 'bun', 'short', 'curly'] : ['short', 'short', 'curly', 'rapado', 'bald']) };
  if (Math.random() < 0.3) look.glasses = true;
  if (!ella && Math.random() < 0.4) { look.beard = true; look.beardColor = look.hair; }
  return look;
}
const CAMPOS_VIDA = ['edad', 'vive', 'familia', 'aficion', 'mania', 'personalidad', 'habla', 'anecdotas'];
const ORIGINAL = {}, TOCADO = new Set();
// Una oficina nueva no sale con los agentes de la de quien la hizo: al empezar, cada uno recibe al azar un nombre (de su género,
// sin repetir ni chocar con los que cubren las ausencias), un aspecto y una forma de ser. Todo se cambia luego en Configuración.
const MUJERES = ['Alba', 'Ana', 'Beatriz', 'Clara', 'Irene', 'Julia', 'Laura', 'Lidia', 'Lorena', 'Noelia', 'Olga', 'Raquel', 'Silvia', 'Teresa', 'Vera', 'Sofía', 'Carla', 'Diana'];
const HOMBRES = ['Adrián', 'Carlos', 'Daniel', 'Diego', 'Gonzalo', 'Iván', 'Jorge', 'Luis', 'Marcos', 'Nico', 'Óscar', 'Pablo', 'Rubén', 'Sergio', 'Tomás', 'Víctor', 'Raúl', 'Samuel'];
const SON_ELLAS = ['lucia', 'carmen', 'paula', 'nuria', 'pilar', 'sara', 'marta', 'ines'];
export async function nombresAlAzar() {
  if (await ajuste('nombres_al_azar', false)) return;   // solo la primera vez: una oficina que ya funciona no cambia de gente
  const usados = new Set(Object.values(PERSONAJES).map(p => p.sustituto).filter(Boolean));
  const sacar = lista => { const libres = lista.filter(n => !usados.has(n)); const n = azar(libres); usados.add(n); return n; };
  // Las formas de ser: las de fábrica de su género (sin sus relaciones, que hablan de compañeros concretos) y las del grupo
  const vida = p => Object.fromEntries(CAMPOS_VIDA.map(k => [k, p[k]]));
  const bolsa = ella => [...Object.entries(PERSONAJES).filter(([k]) => k !== 'paula' && SON_ELLAS.includes(k) === ella).map(([, p]) => vida(p)), ...(ella ? GRUPO.ellas : GRUPO.ellos)];
  const bolsas = { true: bolsa(true), false: bolsa(false) };
  for (const id of Object.keys(FIJOS)) {
    if (filas[id]?.nombre) continue;   // el que ya se cambió a mano se queda
    const ella = SON_ELLAS.includes(id), b = bolsas[ella];
    const nombre = sacar(ella ? MUJERES : HOMBRES);
    let persona = null;
    if (id !== 'paula' && PERSONAJES[id] && b.length) { persona = { ...b.splice(Math.floor(Math.random() * b.length), 1)[0], relaciones: {} }; }   // Paula tiene su historia (el bebé) y se queda con ella
    const look = lookAlAzar(ella);
    await q(`INSERT INTO config_agentes (id, nombre, look, persona) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO UPDATE SET nombre=EXCLUDED.nombre, look=EXCLUDED.look, persona=EXCLUDED.persona`,
      [id, nombre, JSON.stringify(look), persona && JSON.stringify(persona)]);
    filas[id] = { ...filas[id], id, nombre, look, persona };
    aplicar(id);
  }
  await fijarAjuste('nombres_al_azar', true);
}

/** Carga lo guardado y lo aplica a los agentes. */
export async function cargar() {
  const r = await q(`SELECT * FROM config_agentes`);
  filas = Object.fromEntries(r.rows.map(f => [f.id, f]));
  for (const id of IDS) aplicar(id);
}

function aplicar(id) {
  const f = filas[id] || {};
  AGENTES[id].nombre = f.nombre || BASE(id).nombre;
  AGENTES[id].rol = f.rol || BASE(id).rol;
  config.modelos[id] = f.modelo || BASE(id).modelo;
  // Su forma de ser: la de fábrica con lo que se haya sorteado o cambiado encima (solo se toca si hay algo)
  if (PERSONAJES[id] && (f.persona || TOCADO.has(id))) {
    ORIGINAL[id] ??= structuredClone(PERSONAJES[id]);
    Object.assign(PERSONAJES[id], structuredClone(ORIGINAL[id]), f.persona || {});
    f.persona ? TOCADO.add(id) : TOCADO.delete(id);
  }
}
const EDITABLES = ['personalidad', 'habla', 'familia', 'aficion', 'mania'];
const vidaDe = id => PERSONAJES[id] && Object.fromEntries(EDITABLES.map(k => [k, PERSONAJES[id][k] || '']));

export function listar() {
  const agentes = IDS.filter(departamentos.trabaja).map(id => ({
    id, nombre: AGENTES[id].nombre, rol: AGENTES[id].rol, modelo: config.modelos[id],
    base: BASE(id), look: filas[id]?.look || null, persona: vidaDe(id), cambiado: Boolean(filas[id]),
  }));
  return { agentes, dueno: { look: filas.dueno?.look || null }, modelos: MODELOS };
}

function limpiarLook(look) {
  if (!look || typeof look !== 'object') return null;
  const out = {};
  for (const k of ['skin', 'hair', 'shirt', 'beardColor', 'pants', 'cap']) if (look[k] != null) { if (!HEX.test(look[k])) throw new Error(`Color no válido en ${k}`); out[k] = look[k].toLowerCase(); }
  if (look.style != null) { if (!ESTILOS.includes(look.style)) throw new Error('Peinado no válido'); out.style = look.style; }
  for (const k of ['glasses', 'beard', 'hawaiana', 'bermudas', 'auris']) if (look[k] != null) out[k] = Boolean(look[k]);
  return Object.keys(out).length ? out : null;
}

/** Guarda los cambios de un agente (o de Dirección: solo su aspecto). */
export async function guardar(id, datos = {}) {
  if (id !== 'dueno' && !IDS.includes(id)) throw new Error('Agente desconocido');
  const look = limpiarLook(datos.look);
  let nombre = null, rol = null, modelo = null;
  if (id !== 'dueno') {
    nombre = String(datos.nombre ?? '').trim() || null;
    if (nombre && !departamentos.NOMBRE.test(nombre)) throw new Error('El nombre solo puede tener letras y espacios (2–20 caracteres).');
    if (nombre && IDS.some(o => o !== id && AGENTES[o].nombre.toLowerCase() === nombre.toLowerCase())) throw new Error('Ya hay otro agente con ese nombre.');
    rol = String(datos.rol ?? '').trim().slice(0, 60) || null;
    modelo = String(datos.modelo ?? '').trim() || null;
    if (modelo && !MODELO.test(modelo)) throw new Error('El modelo debe tener el formato proveedor/modelo (p. ej. anthropic/claude-haiku-5.5).');
    if (modelo && config.proveedor === 'anthropic' && !modelo.startsWith('anthropic/')) throw new Error('La oficina trabaja con Claude: elige un modelo de Anthropic (Haiku, Sonnet u Opus).');
    if (nombre === BASE(id).nombre) nombre = null;
    if (rol === BASE(id).rol) rol = null;
    if (modelo === BASE(id).modelo) modelo = null;
  }
  // Su forma de ser: lo que llega se escribe encima de lo que tenía; lo que no llega se queda como estaba
  let persona = filas[id]?.persona || null;
  if (id !== 'dueno' && PERSONAJES[id] && datos.persona && typeof datos.persona === 'object') {
    const cambios = Object.fromEntries(EDITABLES.filter(k => typeof datos.persona[k] === 'string').map(k => [k, datos.persona[k].trim().slice(0, 300)]).filter(([k, v]) => v && v !== (ORIGINAL[id] || PERSONAJES[id])[k]));
    persona = { ...Object.fromEntries(Object.entries(persona || {}).filter(([k]) => !EDITABLES.includes(k))), ...cambios };
    if (!Object.keys(persona).length) persona = null;
  }
  const antes = id !== 'dueno' ? AGENTES[id].nombre : 'Dirección';
  const r = await q(`INSERT INTO config_agentes (id, nombre, rol, modelo, look, persona) VALUES ($1,$2,$3,$4,$5,$6)
                     ON CONFLICT (id) DO UPDATE SET nombre=EXCLUDED.nombre, rol=EXCLUDED.rol, modelo=EXCLUDED.modelo, look=EXCLUDED.look, persona=EXCLUDED.persona, actualizada=now() RETURNING *`,
    [id, nombre, rol, modelo, look ? JSON.stringify(look) : null, persona && JSON.stringify(persona)]);
  filas[id] = r.rows[0];
  if (id !== 'dueno') aplicar(id);
  const despues = id !== 'dueno' ? AGENTES[id].nombre : 'Dirección';
  await log('dueno', id === 'dueno' ? 'ha cambiado su aspecto en la oficina.'
    : antes !== despues ? `ha cambiado el nombre de ${antes}: ahora es ${despues}.` : `ha cambiado la configuración de ${despues}.`);
  await emitir({ tipo: 'plantilla', ...listar() });
  return listar();
}

export async function restablecer(id) {
  await q(`DELETE FROM config_agentes WHERE id=$1`, [id]);
  delete filas[id];
  if (IDS.includes(id)) aplicar(id);
  await log('dueno', `ha devuelto a ${id === 'dueno' ? 'Dirección' : AGENTES[id]?.nombre || id} su configuración original.`);
  await emitir({ tipo: 'plantilla', ...listar() });
  return listar();
}

/** «Mateo», «mateo», «Matéo» o el nombre nuevo que le hayas puesto → id del agente. */
export function idPorNombre(s) {
  const n = String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  if (IDS.includes(n)) return n;
  return IDS.find(id => AGENTES[id].nombre.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '') === n) || null;
}
