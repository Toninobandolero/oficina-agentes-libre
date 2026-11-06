// Las personas y los teléfonos de cada empresa. El teléfono de la ficha es el general; aquí va quién es quién: el dueño, el encargado, su móvil.
// Lo que ya esté escrito en las notas y el dossier se recoge solo, para que al pulsar «Llamar» salga y su llamada se reconozca. Sin saber de quién es, va sin nombre: es un teléfono de la empresa, no una persona.
import { q } from './db.js';

export const clave = t => String(t || '').replace(/\D/g, '').slice(-9);
const valido = t => /^[6789]\d{8}$/.test(clave(t)) && !/^\d(\d)\1{7}$/.test(clave(t));   // 600 000 000 es un número de relleno
export const esMovil = t => /^[67]/.test(clave(t));
const normal = t => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const TEL = /(?<![\d.,])(?:\+?34[\s.-]?)?[6789](?:[\s.-]?\d){8}(?![\d])/g;

/** Los teléfonos que hay en un texto, con lo que tienen justo al lado: es lo que dice de quién son. */
export function telefonosEnTexto(texto) {
  const t = String(texto || ''), out = new Map();
  for (const m of t.matchAll(TEL)) {
    const k = clave(m[0]), fin = m.index + m[0].length;
    if (!valido(k) || out.has(k) || /^\s*(€|eur|euros|\$)/i.test(t.slice(fin, fin + 7))) continue;
    const ini = t.lastIndexOf('\n', m.index) + 1, corte = t.indexOf('\n', fin);
    const desde = Math.max(ini, m.index - 50), antes = t.slice(desde, m.index);
    const cerca = (desde > ini ? antes.replace(/^\S*\s/, '') : antes) + t.slice(m.index, Math.min(corte < 0 ? t.length : corte, fin + 30));
    out.set(k, { telefono: m[0].trim(), contexto: cerca.replace(/[*_#>`-]+/g, ' ').replace(/\s+/g, ' ').trim() });
  }
  return [...out.values()];
}

const delDecisor = (contexto, decisor) => { const pila = normal(String(decisor || '').split(/\s+/)[0]); return pila.length >= 3 && normal(contexto).split(/[^a-zñ]+/).includes(pila); };

/** Una persona que ya está sin teléfono (quien decide, apuntado antes que su número) se queda con él en vez de salir dos veces. */
async function conSuNumero(empresa_id, nombre, telefono) {
  const k = clave(telefono);
  if (!nombre || !k || (await q(`SELECT 1 FROM contactos WHERE empresa_id=$1 AND clave=$2`, [empresa_id, k])).rows.length) return null;
  const sin = (await q(`SELECT id, nombre FROM contactos WHERE empresa_id=$1 AND NOT borrado AND telefono IS NULL AND nombre IS NOT NULL ORDER BY decide DESC, id`, [empresa_id])).rows.find(c => normal(c.nombre) === normal(nombre));
  if (!sin) return null;
  await q(`UPDATE contactos SET telefono=$2, clave=$3 WHERE id=$1`, [sin.id, String(telefono).trim().slice(0, 40), k]);
  return sin.id;
}

/** Recoge lo que ya sabemos en otros sitios. No machaca nada: si ese número ya está, o se quitó a propósito, se queda como está. */
async function rescatar(e) {
  const general = clave(e.telefono);
  const nuevo = async (telefono, datos) => (await conSuNumero(e.id, datos.nombre, telefono)) || q(`INSERT INTO contactos (empresa_id, telefono, clave, nombre, cargo, notas, origen) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (empresa_id, clave) WHERE clave IS NOT NULL DO NOTHING`,
    [e.id, telefono, clave(telefono), datos.nombre || null, datos.cargo || null, datos.notas || null, datos.origen]);
  for (const { telefono, contexto } of telefonosEnTexto(`${e.notas || ''}\n${e.dossier || ''}`)) {
    if (clave(telefono) === general) continue;
    const suyo = delDecisor(contexto, e.decisor);
    await nuevo(telefono, { nombre: suyo ? e.decisor : null, cargo: suyo ? e.cargo : null, notas: contexto, origen: 'notas' });
  }
  // Quien llamó a Lola o escribió desde la web dejó su nombre y su número
  const quien = await q(`SELECT telefono, nombre, 'lola' AS origen FROM llamadas_voz WHERE empresa_id=$1 AND telefono IS NOT NULL
                         UNION ALL SELECT telefono, nombre, 'web' FROM entradas WHERE empresa_id=$1 AND telefono IS NOT NULL`, [e.id]);
  for (const x of quien.rows) if (valido(x.telefono) && clave(x.telefono) !== general) await nuevo(x.telefono, { nombre: x.nombre, origen: x.origen });
}

/** Una sola vez: lo recogido de las notas y el dossier se queda con lo que el teléfono tiene al lado, no con 160 letras del dossier, y sin nombre si al lado no sale quien decide. Y vuelve lo que se quitó de más: un teléfono de tienda no es una persona, pero es de esa empresa. Lo escrito por ti o por el equipo no se toca. */
export async function arreglarRecogidos() {
  const filas = (await q(`SELECT c.id, c.clave, c.nombre, c.borrado, c.notas AS nota, e.decisor, e.notas, e.dossier FROM contactos c JOIN empresas e ON e.id=c.empresa_id WHERE c.origen='notas'`)).rows;
  let arreglados = 0;
  for (const c of filas) {
    const visto = telefonosEnTexto(`${c.notas || ''}\n${c.dossier || ''}`).find(x => clave(x.telefono) === c.clave);
    if (!visto) continue;
    const suyo = delDecisor(visto.contexto, c.decisor);
    if (!c.borrado && visto.contexto === c.nota && (suyo || !c.nombre)) continue;
    await q(`UPDATE contactos SET borrado=false, notas=$2, nombre=CASE WHEN $3 THEN nombre END, cargo=CASE WHEN $3 THEN cargo END WHERE id=$1`, [c.id, visto.contexto, suyo]);
    arreglados++;
  }
  if (arreglados) console.log(`Contactos: ${arreglados} teléfonos recogidos, arreglados.`);
  return arreglados;
}

const ORIGEN = { notas: 'Visto en las notas', lola: 'Llamó a Lola', web: 'Escribió desde la web' };

/** Las personas de una empresa, de mejor a peor para llamar. */
export async function deEmpresa(id) {
  const e = (await q(`SELECT id, telefono, decisor, cargo, notas, dossier FROM empresas WHERE id=$1`, [id])).rows[0];
  if (!e) return [];
  await rescatar(e);
  const filas = (await q(`SELECT id, nombre, cargo, telefono, email, linkedin_url, preferente, decide, notas, origen FROM contactos WHERE empresa_id=$1 AND NOT borrado ORDER BY id`, [id])).rows;
  const puntos = c => (c.preferente ? 1000 : 0) + (c.decide ? 100 : 0) + (c.nombre ? 50 : 0) + (c.telefono && esMovil(c.telefono) ? 20 : 0);
  return filas.map(c => ({ ...c, movil: esMovil(c.telefono) })).sort((a, b) => puntos(b) - puntos(a) || a.id - b.id);
}

/** A quién se puede llamar: las personas, el teléfono general y, al final, los que solo salen en las notas (una tienda, reservas). La primera opción es la que se marca. */
export async function opciones(id) {
  const e = (await q(`SELECT telefono FROM empresas WHERE id=$1`, [id])).rows[0];
  const filas = (await deEmpresa(id)).filter(c => c.telefono);
  const opcion = c => ({ id: c.id, telefono: c.telefono, movil: c.movil, preferente: c.preferente,
    etiqueta: c.nombre || ORIGEN[c.origen] || 'Sin nombre', detalle: c.nombre ? c.cargo || '' : c.notas || '' });
  const suelto = c => !c.nombre && !c.preferente && c.origen === 'notas';
  const lista = filas.filter(c => !suelto(c)).map(opcion);
  const nueva = t => !lista.some(o => clave(o.telefono) === clave(t));
  if (e?.telefono && nueva(e.telefono)) lista.push({ telefono: e.telefono, movil: esMovil(e.telefono), etiqueta: 'Teléfono general de la empresa', detalle: '' });
  for (const c of filas.filter(suelto)) if (nueva(c.telefono)) lista.push(opcion(c));
  return lista;
}

/** Una línea con todos los teléfonos, para los guiones y las tarjetas. */
export async function lineaTelefonos(id) {
  return (await opciones(id)).map(o => `${o.etiqueta}${o.detalle && o.etiqueta !== 'Teléfono general de la empresa' ? ` (${o.detalle})` : ''}: ${o.telefono}`).join('; ');
}

/** Quien decide en la empresa es un contacto marcado (decide). La ficha lleva su nombre y cargo solo para enseñarlos: los escribe esta función.
 *  Si es la misma persona, se completa; si es otra, pasa a ser ella; sin nombre, la empresa se queda sin decisor. */
export async function fijarDecisor(empresa_id, { nombre, cargo } = {}) {
  nombre = String(nombre ?? '').trim().slice(0, 120) || null; cargo = String(cargo ?? '').trim().slice(0, 120) || null;
  if (!nombre) {
    await q(`UPDATE contactos SET decide=false WHERE empresa_id=$1`, [empresa_id]);
    await q(`UPDATE empresas SET decisor=NULL, cargo=NULL WHERE id=$1`, [empresa_id]);
    return null;
  }
  // La misma persona apuntada dos veces: se queda la más completa y la copia vacía (sin teléfono ni correo) se quita
  const mismas = (await q(`SELECT id, nombre, telefono, email FROM contactos WHERE empresa_id=$1 AND NOT borrado AND nombre IS NOT NULL
    ORDER BY preferente DESC, (telefono IS NOT NULL) DESC, (email IS NOT NULL) DESC, decide DESC, id`, [empresa_id])).rows.filter(c => normal(c.nombre) === normal(nombre));
  let id = mismas[0]?.id;
  const vacias = mismas.slice(1).filter(c => !c.telefono && !c.email).map(c => c.id);
  if (vacias.length) await q(`UPDATE contactos SET borrado=true, decide=false, preferente=false WHERE id = ANY($1)`, [vacias]);
  if (!id) id = (await q(`INSERT INTO contactos (empresa_id, nombre, cargo, origen) VALUES ($1,$2,$3,'equipo') RETURNING id`, [empresa_id, nombre, cargo])).rows[0].id;
  await q(`UPDATE contactos SET decide=false WHERE empresa_id=$2 AND decide AND id <> $1`, [id, empresa_id]);   // en dos pasos: la base no deja dos marcadas ni un instante
  await q(`UPDATE contactos SET decide=true WHERE id=$1 AND NOT decide`, [id]);
  const c = (await q(`UPDATE contactos SET cargo=coalesce($2, cargo) WHERE id=$1 RETURNING nombre, cargo`, [id, cargo])).rows[0];
  await q(`UPDATE empresas SET decisor=$2, cargo=$3 WHERE id=$1`, [empresa_id, c.nombre, c.cargo]);
  return id;
}

/** Una vez: cada decisor que solo estaba en la ficha pasa a sus contactos. */
export async function migrarDecisores() {
  for (const e of (await q(`SELECT id, decisor, cargo FROM empresas WHERE coalesce(decisor,'') <> ''`)).rows) await fijarDecisor(e.id, { nombre: e.decisor, cargo: e.cargo });
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
    : (k ? (await q(`SELECT id FROM contactos WHERE empresa_id=$1 AND clave=$2`, [empresa_id, k])).rows[0] : null)
      || (nombre ? (await q(`SELECT id, nombre FROM contactos WHERE empresa_id=$1 AND NOT borrado AND nombre IS NOT NULL AND (telefono IS NULL OR $2::text IS NULL) ORDER BY decide DESC, id`, [empresa_id, k])).rows.find(c => normal(c.nombre) === normal(nombre)) : null);   // la misma persona, aún sin ese teléfono
  let fila;
  if (previo) {
    fila = (await q(`UPDATE contactos SET nombre=coalesce($2,nombre), cargo=coalesce($3,cargo), telefono=coalesce($4,telefono), clave=coalesce($5,clave), email=coalesce($6,email),
                       linkedin_url=coalesce($7,linkedin_url), notas=coalesce($8,notas), borrado=false, origen=$9 WHERE id=$1 RETURNING *`, [previo.id, nombre, cargo, telefono, k, email, linkedin_url, notas, origen])).rows[0];
  } else {
    fila = (await q(`INSERT INTO contactos (empresa_id, nombre, cargo, telefono, clave, email, linkedin_url, notas, origen) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [empresa_id, nombre, cargo, telefono, k, email, linkedin_url, notas, origen])).rows[0];
  }
  if (datos.preferente === true) await hacerPreferente(fila.id);
  if (fila.decide) await q(`UPDATE empresas e SET decisor=c.nombre, cargo=c.cargo FROM contactos c WHERE c.id=$1 AND e.id=c.empresa_id`, [fila.id]);   // la ficha enseña lo de esta persona
  return (await q(`SELECT * FROM contactos WHERE id=$1`, [fila.id])).rows[0];
}

export async function hacerPreferente(id) {
  const c = (await q(`SELECT empresa_id FROM contactos WHERE id=$1`, [id])).rows[0];
  if (!c) throw new Error('Ese contacto ya no existe.');
  await q(`UPDATE contactos SET preferente = (id = $1) WHERE empresa_id=$2`, [id, c.empresa_id]);
}

/** Se marca como quitado en vez de borrarlo: así un número equivocado que sigue en las notas no vuelve a salir. */
export async function quitar(id) {
  const r = await q(`UPDATE contactos SET borrado=true, preferente=false WHERE id=$1 RETURNING id, empresa_id, decide`, [id]);
  if (!r.rows.length) throw new Error('Ese contacto ya no existe.');
  if (r.rows[0].decide) await fijarDecisor(r.rows[0].empresa_id, {});   // era quien decide: la ficha se queda sin decisor
}
