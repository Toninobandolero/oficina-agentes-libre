// Líneas de venta: cada cosa que vende la oficina, a quién y a qué ritmo. Cada empresa lleva la suya; sin ella, es de la principal.
// La principal es lo de siempre: lo que dice la ficha de la empresa (Mi empresa) y el objetivo de búsqueda. Las demás llevan su oferta y su ritmo,
// y así Lucía busca para cada una, Mateo puntúa con su cliente ideal y Javi escribe con su oferta, sin mezclar.
import { q } from './db.js';
import { emitir } from './bus.js';
import { T } from './en.js';

const MAX_ACTIVAS = 3;
let lista = [];
const recargar = async () => { lista = (await q(`SELECT * FROM lineas ORDER BY principal DESC, id`)).rows; };
/** Al arrancar: siempre hay una principal (la de la ficha de la empresa). */
export async function cargar() {
  await q(`INSERT INTO lineas (nombre, principal) SELECT 'Lo principal', true WHERE NOT EXISTS (SELECT 1 FROM lineas WHERE principal)`);
  await recargar();
}
export const listar = () => lista;
export const principal = () => lista.find(l => l.principal);
export const porId = id => lista.find(l => l.id === Number(id)) || null;
const otrasActivas = () => lista.filter(l => l.activa && !l.principal);
/** De qué línea es una empresa: la suya, o la principal si no tiene (o la suya ya no existe). */
export const deEmpresa = e => porId(e?.linea_id) || principal();

const txt = (v, n) => String(v ?? '').trim().slice(0, n);
/** Crea o cambia una línea. De la principal solo se cambia el nombre: lo demás es la ficha de la empresa y el objetivo de búsqueda. */
export async function guardar(d = {}) {
  const nombre = txt(d.nombre, 80);
  if (!nombre) throw new Error(T('Ponle un nombre a la línea.'));
  const x = d.id ? porId(d.id) : null;
  if (d.id && !x) throw new Error(T('Esa línea no existe.'));
  if (x?.principal) await q(`UPDATE lineas SET nombre=$2 WHERE id=$1`, [x.id, nombre]);
  else {
    const que = txt(d.que_ofrece, 600), quien = txt(d.a_quien, 800), activa = d.activa !== false;
    if (!que || !quien) throw new Error(T('Di qué ofreces y a quién: sin eso el equipo no sabe qué buscar ni qué decir.'));
    if (activa && !x?.activa && otrasActivas().length >= MAX_ACTIVAS - 1) throw new Error(T('Como mucho 3 líneas activas a la vez, contando la principal: apaga otra antes.'));
    const v = [nombre, que, quien, Math.max(0, Math.min(200, Math.round(Number(d.por_semana) || 0))), txt(d.oferta, 4000) || null, activa];
    if (x) await q(`UPDATE lineas SET nombre=$2, que_ofrece=$3, a_quien=$4, por_semana=$5, oferta=$6, activa=$7 WHERE id=$1`, [x.id, ...v]);
    else await q(`INSERT INTO lineas (nombre, que_ofrece, a_quien, por_semana, oferta, activa) VALUES ($1,$2,$3,$4,$5,$6)`, v);
  }
  await recargar();
  await emitir({ tipo: 'lineas' });
  return conCifras();
}

/** Las líneas con lo que llevan: empresas, nuevas esta semana, contactadas, en conversación o más, y clientes. */
export async function conCifras() {
  const r = (await q(`SELECT coalesce(e.linea_id, p.id) AS id, count(*)::int AS empresas,
      count(*) FILTER (WHERE e.creada >= date_trunc('week', now() AT TIME ZONE 'Europe/Madrid'))::int AS nuevas_semana,
      count(*) FILTER (WHERE e.estado NOT IN ('nueva','puntuada','dossier','descartada'))::int AS contactadas,
      count(*) FILTER (WHERE e.estado IN ('conversacion','reunion','propuesta','ganada'))::int AS conversacion,
      count(*) FILTER (WHERE e.estado = 'ganada')::int AS clientes
    FROM empresas e CROSS JOIN (SELECT id FROM lineas WHERE principal LIMIT 1) p GROUP BY 1`)).rows;
  const cifras = Object.fromEntries(r.map(x => [x.id, x]));
  return lista.map(l => ({ ...l, ...(cifras[l.id] || { empresas: 0, nuevas_semana: 0, contactadas: 0, conversacion: 0, clientes: 0 }), id: l.id }));
}

/** Para las instrucciones de los agentes. Vacío si solo está la principal: entonces todo sigue como siempre. */
export function paraPrompt() {
  const otras = otrasActivas();
  if (!otras.length) return '';
  return `\n\n## Líneas de venta\nLa oficina vende más de una cosa. Cada empresa lleva su línea («linea» en leer_empresa); sin línea, es de la principal («${principal()?.nombre}»: lo que dice la ficha de la empresa). `
    + `Con una empresa de otra línea, lo que buscas, cómo la puntúas y lo que le ofreces salen de esa línea, nunca de la ficha general, y no mezcles una oferta con otra.\n`
    + otras.map(l => `- «${l.nombre}» (linea_id ${l.id}): ofrecemos ${l.que_ofrece}. A quién: ${l.a_quien}.`).join('\n');
}
/** Lo que lleva el expediente de una empresa de otra línea (para leer_empresa). */
export const paraExpediente = e => {
  const l = porId(e?.linea_id);
  return l && !l.principal ? { id: l.id, nombre: l.nombre, que_ofrecemos: l.que_ofrece, a_quien: l.a_quien, oferta: l.oferta || undefined } : undefined;
};
