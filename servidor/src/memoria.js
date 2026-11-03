// Memoria de los agentes: su libreta, sus últimos trabajos y (para Álex) lo ya publicado.
import { q } from './db.js';

export async function apuntar(agente, texto) {
  const r = await q(`INSERT INTO memoria (agente, texto) VALUES ($1, $2) RETURNING id`, [agente, String(texto).trim().slice(0, 600)]);
  // La libreta no crece sin fin: se conservan las 60 notas más recientes de cada agente
  await q(`UPDATE memoria SET activa=false WHERE agente=$1 AND activa AND id NOT IN (SELECT id FROM memoria WHERE agente=$1 AND activa ORDER BY creada DESC LIMIT 60)`, [agente]);
  return r.rows[0].id;
}

export async function olvidar(agente, id) {
  const r = await q(`UPDATE memoria SET activa=false WHERE id=$1 AND agente=$2 AND activa RETURNING id`, [id, agente]);
  return r.rows.length > 0;
}

export async function publicar({ aprobacion_id, agente, titulo, texto, canal = 'linkedin', formato = 'post', enlace = null }) {
  await q(`INSERT INTO publicaciones (aprobacion_id, agente, titulo, texto, canal, formato, enlace) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [aprobacion_id, agente, titulo, texto, canal, formato, enlace]);
}

export async function publicaciones(limite = 40) {
  const r = await q(`SELECT id, agente, titulo, left(texto, 400) AS inicio, canal, formato, enlace, publicada FROM publicaciones ORDER BY publicada DESC, id DESC LIMIT $1`, [limite]);
  return r.rows;
}

/** Bloque de memoria que el agente lee al empezar cada tarea. */
export async function paraPrompt(agente) {
  const [notas, hechas] = await Promise.all([
    q(`SELECT id, texto, creada FROM memoria WHERE agente=$1 AND activa ORDER BY creada DESC LIMIT 20`, [agente]),
    q(`SELECT instruccion, left(coalesce(resultado,''), 220) AS resultado, terminada FROM tareas WHERE agente=$1 AND estado='hecha' AND tipo='trabajo' ORDER BY terminada DESC LIMIT 8`, [agente]),
  ]);
  const charlas = await q(`SELECT left(instruccion, 300) AS pregunta, left(coalesce(resultado,''), 300) AS respuesta, terminada FROM tareas WHERE agente=$1 AND estado='hecha' AND tipo='pregunta' ORDER BY terminada DESC LIMIT 6`, [agente]);
  const f = d => new Date(d).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
  let t = '';
  if (notas.rows.length) t += 'Tu libreta (notas que te dejaste; olvida las que ya no sirvan con olvidar_nota):\n' + notas.rows.reverse().map(n => `- [${n.id}, ${f(n.creada)}] ${n.texto}`).join('\n') + '\n';
  if (charlas.rows.length) t += 'Lo último que has hablado con Dirección (acuérdate y sé coherente):\n' + charlas.rows.reverse().map(c => `- ${f(c.terminada)} Dirección: «${c.pregunta.split('\n')[0]}» → tú: «${c.respuesta.replace(/\s+/g, ' ')}»`).join('\n') + '\n';
  if (hechas.rows.length) t += 'Tus últimos trabajos:\n' + hechas.rows.map(h => `- ${f(h.terminada)}: ${h.instruccion.split('\n')[0].slice(0, 120)} → ${h.resultado.replace(/\s+/g, ' ')}`).join('\n') + '\n';
  if (agente === 'alex' || agente === 'leo') {
    const [pub, pend] = await Promise.all([
      publicaciones(40),
      q(`SELECT a.titulo, a.canal, a.fecha_prevista, a.tipo, octet_length(v.mp4) AS video FROM aprobaciones a LEFT JOIN videos v ON v.aprobacion_id=a.id WHERE a.tipo IN ('post','video','articulo','boletin','anuncio') AND a.estado='pendiente' ORDER BY a.creada`),
    ]);
    const prog = (await q(`SELECT titulo, canal, tambien, coalesce(publicar_en, ((fecha_prevista + time '09:00') AT TIME ZONE 'Europe/Madrid')) cuando FROM aprobaciones WHERE estado IN ('programada','externa') ORDER BY 4`)).rows;
    if (prog.length) t += 'Calendario: posts YA PROGRAMADOS por Dirección (no pongas otro en la misma red el mismo día; deja al menos un día entre posts):\n' + prog.map(p => `- ${new Date(p.cuando).toLocaleString('es-ES', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' })} · ${p.canal}${p.tambien ? ' + ' + p.tambien : ''} · ${p.titulo}`).join('\n') + '\n';
    t += pub.length
      ? 'Lo que Dirección YA HA PUBLICADO (no repitas temas ni enfoques; puedes hacer continuaciones o series):\n' + pub.map(p => `- ${f(p.publicada)} · [${p.formato || 'post'} · ${p.canal}] ${p.titulo} — «${p.inicio.replace(/\s+/g, ' ').slice(0, 160)}…»`).join('\n') + '\n'
      : 'Dirección todavía no ha publicado nada preparado por ti.\n';
    if (pend.rows.length) t += 'Contenido que espera en la mesa de Dirección (no lo dupliques):\n' + pend.rows.map(p => `- [${p.canal || '—'}${p.fecha_prevista ? ' · ' + new Date(p.fecha_prevista).toISOString().slice(0, 10) : ''}] ${p.titulo}${p.tipo === 'video' ? (p.video ? ' (vídeo generado, sin publicar)' : ' (guion: aún no hay vídeo)') : ''}`).join('\n') + '\n';
  }
  return t ? `## Tu memoria\n${t}` : '';
}
