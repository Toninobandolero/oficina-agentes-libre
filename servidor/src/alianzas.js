// Alianzas que lleva Marta: gestorías y asesorías (nos recomiendan), asociaciones y eventos (donde está el cliente).
import { q } from './db.js';
import { normalizar, normalizarWeb } from './empresas.js';

export const TIPOS = ['gestoria', 'asociacion', 'evento', 'otro'];
export const ESTADOS = ['identificada', 'contactada', 'reunion', 'acuerdo', 'apuntado', 'asistido', 'descartada'];
const CAMPOS = ['nombre', 'web', 'municipio', 'contacto', 'cargo', 'email', 'telefono', 'linkedin_url', 'fecha', 'lugar', 'estado', 'notas', 'fuente', 'proximo_paso', 'fecha_proximo_paso'];
const fecha = f => (/^\d{4}-\d{2}-\d{2}$/.test(String(f || '')) ? f : null);

export async function guardar(lista = []) {
  const creadas = [], duplicadas = [];
  for (const a of lista) {
    if (!a?.nombre || !TIPOS.includes(a.tipo)) continue;
    const norm = normalizar(a.nombre);
    const r = await q(`INSERT INTO alianzas (tipo, nombre, nombre_norm, web, municipio, contacto, cargo, email, telefono, linkedin_url, fecha, lugar, notas, fuente)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (tipo, nombre_norm) DO NOTHING RETURNING id, nombre`,
      [a.tipo, a.nombre.trim(), norm, normalizarWeb(a.web), a.municipio || null, a.contacto || null, a.cargo || null, a.email || null, a.telefono || null,
        a.linkedin_url || null, fecha(a.fecha), a.lugar || null, a.notas || null, a.fuente || null]);
    if (r.rows.length) creadas.push(r.rows[0]); else duplicadas.push(a.nombre);
  }
  return { creadas, duplicadas };
}

export async function listar({ tipo, estado, texto, limite = 40 } = {}) {
  const cond = [], p = [];
  if (tipo) { p.push(tipo); cond.push(`tipo = $${p.length}`); }
  if (estado) { p.push(estado); cond.push(`estado = $${p.length}`); }
  if (texto) { p.push(`%${normalizar(texto)}%`); cond.push(`nombre_norm LIKE $${p.length}`); }
  p.push(Math.min(Number(limite) || 40, 200));
  const r = await q(`SELECT a.*, (SELECT count(*)::int FROM empresas e WHERE e.alianza_id = a.id) AS clientes_referidos
                       FROM alianzas a ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
                      ORDER BY (tipo = 'evento' AND fecha >= CURRENT_DATE) DESC, fecha NULLS LAST, actualizada DESC LIMIT $${p.length}`, p);
  return r.rows;
}

export async function actualizar(id, campos = {}) {
  const sets = [], p = [];
  for (const [k, v] of Object.entries(campos)) {
    if (!CAMPOS.includes(k)) continue;
    if (k === 'estado' && !ESTADOS.includes(v)) throw new Error(`Estado no válido. Usa uno de: ${ESTADOS.join(', ')}`);
    p.push(['fecha', 'fecha_proximo_paso'].includes(k) ? fecha(v) : k === 'web' ? normalizarWeb(v) : (v === '' ? null : v));
    sets.push(`${k} = $${p.length}`);
    if (k === 'nombre') { p.push(normalizar(v)); sets.push(`nombre_norm = $${p.length}`); }
  }
  if (!sets.length) throw new Error('Nada que actualizar');
  p.push(Number(id));
  const r = await q(`UPDATE alianzas SET ${sets.join(', ')}, actualizada = now() WHERE id = $${p.length} RETURNING *`, p);
  if (!r.rows.length) throw new Error(`No existe la alianza ${id}`);
  return r.rows[0];
}

/** Próximos eventos (para la agenda de la pantalla). */
export async function proximosEventos(limite = 3) {
  return (await q(`SELECT nombre, fecha::text AS fecha, lugar FROM alianzas WHERE tipo='evento' AND fecha >= CURRENT_DATE AND estado <> 'descartada' ORDER BY fecha LIMIT $1`, [limite])).rows;
}

export async function resumen() {
  return (await q(`SELECT tipo, estado, count(*)::int n FROM alianzas GROUP BY 1, 2 ORDER BY 1, 2`)).rows;
}
