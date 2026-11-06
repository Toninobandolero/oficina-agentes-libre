// Módulos de la edición Pro: están si están sus archivos, y cada empresa puede apagar en Configuración los que no use.
// La edición Libre no lleva sus archivos (SOLO_PRO en exportar-plantilla.mjs) y esos puntos se apagan solos.
// El código común solo toca un módulo con PRO.x y, para su código, M.x: así pasar uno de una edición a otra es cambiar SOLO_PRO.
import fs from 'node:fs';
import { ajuste, fijarAjuste } from './db.js';

const hay = (...archivos) => archivos.every(a => fs.existsSync(new URL(`./${a}`, import.meta.url)));

// carga: el archivo que se carga al arrancar (en M); voz y centralita se cargan donde se usan
export const MODULOS = [
  { id: 'voz', nombre: 'Lola, la recepcionista de voz', archivos: ['voz.js', 'elevenlabs.js'] },
  { id: 'centralita', nombre: 'Centralita y análisis de cada llamada', archivos: ['zadarma.js', 'trasLlamada.js'] },
  { id: 'guiones', nombre: 'Guiones con método de venta y ensayo de la llamada', archivos: ['guionVenta.js'], carga: 'guionVenta.js' },
  { id: 'ines', nombre: 'Inés, que da forma a los documentos para clientes', archivos: ['ines.js'], carga: 'ines.js', agentes: ['ines'] },
  { id: 'correoDiseno', nombre: 'Correo con el diseño de tu empresa', archivos: ['correoDiseno.js'], carga: 'correoDiseno.js' },
  { id: 'vigilante', nombre: 'Rafa vigila la oficina', archivos: ['vigilante.js'], carga: 'vigilante.js' },
];
export const INSTALADO = Object.fromEntries(MODULOS.map(m => [m.id, hay(...m.archivos)]));

let apagados = new Set();
/** PRO.x: el módulo está y esta empresa lo usa. */
export const PRO = {};
for (const { id } of MODULOS) Object.defineProperty(PRO, id, { get: () => INSTALADO[id] && !apagados.has(id), enumerable: true });
/** El código de los módulos instalados: M.guiones, M.ines… (solo tras cargar). */
export const M = {};

export async function cargar() {
  for (const m of MODULOS) if (m.carga && INSTALADO[m.id]) M[m.id] ??= await import(`./${m.carga}`);
  M.ines?.montar();
  apagados = new Set(await ajuste('modulos_apagados', []));
}
export const listar = () => MODULOS.filter(m => INSTALADO[m.id]).map(({ id, nombre }) => ({ id, nombre, activo: PRO[id] }));
/** Guarda los módulos que usa la empresa: los demás instalados quedan apagados. */
export async function guardar(activos) {
  apagados = new Set(MODULOS.filter(m => INSTALADO[m.id] && !activos.includes(m.id)).map(m => m.id));
  await fijarAjuste('modulos_apagados', [...apagados]);
}
