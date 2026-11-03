// Cómo se adapta el equipo a Dirección: reglas fijas (/regla) y correcciones a trabajos (Pedir cambios).
import { q } from './db.js';

export async function nuevaRegla(texto, agente = null, { activa = true } = {}) {
  const r = await q(`INSERT INTO aprendizajes (agente, tipo, texto, activo) VALUES ($1,'regla',$2,$3) RETURNING *`, [agente, texto.trim(), activa]);
  return r.rows[0];
}
export async function nuevaCorreccion(agente, texto) {
  await q(`INSERT INTO aprendizajes (agente, tipo, texto) VALUES ($1,'correccion',$2)`, [agente, texto.trim()]);
}
export async function reglas() {
  const r = await q(`SELECT id, agente, texto, creada FROM aprendizajes WHERE tipo='regla' AND activo ORDER BY id`);
  return r.rows;
}
export async function quitar(id) {
  const r = await q(`UPDATE aprendizajes SET activo=false WHERE id=$1 AND activo RETURNING id`, [id]);
  return r.rows.length > 0;
}

/** Bloque de texto que se añade a las instrucciones del agente en cada tarea. */
export async function paraPrompt(agente) {
  const [rg, cor] = await Promise.all([
    q(`SELECT texto FROM aprendizajes WHERE tipo='regla' AND activo AND (agente IS NULL OR agente=$1) ORDER BY id`, [agente]),
    q(`SELECT texto FROM aprendizajes WHERE tipo='correccion' AND activo AND agente=$1 ORDER BY id DESC LIMIT 15`, [agente]),
  ]);
  const gr = await q(`SELECT texto FROM aprendizajes WHERE tipo='gracias' AND agente=$1 ORDER BY id DESC LIMIT 5`, [agente]);
  if (!rg.rows.length && !cor.rows.length && !gr.rows.length) return '';
  let t = '## Cómo quiere Dirección que trabajes (prevalece sobre lo anterior)\n';
  if (rg.rows.length) t += 'Reglas fijas:\n' + rg.rows.map(r => `- ${r.texto}`).join('\n') + '\n';
  if (cor.rows.length) t += 'Correcciones que te ha hecho en trabajos anteriores (aplícalas siempre):\n' + cor.rows.reverse().map(r => `- ${r.texto}`).join('\n') + '\n';
  if (gr.rows.length) t += 'Lo que Dirección te ha agradecido últimamente (es lo que valora; sigue en esa línea):\n' + gr.rows.reverse().map(r => `- ${r.texto}`).join('\n') + '\n';
  return t;
}

export async function gracias(agente, motivo) {
  await q(`INSERT INTO aprendizajes (agente, tipo, texto) VALUES ($1,'gracias',$2)`, [agente, motivo?.trim() || 'Buen trabajo en general']);
  const r = await q(`SELECT count(*)::int n FROM aprendizajes WHERE tipo='gracias' AND agente=$1`, [agente]);
  return r.rows[0].n;
}

export async function contadorGracias() {
  const r = await q(`SELECT agente, count(*)::int n FROM aprendizajes WHERE tipo='gracias' GROUP BY agente`);
  return Object.fromEntries(r.rows.map(x => [x.agente, x.n]));
}

export async function activar(id) {
  const r = await q(`UPDATE aprendizajes SET activo=true WHERE id=$1 AND tipo='regla' RETURNING *`, [id]);
  return r.rows[0] || null;
}
