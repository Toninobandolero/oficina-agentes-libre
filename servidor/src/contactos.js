// Las personas y los teléfonos de cada empresa. El teléfono de la ficha es el general; aquí va quién es quién: el dueño, el encargado, su móvil.
// Lo que ya esté escrito en las notas y el dossier se recoge solo, para que al pulsar «Llamar» salga sin tener que volver a apuntarlo.
import { q } from './db.js';

export const clave = t => String(t || '').replace(/\D/g, '').slice(-9);
const valido = t => /^[6789]\d{8}$/.test(clave(t)) && !/^\d(\d)\1{7}$/.test(clave(t));   // 600 000 000 es un número de relleno
export const esMovil = t => /^[67]/.test(clave(t));
const normal = t => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const TEL = /(?<![\d.,])(?:\+?34[\s.-]?)?[6789](?:[\s.-]?\d){8}(?![\d])/g;

/** Los teléfonos que hay en un texto, con la frase en la que salen: es lo que dice de quién son. */
export function telefonosEnTexto(texto) {
  const t = String(texto || ''), out = new Map();
  for (const m of t.matchAll(TEL)) {
    const k = clave(m[0]), fin = m.index + m[0].length;
    if (!valido(k) || out.has(k) || /^\s*(€|eur|euros|\$)/i.test(t.slice(fin, fin + 7))) continue;
    const ini = t.lastIndexOf('\n', m.index) + 1, corte = t.indexOf('\n', fin);
    const linea = t.slice(ini, corte < 0 ? t.length : corte).replace(/[*_#>`-]+/g, ' ').replace(/\s+/g, ' ').trim();
    out.set(k, { telefono: m[0].trim(), contexto: linea.slice(0, 160) });
  }
  return [...out.values()];
}

/** Recoge lo que ya sabemos en otros sitios. No machaca nada: si ese número ya está, o se quitó a propósito, se queda como está. */
async function rescatar(e) {
  const general = clave(e.telefono);
  const nuevo = (telefono, datos) => q(`INSERT INTO contactos (empresa_id, telefono, clave, nombre, cargo, notas, origen) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (empresa_id, clave) WHERE clave IS NOT NULL DO NOTHING`,
    [e.id, telefono, clave(telefono), datos.nombre || null, datos.cargo || null, datos.notas || null, datos.origen]);
  const pila = normal(String(e.decisor || '').split(/\s+/)[0]);
  for (const { telefono, contexto } of telefonosEnTexto(`${e.notas || ''}\n${e.dossier || ''}`)) {
    if (clave(telefono) === general) continue;
    const delDecisor = pila.length >= 3 && normal(contexto).split(/[^a-zñ]+/).includes(pila);
    await nuevo(telefono, { nombre: delDecisor ? e.decisor : null, cargo: delDecisor ? e.cargo : null, notas: contexto, origen: 'notas' });
  }
  // Quien llamó a Lola o escribió desde la web dejó su nombre y su número
  const quien = await q(`SELECT telefono, nombre, 'lola' AS origen FROM llamadas_voz WHERE empresa_id=$1 AND telefono IS NOT NULL
                         UNION ALL SELECT telefono, nombre, 'web' FROM entradas WHERE empresa_id=$1 AND telefono IS NOT NULL`, [e.id]);
  for (const x of quien.rows) if (valido(x.telefono) && clave(x.telefono) !== general) await nuevo(x.telefono, { nombre: x.nombre, origen: x.origen });
}

const ORIGEN = { notas: 'Visto en las notas', lola: 'Llamó a Lola', web: 'Escribió desde la web' };

/** Las personas de una empresa, de mejor a peor para llamar. */
export async function deEmpresa(id) {
  const e = (await q(`SELECT id, telefono, decisor, cargo, notas, dossier FROM empresas WHERE id=$1`, [id])).rows[0];
  if (!e) return [];
  await rescatar(e);
  const filas = (await q(`SELECT id, nombre, cargo, telefono, email, linkedin_url, preferente, notas, origen FROM contactos WHERE empresa_id=$1 AND NOT borrado ORDER BY id`, [id])).rows;
  const decisor = normal(e.decisor);
  const puntos = c => (c.preferente ? 1000 : 0) + (decisor && normal(c.nombre) === decisor ? 100 : 0) + (c.nombre ? 50 : 0) + (c.telefono && esMovil(c.telefono) ? 20 : 0);
  return filas.map(c => ({ ...c, movil: esMovil(c.telefono) })).sort((a, b) => puntos(b) - puntos(a) || a.id - b.id);
}

/** A quién se puede llamar: las personas con teléfono y, al final, el teléfono general. Es lo que sale al pulsar «Llamar». */
export async function opciones(id) {
  const e = (await q(`SELECT telefono FROM empresas WHERE id=$1`, [id])).rows[0];
  const lista = (await deEmpresa(id)).filter(c => c.telefono).map(c => ({ id: c.id, telefono: c.telefono, movil: c.movil, preferente: c.preferente,
    etiqueta: c.nombre || ORIGEN[c.origen] || 'Sin nombre', detalle: c.nombre ? c.cargo || '' : c.notas || '' }));
  if (e?.telefono && !lista.some(o => clave(o.telefono) === clave(e.telefono))) lista.push({ telefono: e.telefono, movil: esMovil(e.telefono), etiqueta: 'Teléfono general de la empresa', detalle: '' });
  return lista;
}

/** Una línea con todos los teléfonos, para los guiones y las tarjetas. */
export async function lineaTelefonos(id) {
  return (await opciones(id)).map(o => `${o.etiqueta}${o.detalle && o.etiqueta !== 'Teléfono general de la empresa' ? ` (${o.detalle})` : ''}: ${o.telefono}`).join('; ');
}

/** Guarda una persona. Si ese número ya estaba en esta empresa, completa lo que había. Con preferente, es a quien se llama primero. */
export async function guardar(empresa_id, datos = {}, { origen = 'equipo' } = {}) {
  const texto = (v, n) => { const t = String(v ?? '').trim(); return t ? t.slice(0, n) : null; };
  const nombre = texto(datos.nombre, 120), cargo = texto(datos.cargo, 120), telefono = texto(datos.telefono, 40), email = texto(datos.email, 200), linkedin_url = texto(datos.linkedin_url, 300), notas = texto(datos.notas, 300);
  if (telefono && !valido(telefono)) throw new Error('Ese teléfono no parece válido: tienen que ser 9 cifras de un número español.');
  if (!telefono && !email && !nombre) throw new Error('Pon al menos un nombre, un teléfono o un correo.');
  if (!(await q(`SELECT 1 FROM empresas WHERE id=$1`, [empresa_id])).rows.length) throw new Error(`No existe la empresa ${empresa_id}`);
  const k = telefono ? clave(telefono) : null;
  const previo = datos.id ? (await q(`SELECT id FROM contactos WHERE id=$1 AND empresa_id=$2`, [datos.id, empresa_id])).rows[0]
    : k ? (await q(`SELECT id FROM contactos WHERE empresa_id=$1 AND clave=$2`, [empresa_id, k])).rows[0] : null;
  let fila;
  if (previo) {
    fila = (await q(`UPDATE contactos SET nombre=coalesce($2,nombre), cargo=coalesce($3,cargo), telefono=coalesce($4,telefono), clave=coalesce($5,clave), email=coalesce($6,email),
                       linkedin_url=coalesce($7,linkedin_url), notas=coalesce($8,notas), borrado=false, origen=$9 WHERE id=$1 RETURNING *`, [previo.id, nombre, cargo, telefono, k, email, linkedin_url, notas, origen])).rows[0];
  } else {
    fila = (await q(`INSERT INTO contactos (empresa_id, nombre, cargo, telefono, clave, email, linkedin_url, notas, origen) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [empresa_id, nombre, cargo, telefono, k, email, linkedin_url, notas, origen])).rows[0];
  }
  if (datos.preferente === true) await hacerPreferente(fila.id);
  return (await q(`SELECT * FROM contactos WHERE id=$1`, [fila.id])).rows[0];
}

export async function hacerPreferente(id) {
  const c = (await q(`SELECT empresa_id FROM contactos WHERE id=$1`, [id])).rows[0];
  if (!c) throw new Error('Ese contacto ya no existe.');
  await q(`UPDATE contactos SET preferente = (id = $1) WHERE empresa_id=$2`, [id, c.empresa_id]);
}

/** Se marca como quitado en vez de borrarlo: así un número equivocado que sigue en las notas no vuelve a salir. */
export async function quitar(id) {
  const r = await q(`UPDATE contactos SET borrado=true, preferente=false WHERE id=$1 RETURNING id`, [id]);
  if (!r.rows.length) throw new Error('Ese contacto ya no existe.');
}
