// Acceso a la base de datos comercial (la "memoria común" de los agentes).
import { config } from './config.js';
import { q } from './db.js';
import { emitir, emitirEmbudo } from './bus.js';

export const ORIGENES = ['busqueda', 'web', 'google', 'gestoria', 'asociacion', 'evento', 'recomendacion', 'linkedin', 'redes', 'anuncio', 'telegram', 'whatsapp', 'telefono', 'otro'];
export const ESTADOS = ['nueva', 'puntuada', 'dossier', 'contactada', 'conversacion', 'reunion', 'propuesta', 'ganada', 'perdida', 'descartada'];
const ETAPA = { nueva: 0, puntuada: 1, dossier: 2, contactada: 3, conversacion: 4, reunion: 5, propuesta: 6, ganada: 7 };

const EDITABLES = ['nombre', 'cif', 'web', 'sector', 'municipio', 'empleados', 'facturacion_eur', 'fuente',
  'puntuacion', 'encaje', 'necesidad', 'capacidad', 'acceso', 'categoria', 'confianza',
  'decisor', 'cargo', 'linkedin_url', 'linkedin_empresa', 'email', 'telefono', 'whatsapp', 'direccion', 'instagram', 'facebook', 'google_place_id', 'estado', 'ultimo_contacto', 'proximo_paso', 'fecha_proximo_paso', 'notas', 'dossier', 'origen', 'origen_detalle', 'alianza_id'];

export function normalizar(nombre = '') {
  return nombre.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(s\.?\s?l\.?(u\.?)?|s\.?\s?a\.?|s\.?\s?c\.?)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
export function normalizarWeb(web = '') {
  if (!web) return null;
  return web.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '') || null;
}
const slug = s => normalizar(s).replace(/\s+/g, '-').slice(0, 60) || 'empresa';

export async function leer(id) {
  const r = await q('SELECT * FROM empresas WHERE id=$1', [id]);
  return r.rows[0] || null;
}

export async function listar({ estado, sector, categoria, texto, origen, etapa_min, limite = 30 } = {}) {
  const cond = [], p = [];
  if (etapa_min !== undefined && etapa_min !== '' && !isNaN(Number(etapa_min))) { p.push(Number(etapa_min)); cond.push(`etapa_max >= $${p.length}`); }   // las que han llegado a esa etapa (el embudo)
  if (estado) { p.push(estado); cond.push(`estado = $${p.length}`); }
  if (origen) { p.push(origen); cond.push(`origen = $${p.length}`); }
  if (sector) { p.push(`%${sector}%`); cond.push(`sector ILIKE $${p.length}`); }
  if (categoria) { p.push(categoria); cond.push(`categoria = $${p.length}`); }
  if (texto) { p.push(`%${normalizar(texto)}%`); const a = p.length; p.push(`%${texto.toLowerCase()}%`); cond.push(`(nombre_norm LIKE $${a} OR lower(coalesce(web,'')) LIKE $${p.length})`); }
  p.push(Math.min(Number(limite) || 30, 500));
  const r = await q(`SELECT id, nombre, web, sector, municipio, estado, categoria, puntuacion, confianza, decisor, cargo,
                            email, telefono, whatsapp, linkedin_url, origen, origen_detalle, fecha_proximo_paso, proximo_paso, (dossier IS NOT NULL) AS tiene_dossier, actualizada,
                            (SELECT coalesce(sum(g.usd),0)::float FROM gasto g JOIN tareas t ON t.id = g.tarea_id WHERE t.empresa_id = empresas.id) AS coste_usd
                       FROM empresas ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
                      ORDER BY actualizada DESC LIMIT $${p.length}`, p);
  const cambio = config.usdEur;
  return r.rows.map(x => ({ ...x, coste_eur: Math.round(x.coste_usd * cambio * 100) / 100 }));
}

/** Lo que nos ha costado en IA una empresa: el trabajo hecho sobre ella (puntuar, dossier, mensajes…) por agente,
 *  y la parte de la búsqueda que le toca (lo que costó buscar este mes entre las empresas encontradas). */
