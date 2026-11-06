// Prioridad de lo que llega a la mesa de Dirección.
// Niveles: 1 urgente · 2 importante · 3 normal · 4 puede esperar.
// Hay una prioridad de base (según qué es) y otra efectiva, que sube sola con el tiempo y las fechas límite.

export const NIVELES = { 1: 'Urgente', 2: 'Importante', 3: 'Normal', 4: 'Puede esperar' };
export const EMOJI = { 1: '🔴', 2: '🟠', 3: '⚪', 4: '💤' };

/** Prioridad de base al crear la aprobación. */
export function base({ tipo, ref, empresa, importancia, motivo }) {
  const r = String(ref || '');
  let nivel = 3, porque = 'Revisar cuando puedas';
  if (tipo === 'respuesta') { nivel = 1; porque = 'Un lead está esperando respuesta'; }
  else if (r.startsWith('paso:')) { nivel = 2; porque = 'Toca hoy en la secuencia'; }
  else if (r.startsWith('ctl:')) { nivel = 3; porque = 'Pregunta de seguimiento'; }
  else if (tipo === 'correo') { nivel = importancia === 'alta' ? 1 : 2; porque = motivo || 'Correo para un lead'; }
  else if (tipo === 'propuesta') { nivel = 2; porque = 'Propuesta para un posible cliente'; }
  else if (tipo === 'mensaje') {
    if (empresa?.interes || ['conversacion', 'reunion', 'propuesta', 'cliente'].includes(empresa?.estado)) { nivel = 2; porque = 'Ya has hablado con ellos'; }
    else if (empresa?.categoria === 'A') { nivel = 2; porque = 'Primer contacto con una empresa A'; }
    else { nivel = 3; porque = `Primer contacto${empresa?.categoria ? ` con una empresa ${empresa.categoria}` : ''}`; }
  }
  else if (tipo === 'post' || tipo === 'articulo') { nivel = 4; porque = 'Contenido: sin prisa'; }
  else if (tipo === 'video') { nivel = 3; porque = 'Guion de vídeo'; }
  else if (tipo === 'boletin' || tipo === 'anuncio') { nivel = 3; porque = tipo === 'boletin' ? 'Boletín del mes' : 'Anuncio: necesita tu visto bueno y presupuesto'; }
  else if (tipo === 'regla') { nivel = 4; porque = 'Norma propuesta para el equipo'; }
  // Un contacto esperando a Dirección hoy (ha pedido que le llamen, ha contestado con interés) es lo primero, sea lo que sea la tarjeta
  if (importancia === 'urgente') { nivel = 1; porque = motivo || 'Un contacto está esperando'; }
  // El agente puede subirla a «importante» con un motivo o bajarla
  if (importancia === 'alta' && nivel > 2) { nivel = 2; porque = motivo || 'El agente lo considera importante'; }
  if (importancia === 'baja' && nivel === 3) { nivel = 4; porque = motivo || 'El agente dice que puede esperar'; }
  return { nivel, motivo: porque };
}

const dias = (a, b) => Math.round((new Date(a + 'T12:00:00Z') - new Date(b + 'T12:00:00Z')) / 86_400_000);
const fechaTxt = f => new Date(f + 'T12:00:00Z').toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

/** Prioridad efectiva hoy: la de base, ajustada por la fecha límite y por lo que lleva esperando. */
export function efectiva({ prioridad, prioridad_motivo, caduca, creada, fecha_prevista, tipo, clase, pospuesta }, hoy) {
  let nivel = prioridad || 3, motivo = prioridad_motivo || NIVELES[nivel];
  const cad = caduca ? (caduca instanceof Date ? caduca.toISOString().slice(0, 10) : String(caduca).slice(0, 10)) : null;
  if (cad) {
    const quedan = dias(cad, hoy);
    if (quedan < 0) { nivel = 1; motivo = `Caducó el ${fechaTxt(cad)}: revisa si aún vale`; }
    else if (quedan <= 1) { nivel = 1; motivo = quedan === 0 ? 'Caduca hoy' : 'Caduca mañana'; }
    else if (quedan <= 3 && nivel > 2) { nivel = 2; motivo = `Caduca el ${fechaTxt(cad)}`; }
  }
  // Lo que tiene día previsto (un post, un vídeo) sube según se acerca
  const prev = fecha_prevista ? (fecha_prevista instanceof Date ? fecha_prevista.toISOString().slice(0, 10) : String(fecha_prevista).slice(0, 10)) : null;
  // Un boletín no tiene hora de cierre, y lo que Dirección ha pospuesto no le corre prisa hasta que vuelva
  const sinPrisa = (tipo || clase) === 'boletin' || (pospuesta && new Date(pospuesta) > new Date());
  if (!sinPrisa && prev && /^\d{4}-\d{2}-\d{2}$/.test(prev)) {
    const q = dias(prev, hoy);
    if (q <= 1 && nivel > 1) { nivel = 1; motivo = q < 0 ? `Tenía que salir el ${fechaTxt(prev)}` : q === 0 ? 'Sale hoy' : 'Sale mañana'; }
    else if (q <= 3 && nivel > 2) { nivel = 2; motivo = `Sale el ${fechaTxt(prev)}`; }
  }
  const creadaDia = creada ? new Date(creada).toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' }) : hoy;
  const espera = dias(hoy, creadaDia);
  if (espera >= 7 && nivel > 2) { nivel -= 1; motivo = `${motivo} · lleva ${espera} días esperando`; }
  else if (espera >= 3 && nivel === 3) { nivel = 2; motivo = `${motivo} · lleva ${espera} días esperando`; }
  return { nivel, etiqueta: NIVELES[nivel], emoji: EMOJI[nivel], motivo, caduca: cad, espera };
}
