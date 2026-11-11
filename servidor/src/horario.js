// Cuándo llamar: reglas de horario por sector. Lo usan las secuencias y las tarjetas aplazadas (en todas las ediciones);
// el análisis de las llamadas de la centralita (edición Pro) lo reutiliza.
import { q } from './db.js';

export const madrid = d => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map(x => [x.type, x.value]));
  return { dia: `${p.year}-${p.month}-${p.day}`, hora: `${p.hour}:${p.minute}` };
};
export const sigLaborable = dia => { const d = new Date(dia + 'T12:00:00Z'); do d.setUTCDate(d.getUTCDate() + 1); while ([0, 6].includes(d.getUTCDay())); return d.toISOString().slice(0, 10); };
/** «AAAA-MM-DD HH:MM» de Madrid → Date. */
export function deMadrid(txt) {
  const m = String(txt || '').match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/); if (!m) return null;
  const guess = new Date(`${m[1]}T${m[2]}:${m[3]}:00Z`), h = madrid(guess);
  const off = (new Date(`${h.dia}T${h.hora}:00Z`) - guess);           // lo que adelanta Madrid sobre UTC
  return new Date(guess - off);
}
// ---------- Cuándo llamar ----------
// Reglas prácticas por sector para encontrar a quien decide (no en plena faena). Con el tiempo, los resultados de las
// llamadas (se guarda si se habló o no) dicen qué franjas funcionan de verdad: consejoHora los añade cuando hay datos.
const REGLAS = [
  [/hostel|restaur|bar\b|cafe|beach|chiringuito|hotel|catering/, { dias: [2, 3, 4], franjas: [['10:30', '12:30'], ['16:30', '18:30']], evitar: 'las horas de servicio (13:00–16:00 y 20:00–23:00) y el lunes, que muchos cierran', evitar_en: 'service hours (13:00–16:00 and 20:00–23:00) and Monday, when many are closed' }],
  [/taller|neum|automoc|concesion|mecan|moto/, { dias: [2, 3, 4], franjas: [['10:30', '12:30'], ['16:00', '17:30']], evitar: 'primera hora (entrada de coches) y el viernes por la tarde', evitar_en: 'first thing (when the cars come in) and Friday afternoon' }],
  [/clinic|dental|fisio|medic|veterin|gimnas|centro de estetica|estetica|pelu/, { dias: [2, 3, 4], franjas: [['09:00', '10:00'], ['13:30', '15:00']], evitar: 'las horas de consulta o de citas, y el lunes por la mañana', evitar_en: 'surgery or appointment hours, and Monday morning' }],
  [/comercio|tienda|retail|moda|deport|cash|super|ferreter|bricol/, { dias: [2, 3, 4], franjas: [['10:00', '11:30'], ['16:30', '17:30']], evitar: 'el sábado y las horas punta de la tarde', evitar_en: 'Saturday and the busy afternoon hours' }],
  [/gestor|asesor|abogad|despacho|inmobil|oficina|consult|seguros|administra/, { dias: [2, 3, 4], franjas: [['09:30', '11:30'], ['16:00', '17:30']], evitar: 'el lunes a primera hora, el viernes por la tarde y, en gestorías, los días de impuestos (del 1 al 20 de enero, abril, julio y octubre)', evitar_en: 'Monday first thing, Friday afternoon and, for accountants, tax days (1st to 20th of January, April, July and October)' }],
  [/alquiler vacacional|apartament|rental|turist/, { dias: [2, 3, 4], franjas: [['10:00', '12:30'], ['16:00', '17:30']], evitar: 'viernes y sábado (entradas y salidas de huéspedes)', evitar_en: 'Friday and Saturday (guest check-ins and check-outs)' }],
];
const GENERAL = { dias: [2, 3, 4], franjas: [['10:00', '12:00'], ['16:30', '18:00']], evitar: 'el lunes a primera hora y el viernes por la tarde', evitar_en: 'Monday first thing and Friday afternoon' };
const DIA_TXT = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const DIA_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export function reglaHora(sector) {
  const t = String(sector || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return (REGLAS.find(([re]) => re.test(t)) || [null, GENERAL])[1];
}
/** Consejo de cuándo llamar a una empresa (por su sector y, si hay, por cómo han ido las llamadas hasta ahora). En inglés, para el panel con ?lang=en. */
export async function consejoHora(empresa_id, lang = 'es') {
  const e = empresa_id ? (await q(`SELECT sector FROM empresas WHERE id=$1`, [empresa_id])).rows[0] : null;
  const r = reglaHora(e?.sector), en = lang === 'en';
  const dias = r.dias.map(d => (en ? DIA_EN : DIA_TXT)[d]); const diasTxt = `${dias.slice(0, -1).join(', ')} ${en ? 'and' : 'y'} ${dias.at(-1)}`;
  let texto = en ? `Best on ${diasTxt}, from ${r.franjas.map(f => f.join(' to ')).join(' or from ')}. Avoid ${r.evitar_en}.`
    : `Mejor ${diasTxt}, de ${r.franjas.map(f => f.join(' a ')).join(' o de ')}. Evita ${r.evitar}.`;
  const st = (await q(`SELECT CASE WHEN extract(hour FROM coalesce(inicio, creada) AT TIME ZONE 'Europe/Madrid') < 14 THEN 'mañana' ELSE 'tarde' END AS franja,
                         count(*)::int AS n, count(*) FILTER (WHERE resultado IN ('hablado','volver_a_llamar','no_interesa'))::int AS ok
                       FROM llamadas WHERE resultado IS NOT NULL GROUP BY 1`)).rows;
  const total = st.reduce((a, x) => a + x.n, 0);
  if (total >= 10) texto += en ? ` Your calls so far: ${st.map(x => `in the ${x.franja === 'mañana' ? 'morning' : 'afternoon'} you got through on ${x.ok} of ${x.n}`).join('; ')}.`
    : ` Tus llamadas hasta ahora: ${st.map(x => `por la ${x.franja} hablaste en ${x.ok} de ${x.n}`).join('; ')}.`;
  return { texto, dias: r.dias, franjas: r.franjas, sector: e?.sector || null };
}
/** El siguiente hueco bueno para volver a llamar: otro día preferente y la otra franja de la del intento anterior. */
export function siguienteHueco(sector, horaAnterior = '10:00', desde = null) {
  const r = reglaHora(sector);
  let dia = sigLaborable(desde || madrid(new Date()).dia);
  for (let i = 0; i < 6 && !r.dias.includes(new Date(dia + 'T12:00:00Z').getUTCDay()); i++) dia = sigLaborable(dia);
  const manana = Number(String(horaAnterior).slice(0, 2)) < 14;
  return { dia, hora: (manana ? r.franjas[1] || r.franjas[0] : r.franjas[0])[0] };
}

/** Lo último que Paula ha visto que Dirección puede mejorar al hablar: lo ve antes de llamar y lo usan quienes le escriben los guiones. En la edición Libre no hay análisis de llamadas y sale vacío. */
/** Consejos de llamadas anteriores para la que vas a hacer: primero los de esta misma empresa y luego los de su sector.
 *  Los de otros sectores no: a un concesionario no le sirven frases pensadas para una clínica. */
export async function mejorasRecientes(empresaId = null, n = 3) {
  // Sin empresa (las instrucciones de quien escribe guiones): las últimas, de cualquier llamada
  if (!empresaId) return (await q(`SELECT mejoras FROM llamadas WHERE mejoras IS NOT NULL ORDER BY coalesce(inicio, creada) DESC LIMIT $1`, [n])).rows.map(r => r.mejoras);
  return (await q(`WITH yo AS (SELECT lower(split_part(split_part(coalesce(sector,''), ':', 1), ' ', 1)) AS s FROM empresas WHERE id=$1)
    SELECT l.mejoras FROM llamadas l LEFT JOIN empresas e ON e.id=l.empresa_id, yo
     WHERE l.mejoras IS NOT NULL AND (l.empresa_id=$1 OR (yo.s <> '' AND lower(split_part(split_part(coalesce(e.sector,''), ':', 1), ' ', 1)) = yo.s))
     ORDER BY (l.empresa_id=$1) DESC, coalesce(l.inicio, l.creada) DESC LIMIT $2`, [empresaId, n])).rows.map(r => r.mejoras);
}