export async function coste(id) {
  const cambio = config.usdEur;
  const r = (await q(`SELECT t.agente, sum(g.usd)::float AS usd FROM gasto g JOIN tareas t ON t.id = g.tarea_id WHERE t.empresa_id = $1 GROUP BY 1 ORDER BY 2 DESC`, [id])).rows;
  const b = (await q(`SELECT (SELECT coalesce(sum(usd),0) FROM gasto WHERE agente='lucia' AND ts >= date_trunc('month', now()))::float AS usd,
                             (SELECT count(*) FROM empresas WHERE origen='busqueda' AND creada >= date_trunc('month', now()))::int AS n`)).rows[0];
  const eur = v => Math.round(v * cambio * 1000) / 1000;
  const trabajo = r.reduce((a, x) => a + x.usd, 0);
  return { eur: Math.round(trabajo * cambio * 100) / 100, por_agente: r.map(x => ({ agente: x.agente, eur: eur(x.usd) })), busqueda_eur: b.n ? eur(b.usd / b.n) : 0 };
}

/** Crea empresas nuevas. Devuelve {creadas:[{id,nombre}], duplicadas:[nombre]} */
export async function crear(lista = []) {
  const creadas = [], duplicadas = [];
  for (const e of lista) {
    if (!e?.nombre) continue;
    const norm = normalizar(e.nombre), web = normalizarWeb(e.web);
    const dup = await q(`SELECT id FROM empresas WHERE nombre_norm=$1 ${web ? 'OR lower(web)=$2' : ''} LIMIT 1`, web ? [norm, web] : [norm]);
    if (dup.rows.length) { duplicadas.push(e.nombre); continue; }
    let id = slug(e.nombre);
    for (let i = 2; (await q('SELECT 1 FROM empresas WHERE id=$1', [id])).rows.length; i++) id = `${slug(e.nombre)}-${i}`;
    const li = repartirLinkedin(e);
    const origen = ORIGENES.includes(e.origen) ? e.origen : 'busqueda';
    await q(`INSERT INTO empresas (id, nombre, nombre_norm, cif, web, sector, municipio, empleados, facturacion_eur, fuente, decisor, cargo, linkedin_url, notas, linkedin_empresa, email, telefono, whatsapp, origen, origen_detalle, alianza_id, direccion, instagram, facebook, google_place_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
      [id, e.nombre.trim(), norm, e.cif || null, web, e.sector || null, e.municipio || null,
        Number.isFinite(+e.empleados) && e.empleados !== '' && e.empleados != null ? Math.round(+e.empleados) : null,
        Number.isFinite(+e.facturacion_eur) && e.facturacion_eur != null && e.facturacion_eur !== '' ? +e.facturacion_eur : null,
        e.fuente || null, e.decisor || null, e.cargo || null, li.linkedin_url || null, e.notas || null,
        li.linkedin_empresa || null, e.email || null, e.telefono || null, e.whatsapp || null, origen, e.origen_detalle || null, Number.isInteger(+e.alianza_id) && e.alianza_id ? +e.alianza_id : null, e.direccion || null, e.instagram || null, e.facebook || null, e.google_place_id || null]);
    creadas.push({ id, nombre: e.nombre.trim() });
  }
  if (creadas.length) await emitirEmbudo();
  return { creadas, duplicadas };
}

/** Actualiza campos permitidos. Mantiene etapa_max (lo más lejos que ha llegado en el embudo). */
/** Una página de empresa nunca va en el campo del perfil del decisor. */
const conHttps = u => { const t = String(u || '').trim(); if (!t) return t; return /^https?:\/\//i.test(t) ? t.replace(/^http:/i, 'https:') : 'https://' + t.replace(/^\/+/, ''); };
function repartirLinkedin(c) {
  const out = { ...c };
  for (const k of ['linkedin_url', 'linkedin_empresa']) if (out[k]) out[k] = conHttps(out[k]);
  if (out.linkedin_url && /linkedin\.com\/(company|school|showcase)\//i.test(out.linkedin_url)) {
    if (!out.linkedin_empresa) out.linkedin_empresa = out.linkedin_url;
    out.linkedin_url = null;
  }
  return out;
}

export async function actualizar(id, campos = {}, { desdeAgente = false } = {}) {
  if ('linkedin_url' in campos || 'linkedin_empresa' in campos) campos = repartirLinkedin(campos);
  const actual = await leer(id);
  if (!actual) throw new Error(`No existe la empresa ${id}`);
  if (desdeAgente && campos.estado && ETAPA[campos.estado] !== undefined && ETAPA[campos.estado] < (ETAPA[actual.estado] ?? 0)) {
    campos = { ...campos }; delete campos.estado;   // un agente no puede devolver una empresa a una etapa anterior
  }
  const sets = [], p = [];
  for (const [k, v] of Object.entries(campos)) {
    if (!EDITABLES.includes(k)) continue;
    if (k === 'estado' && !ESTADOS.includes(v)) throw new Error(`Estado no válido: ${v}. Usa uno de: ${ESTADOS.join(', ')}`);
    if (k === 'categoria' && v && !['A', 'B', 'C', 'D'].includes(v)) throw new Error('La categoría debe ser A, B, C o D');
    if (k === 'origen' && !ORIGENES.includes(v)) throw new Error(`Origen no válido: ${v}. Usa uno de: ${ORIGENES.join(', ')}`);
    p.push(k === 'web' ? normalizarWeb(v) : (v === '' ? null : v));
    sets.push(`${k} = $${p.length}`);
    if (k === 'nombre') { p.push(normalizar(v)); sets.push(`nombre_norm = $${p.length}`); }
  }
  if (campos.estado && ETAPA[campos.estado] !== undefined) {
    p.push(ETAPA[campos.estado]); sets.push(`etapa_max = GREATEST(etapa_max, $${p.length})`);
  }
  if (!sets.length) return actual;
  p.push(id);
  const r = await q(`UPDATE empresas SET ${sets.join(', ')}, actualizada = now() WHERE id = $${p.length} RETURNING *`, p);
  const nueva = r.rows[0];
  if (campos.estado === 'ganada' && actual.estado !== 'ganada') await emitir({ tipo: 'cliente', empresa: nueva.nombre });
  // Primera vez que llega a esta etapa: cuenta para el premio del mes
  if (campos.estado && ETAPA[campos.estado] >= 4 && ETAPA[campos.estado] > (actual.etapa_max ?? 0)) await emitir({ tipo: 'avance', empresa_id: id, empresa: nueva.nombre, estado: campos.estado, origen: nueva.origen });
  if (campos.estado && campos.estado !== actual.estado) await emitirEmbudo();
  return nueva;
}

export async function seguimientosVencidos() {
  const r = await q(`SELECT id, nombre, estado, proximo_paso, fecha_proximo_paso FROM empresas
                      WHERE fecha_proximo_paso <= CURRENT_DATE AND estado IN ('contactada','conversacion','reunion','propuesta','ganada')
                        AND NOT EXISTS (SELECT 1 FROM secuencias s WHERE s.empresa_id = empresas.id AND s.estado IN ('activa','aparcada'))
                      ORDER BY fecha_proximo_paso`);
  return r.rows;
}

const COLUMNAS_CSV = ['id', 'nombre', 'cif', 'web', 'sector', 'municipio', 'empleados', 'facturacion_eur', 'fuente', 'fecha_alta',
  'puntuacion', 'encaje', 'necesidad', 'capacidad', 'acceso', 'categoria', 'decisor', 'cargo', 'linkedin_url', 'email', 'telefono', 'whatsapp', 'direccion', 'instagram', 'facebook',
  'estado', 'origen', 'origen_detalle', 'ultimo_contacto', 'proximo_paso', 'fecha_proximo_paso', 'notas'];
export async function csv() {
  const r = await q(`SELECT ${COLUMNAS_CSV.join(',')} FROM empresas ORDER BY fecha_alta, nombre`);
  const esc = v => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [COLUMNAS_CSV.join(','), ...r.rows.map(f => COLUMNAS_CSV.map(c => esc(f[c])).join(','))].join('\n') + '\n';
}

/** Lee un CSV (separado por «,» o «;», con comillas al estilo de Excel). Devuelve las filas como listas de textos. */
export function leerCsv(texto) {
  const t = String(texto || '').replace(/^\uFEFF/, '');
  const primera = t.split(/\r?\n/, 1)[0];
  const sep = (primera.match(/;/g) || []).length > (primera.match(/,/g) || []).length ? ';' : ',';
  const filas = []; let fila = [], campo = '', entreComillas = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (entreComillas) {
      if (c !== '"') campo += c;
      else if (t[i + 1] === '"') { campo += '"'; i++; }
      else entreComillas = false;
    } else if (c === '"') entreComillas = true;
    else if (c === sep) { fila.push(campo); campo = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++;
      fila.push(campo); filas.push(fila); fila = []; campo = '';
    } else campo += c;
  }
  if (campo || fila.length) { fila.push(campo); filas.push(fila); }
  return filas;
}

export const MAX_IMPORTAR = 2000;
const ESTADOS_IMPORTAR = ['ganada', 'conversacion', 'nueva'];
// Columnas que se reconocen en la cabecera (comparadas en minúsculas y sin acentos ni signos: «Teléfono» vale). «persona» va a decisor.
const COLUMNAS_IMPORTAR = { nombre: 'nombre', name: 'nombre', persona: 'decisor', decisor: 'decisor', contact: 'decisor', cargo: 'cargo', role: 'cargo', email: 'email',
  telefono: 'telefono', phone: 'telefono', whatsapp: 'whatsapp', web: 'web', website: 'web', municipio: 'municipio', city: 'municipio', sector: 'sector', notas: 'notas', notes: 'notas' };

/** Importa la cartera de una empresa desde un CSV. Una fila sin nombre está mal; las que ya existen (mismo nombre o web) se cuentan como repetidas.
 *  Los clientes y los contactos con permiso entran ya en su estado, sin fiesta ni puntos: no son avances del equipo. */
export async function importar(texto, estado) {
  if (!ESTADOS_IMPORTAR.includes(estado)) throw new Error(`Di qué es la lista: ${ESTADOS_IMPORTAR.join(', ')}.`);
  const [cabecera = [], ...filas] = leerCsv(texto);
  const cols = cabecera.map(c => COLUMNAS_IMPORTAR[c.toLowerCase().normalize('NFD').replace(/[^a-z]/g, '')] || null);
  if (!cols.includes('nombre')) throw new Error('La primera fila tiene que llevar los nombres de las columnas, y una de ellas «nombre».');
  if (filas.length > MAX_IMPORTAR) throw new Error(`Como mucho ${MAX_IMPORTAR} filas por archivo (este tiene ${filas.length}): pártelo en varios.`);
  const lista = []; let mal = 0;
  for (const f of filas) {
    if (f.every(v => !v.trim())) continue;   // líneas en blanco
    const e = {};
    cols.forEach((k, i) => { if (k && f[i]?.trim()) e[k] = f[i].trim(); });
    if (!e.nombre) { mal++; continue; }
    lista.push({ ...e, origen: 'otro', origen_detalle: 'Importada de la cartera' });
  }
  const r = await crear(lista);
  if (r.creadas.length && estado !== 'nueva') {
    await q(`UPDATE empresas SET estado=$1, etapa_max=GREATEST(etapa_max,$2), actualizada=now() WHERE id = ANY($3)`, [estado, ETAPA[estado], r.creadas.map(e => e.id)]);
    await emitirEmbudo();
  }
  return { importadas: r.creadas.length, repetidas: r.duplicadas.length, mal };
}

/** Todo lo que ha pasado con una empresa: tareas, mensajes preparados y actividad. */
export async function historial(id) {
  const e = await leer(id);
  if (!e) return null;
  const [tareas, aprob, eventos, llamadas] = await Promise.all([
    q(`SELECT id, agente, tipo, instruccion, estado, resultado, creada, terminada FROM tareas WHERE empresa_id=$1 ORDER BY creada`, [id]),
    q(`SELECT id, agente, tipo, titulo, texto, estado, creada, resuelta FROM aprobaciones WHERE empresa_id=$1 ORDER BY creada`, [id]),
    q(`SELECT ts, datos FROM eventos WHERE datos->>'tipo'='log' AND (datos->>'empresa_id' = $3 OR datos->>'texto' ILIKE $1 OR datos->>'texto' ILIKE $2) ORDER BY ts`, [`%${e.nombre}%`, `%${e.id}%`, e.id]),
    // Llamadas: las tuyas por la centralita (con resumen y transcripción) y las que atendió Lola en el teléfono
    q(`SELECT * FROM (SELECT 'centralita' AS via, coalesce(inicio, creada) AS cuando, segundos, tipo, resumen, transcripcion, NULL::text AS nombre, NULL::int AS llamada_id, estado, motivo FROM llamadas WHERE empresa_id=$1
        UNION ALL SELECT 'lola', creada, segundos, 'in', coalesce(nullif(resumen,''), motivo), transcripcion, nombre, id, NULL, NULL FROM llamadas_voz WHERE empresa_id=$1) x ORDER BY cuando DESC LIMIT 20`, [id]),
  ]);
  return { tareas: tareas.rows, mensajes: aprob.rows, llamadas: llamadas.rows, actividad: eventos.rows.map(r => ({ ts: r.ts, agente: r.datos.agente, texto: r.datos.texto, aprobacion_id: r.datos.aprobacion_id || null, informe_id: r.datos.informe_id || null, url: r.datos.url || null, llamada_id: r.datos.llamada_id || null })) };
}

/** La ficha con todo lo que ha pasado, recortado para que quepa en una tarea. Lo que lee un agente; el panel usa historial() entero. */
export async function expediente(id) {
  const e = await leer(id);
  if (!e) return null;
  const h = await historial(id);
  const c = (t, n) => (t != null && String(t).length > n ? String(t).slice(0, n) + '…' : t);
  const contactos = await (await import('./contactos.js')).deEmpresa(id);
  return { ...e, contactos, historial: {
    encargos: h.tareas.slice(-10).map(t => ({ agente: t.agente, encargo: c(t.instruccion, 160), estado: t.estado, resultado: c(t.resultado, 300), cuando: t.terminada || t.creada })),
    mensajes: h.mensajes.slice(-8).map(m => ({ agente: m.agente, tipo: m.tipo, titulo: c(m.titulo, 120), texto: c(m.texto, 400), estado: m.estado, cuando: m.resuelta || m.creada })),
    llamadas: h.llamadas.slice(0, 5).map(l => ({ via: l.via, cuando: l.cuando, resumen: c(l.resumen, 1500) })),
    actividad: h.actividad.slice(-10).map(a => ({ agente: a.agente, texto: c(a.texto, 200), cuando: a.ts })),
  } };
}

/** Embudo por canal: cuántas empresas de cada origen han llegado a cada etapa. */
export async function embudoPorOrigen() {
  const r = await q(`SELECT origen,
      count(*)::int                                 AS total,
      count(*) FILTER (WHERE etapa_max >= 3)::int   AS contactadas,
      count(*) FILTER (WHERE etapa_max >= 4)::int   AS conversacion,
      count(*) FILTER (WHERE etapa_max >= 5)::int   AS reunion,
      count(*) FILTER (WHERE etapa_max >= 6)::int   AS propuesta,
      count(*) FILTER (WHERE etapa_max >= 7)::int   AS ganadas,
      count(*) FILTER (WHERE creada > now() - interval '30 days')::int AS ultimos_30_dias
    FROM empresas GROUP BY origen ORDER BY conversacion DESC, total DESC`);
  return r.rows;
}
