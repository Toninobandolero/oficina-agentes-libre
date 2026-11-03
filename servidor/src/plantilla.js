// Configuración de la plantilla: nombre, puesto, aspecto y modelo de IA de cada agente (y tu aspecto).
// Lo que cambias aquí se guarda en la base de datos y se aplica al momento, sin reiniciar.
import { q } from './db.js';
import { AGENTES, IDS } from './agentes.js';
import * as departamentos from './departamentos.js';
import { config } from './config.js';
import { emitir, log } from './bus.js';

const FIJOS = Object.fromEntries(IDS.map(id => [id, { nombre: AGENTES[id].nombre, rol: AGENTES[id].rol, modelo: config.modelos[id] }]));
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
}

export function listar() {
  const agentes = IDS.filter(departamentos.trabaja).map(id => ({
    id, nombre: AGENTES[id].nombre, rol: AGENTES[id].rol, modelo: config.modelos[id],
    base: BASE(id), look: filas[id]?.look || null, cambiado: Boolean(filas[id]),
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
  const antes = id !== 'dueno' ? AGENTES[id].nombre : 'Dirección';
  const r = await q(`INSERT INTO config_agentes (id, nombre, rol, modelo, look) VALUES ($1,$2,$3,$4,$5)
                     ON CONFLICT (id) DO UPDATE SET nombre=EXCLUDED.nombre, rol=EXCLUDED.rol, modelo=EXCLUDED.modelo, look=EXCLUDED.look, actualizada=now() RETURNING *`,
    [id, nombre, rol, modelo, look ? JSON.stringify(look) : null]);
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
