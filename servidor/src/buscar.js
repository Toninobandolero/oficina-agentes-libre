// Buscador general del panel: una empresa, una persona, un correo, un teléfono o una palabra, y todo lo que hay de ello en la oficina.
// De cada empresa que encaja se trae lo que ha pasado con ella (correos, llamadas, personas, tarjetas y calendario).
import { q } from './db.js';
import { respondido } from './correo.js';

// Sin tildes ni mayúsculas, a los dos lados: «Madrid» encuentra «madrid»
const N = col => `translate(lower(coalesce(${col}, '')), 'áéíóúüàèìòùñç', 'aeiouuaeiounc')`;
const norm = t => t.toLowerCase().replace(/[áàä]/g, 'a').replace(/[éèë]/g, 'e').replace(/[íìï]/g, 'i').replace(/[óòö]/g, 'o').replace(/[úùü]/g, 'u').replace(/ñ/g, 'n').replace(/ç/g, 'c');

const MAX_EMPRESAS = 5;

export async function buscar(texto) {
  const t = String(texto || '').trim().slice(0, 100);
  const vacio = { empresas: [], personas: [], correos: [], llamadas: [], tarjetas: [] };
  if (t.length < 2) return vacio;
  const like = `%${norm(t).replace(/[\\%_]/g, '\\$&')}%`;
  const cifras = t.replace(/\D/g, '');
  const tel = cifras.length >= 6 ? `%${cifras.slice(-9)}%` : null;   // un teléfono, con o sin prefijo y espacios
  const telDe = col => `regexp_replace(coalesce(${col}, ''), '\\D', '', 'g') LIKE $2`;

  const empresas = (await q(`SELECT e.id, e.nombre, e.estado, e.sector, e.municipio, e.web, e.email, e.telefono, e.decisor, e.ultimo_contacto, e.proximo_paso, e.fecha_proximo_paso
      FROM empresas e
     WHERE ${N('e.nombre')} LIKE $1 OR ${N('e.web')} LIKE $1 OR ${N('e.email')} LIKE $1 OR ${N('e.decisor')} LIKE $1 OR ${N('e.cif')} LIKE $1
        OR ($2::text IS NOT NULL AND ${telDe('e.telefono')})
        OR EXISTS (SELECT 1 FROM contactos c WHERE c.empresa_id = e.id AND NOT c.borrado AND (${N('c.nombre')} LIKE $1 OR ${N('c.email')} LIKE $1 OR ($2::text IS NOT NULL AND ${telDe('c.telefono')})))
        OR EXISTS (SELECT 1 FROM correos k WHERE k.empresa_id = e.id AND (${N('k.para')} LIKE $1 OR ${N('k.de')} LIKE $1))
     ORDER BY (${N('e.nombre')} LIKE $3) DESC, e.actualizada DESC NULLS LAST LIMIT ${MAX_EMPRESAS}`, [like, tel, `${norm(t)}%`])).rows;
  const ids = empresas.map(e => e.id);

  // Todo lo de esas empresas, de una vez
  if (ids.length) {
    const [correos, llamadas, contactos, tarjetas, citas] = await Promise.all([
      q(`SELECT c.id, c.empresa_id, c.direccion, c.de, c.para, c.asunto, left(c.texto, 3000) AS texto, coalesce(c.enviado, c.creada) AS fecha, a.id AS aprobacion, ${respondido('c')}
           FROM correos c LEFT JOIN aprobaciones a ON c.direccion = 'borrador' AND a.ref = 'correo:' || c.id AND a.estado = 'pendiente'
          WHERE c.empresa_id = ANY($1) AND (c.direccion IN ('entrada', 'salida') OR a.id IS NOT NULL) ORDER BY coalesce(c.enviado, c.creada) DESC`, [ids]),
      q(`SELECT call_id AS id, empresa_id, coalesce(inicio, creada) AS fecha, segundos, resultado, estado, left(resumen, 1500) AS resumen, NULL AS via FROM llamadas WHERE empresa_id = ANY($1)
         UNION ALL SELECT id::text, empresa_id, creada, segundos, 'te_llamo', 'hecha', left(coalesce(resumen, motivo), 1500), 'lola' FROM llamadas_voz WHERE empresa_id = ANY($1) AND NOT dudosa
         ORDER BY fecha DESC`, [ids]),
      q(`SELECT id, empresa_id, nombre, cargo, email, telefono, decide FROM contactos WHERE empresa_id = ANY($1) AND NOT borrado ORDER BY decide DESC NULLS LAST, preferente DESC, id`, [ids]),
      q(`SELECT id, empresa_id, agente, tipo, titulo, creada FROM aprobaciones WHERE empresa_id = ANY($1) AND estado = 'pendiente' ORDER BY creada DESC`, [ids]),
      q(`SELECT id, empresa_id, dia::text AS dia, hora, texto, clase FROM recordatorios WHERE empresa_id = ANY($1) AND hecho IS NULL ORDER BY dia, hora`, [ids]),
    ]);
    const de = (r, id) => r.rows.filter(x => x.empresa_id === id);
    for (const e of empresas) Object.assign(e, { correos: de(correos, e.id), llamadas: de(llamadas, e.id), contactos: de(contactos, e.id), tarjetas: de(tarjetas, e.id), citas: de(citas, e.id) });
  }

  // Lo que encaja fuera de esas empresas: personas, correos, llamadas y tarjetas
  const fuera = (col, n = 3) => `(${col} IS NULL OR NOT (${col} = ANY($${n})))`;
  const [personas, correos, llamadas, tarjetas] = await Promise.all([
    q(`SELECT c.id, c.nombre, c.cargo, c.email, c.telefono, c.empresa_id, e.nombre AS empresa FROM contactos c LEFT JOIN empresas e ON e.id = c.empresa_id
        WHERE NOT c.borrado AND (${N('c.nombre')} LIKE $1 OR ${N('c.email')} LIKE $1 OR ${N('c.cargo')} LIKE $1 OR ($2::text IS NOT NULL AND ${telDe('c.telefono')})) AND ${fuera('c.empresa_id')}
        ORDER BY c.nombre LIMIT 10`, [like, tel, ids]),
    q(`SELECT c.id, c.direccion, c.de, c.para, c.asunto, left(c.texto, 3000) AS texto, coalesce(c.enviado, c.creada) AS fecha, c.empresa_id, e.nombre AS empresa, a.id AS aprobacion, ${respondido('c')}
         FROM correos c LEFT JOIN empresas e ON e.id = c.empresa_id LEFT JOIN aprobaciones a ON c.direccion = 'borrador' AND a.ref = 'correo:' || c.id AND a.estado = 'pendiente'
        WHERE (c.direccion IN ('entrada', 'salida') OR a.id IS NOT NULL) AND ${fuera('c.empresa_id', 2)}
          AND (${N('c.asunto')} LIKE $1 OR ${N('c.para')} LIKE $1 OR ${N('c.de')} LIKE $1 OR ${N('c.texto')} LIKE $1)
        ORDER BY coalesce(c.enviado, c.creada) DESC LIMIT 15`, [like, ids]),
    q(`SELECT l.call_id AS id, coalesce(l.inicio, l.creada) AS fecha, l.segundos, l.resultado, left(l.resumen, 1500) AS resumen, l.numero, l.empresa_id, e.nombre AS empresa
         FROM llamadas l LEFT JOIN empresas e ON e.id = l.empresa_id
        WHERE ${fuera('l.empresa_id')} AND (${N('l.resumen')} LIKE $1 OR ($2::text IS NOT NULL AND ${telDe('l.numero')}))
        ORDER BY coalesce(l.inicio, l.creada) DESC LIMIT 10`, [like, tel, ids]),
    q(`SELECT a.id, a.agente, a.tipo, a.titulo, a.creada, a.empresa_id, e.nombre AS empresa FROM aprobaciones a LEFT JOIN empresas e ON e.id = a.empresa_id
        WHERE a.estado = 'pendiente' AND ${fuera('a.empresa_id', 2)} AND (${N('a.titulo')} LIKE $1 OR ${N('a.texto')} LIKE $1)
        ORDER BY a.creada DESC LIMIT 10`, [like, ids]),
  ]);
  return { empresas, personas: personas.rows, correos: correos.rows, llamadas: llamadas.rows, tarjetas: tarjetas.rows };
}
