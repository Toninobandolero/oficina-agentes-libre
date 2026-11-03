// Configuración leída de variables de entorno (.env). Ver .env.example.
const env = process.env;
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

export const config = {
  // Quién es la empresa de esta oficina: lo que no esté en Configuración › Mi empresa sale de aquí.
  // <empresa>
  empresa: {
    nombre: 'Tu empresa', web: '', lema: '',
    actividad: '', zona: 'la que indique la ficha de la empresa',
    presentacion: 'Lo que vende esta empresa, a quién y dónde está en «La empresa y su dueño». Si falta algún dato, dilo y pídeselo a Dirección: no lo inventes.',
    enReunion: '', oficina: 'una oficina', correoContacto: '', logoPorDefecto: false,
    localidad: null,
    reglaPresentacion: '', veto: null,
    textos: {
      descripcionChat: '{empresa}. Cuéntanos qué necesitas y te contestamos personalmente.',
      acuseChat: 'Gracias por escribir a {empresa}. Lo hemos recibido y te contestamos personalmente en cuanto podamos. Si quieres, cuéntanos ya qué necesitas.',
      bienvenidaChat: 'Hola. Este es el contacto de {empresa}. Cuéntanos qué necesitas y te contestamos personalmente.',
    },
  },
  // </empresa>
  puerto: num(env.PUERTO_INTERNO, 3000),
  databaseUrl: env.DATABASE_URL,
  // Proveedor de IA: «anthropic» (API de Claude; con un plan Max gasta sus créditos de API) u «openrouter».
  // Si no se indica: Anthropic cuando hay ANTHROPIC_API_KEY; si no, OpenRouter cuando hay OPENROUTER_API_KEY.
  proveedorIndicado: (env.PROVEEDOR_IA || '').trim().toLowerCase(),
  proveedor: ['anthropic', 'openrouter'].includes((env.PROVEEDOR_IA || '').trim().toLowerCase())
    ? (env.PROVEEDOR_IA || '').trim().toLowerCase()
    : (env.ANTHROPIC_API_KEY || !env.OPENROUTER_API_KEY ? 'anthropic' : 'openrouter'),
  anthropicKey: env.ANTHROPIC_API_KEY || '',
  anthropicUrl: (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, ''),
  herramientaBusqueda: env.ANTHROPIC_WEB_SEARCH || 'web_search_20250305',
  // Si se acaba el crédito de Claude, seguir con OpenRouter (si hay su clave). Se cambia en el panel.
  respaldoOpenrouter: env.RESPALDO_OPENROUTER !== 'false',
  openrouterKey: env.OPENROUTER_API_KEY || '',
  openrouterUrl: (env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
  // Modelo por agente (se puede cambiar con MODELO_<AGENTE>, p. ej. MODELO_JAVI=anthropic/claude-opus-5.5).
  // Se escriben siempre como proveedor/modelo; con Anthropic, «anthropic/claude-haiku-5.5» se convierte en «claude-haiku-5-5».
  modelos: {
    lucia: env.MODELO_LUCIA || 'anthropic/claude-haiku-5.5',
    mateo: env.MODELO_MATEO || 'anthropic/claude-haiku-5.5',
    carmen: env.MODELO_CARMEN || 'anthropic/claude-haiku-5.5',
    javi: env.MODELO_JAVI || 'anthropic/claude-sonnet-5.5',
    paula: env.MODELO_PAULA || 'anthropic/claude-sonnet-5.5',
    alex: env.MODELO_ALEX || 'anthropic/claude-sonnet-5.5',
    nuria: env.MODELO_NURIA || 'anthropic/claude-sonnet-5.5',
    rafa: env.MODELO_RAFA || 'anthropic/claude-haiku-5.5',
    pilar: env.MODELO_PILAR || 'anthropic/claude-sonnet-5.5',
    sara: env.MODELO_SARA || 'anthropic/claude-sonnet-5.5',
    leo: env.MODELO_LEO || 'anthropic/claude-sonnet-5.5',
    marta: env.MODELO_MARTA || 'anthropic/claude-sonnet-5.5',
  },
  modeloBusqueda: env.MODELO_BUSQUEDA || 'anthropic/claude-haiku-5.5',
  presupuestoEur: num(env.PRESUPUESTO_EUR, 50),
  usdEur: num(env.USD_EUR, 0.86),
  telegramToken: env.TELEGRAM_TOKEN || '',
  telegramChatId: env.TELEGRAM_CHAT_ID || '',
  telegramUserId: env.TELEGRAM_USER_ID || env.TELEGRAM_CHAT_ID || '',
  panelUrl: env.PANEL_URL || '',
  panelPassword: env.PANEL_PASSWORD || '',
  maxAnalisisDia: num(env.MAX_ANALISIS_DIA, 40),
  concurrencia: num(env.CONCURRENCIA, 2),
  maxTurnos: num(env.MAX_TURNOS, 24),
  busquedasAuto: (env.BUSQUEDAS_AUTO || '').split('|').map(s => s.trim()).filter(Boolean),
  // Informe semanal de inteligencia de Sara (día 0–6, 5 = viernes)
  inteligenciaDia: Number(env.INTELIGENCIA_DIA ?? 5),
  inteligenciaHora: env.INTELIGENCIA_HORA || '09:30',
  reunionDia: Number(env.REUNION_DIA ?? 1),          // 1 = lunes
  reunionHora: env.REUNION_HORA || '10:00',
  // Modo ausencia: horas de sueño (Telegram calla y resume al despertar) y tope de cosas en tu mesa
  suenoDesde: env.SUENO_DESDE || '23:30',
  suenoHasta: env.SUENO_HASTA || '08:00',
  mesaMax: Number(env.MESA_MAX ?? 12),
  // Correo de la oficina (Hostinger): sin usuario y clave, el equipo no envía ni lee correo
  correo: {
    usuario: env.CORREO_USUARIO || '', clave: env.CORREO_CLAVE || '', nombre: env.CORREO_NOMBRE || '',
    smtp: env.CORREO_SMTP || 'smtp.hostinger.com:465', imap: env.CORREO_IMAP || 'imap.hostinger.com:993',
  },
  empresasPorBusqueda: num(env.EMPRESAS_POR_BUSQUEDA, 8),
  // Provincia que mira por defecto consultar_borme
  bormeProvincia: env.BORME_PROVINCIA || '',
  // App de LinkedIn para publicar en el perfil de Dirección (producto «Share on LinkedIn»)
  linkedin: { clientId: env.LINKEDIN_CLIENT_ID || '', clientSecret: env.LINKEDIN_CLIENT_SECRET || '', version: env.LINKEDIN_VERSION || '', clientIdPorDefecto: '' },
  // Clave para cifrar lo que se guarda en la base de datos (tokens de LinkedIn…). Si cambia, hay que volver a conectar.
  claveCifrado: env.CLAVE_CIFRADO || `${env.PANEL_PASSWORD || ''}|${env.DATABASE_URL || ''}`,
  // Webs desde las que se acepta el formulario de contacto (/api/entrada)
  entradaOrigenes: (env.ENTRADA_ORIGENES || '').split(',').map(s => s.trim()).filter(Boolean),
  pausadoInicial: env.PAUSADO !== 'false',   // una oficina nueva espera en pausa hasta terminar el primer uso (arranque.js)
  sectoresPrioritarios: env.SECTORES_PRIORITARIOS || 'los de la ficha de la empresa',
  zona: 'Europe/Madrid',
};

/** Comprueba la configuración al arrancar. Un valor mal escrito no puede desactivar el presupuesto. */
export function validar() {
  const errores = [];
  if (!config.databaseUrl) errores.push('Falta DATABASE_URL, la dirección de la base de datos (por ejemplo, postgres://localhost/oficina). Con Docker la pone docker-compose.yml.');
  // Sin contraseña, quien llegue al panel manda sobre los agentes, las claves y los clientes: no se arranca así (solo a propósito, para probar en tu ordenador)
  if (!config.panelPassword) { if (process.env.PANEL_SIN_CONTRASENA !== 'si') errores.push('Falta PANEL_PASSWORD en .env: es la contraseña del panel, de 10 caracteres o más. Solo para probar en tu ordenador puedes poner PANEL_SIN_CONTRASENA=si.'); }
  else if (config.panelPassword.length < 10) errores.push('PANEL_PASSWORD es demasiado corta: usa 10 caracteres o más.');
  for (const [k, v] of Object.entries({ PRESUPUESTO_EUR: config.presupuestoEur, USD_EUR: config.usdEur, MAX_ANALISIS_DIA: config.maxAnalisisDia, CONCURRENCIA: config.concurrencia, MAX_TURNOS: config.maxTurnos, EMPRESAS_POR_BUSQUEDA: config.empresasPorBusqueda })) {
    if (!Number.isFinite(v) || v <= 0) errores.push(`${k} debe ser un número mayor que 0 (usa punto decimal, sin «€»).`);
  }
  if (config.proveedorIndicado && !['anthropic', 'openrouter'].includes(config.proveedorIndicado)) errores.push('PROVEEDOR_IA debe ser «anthropic» u «openrouter».');
  const modelos = { ...Object.fromEntries(Object.entries(config.modelos).map(([ag, m]) => [`MODELO_${ag.toUpperCase()}`, m])), MODELO_BUSQUEDA: config.modeloBusqueda };
  for (const [nombre, m] of Object.entries(modelos)) {
    if (!/^[\w.-]+\/[\w.:-]+$/.test(m)) errores.push(`${nombre} no tiene el formato proveedor/modelo (p. ej. anthropic/claude-haiku-5.5): ${m}`);
  }
  if (!/^\d{2}:\d{2}$/.test(config.inteligenciaHora)) errores.push('INTELIGENCIA_HORA debe tener el formato HH:MM.');
  if (!/^\d{2}:\d{2}$/.test(config.suenoDesde) || !/^\d{2}:\d{2}$/.test(config.suenoHasta)) errores.push('SUENO_DESDE y SUENO_HASTA deben tener el formato HH:MM.');
  if (!Number.isInteger(config.mesaMax) || config.mesaMax < 1) errores.push('MESA_MAX debe ser un número entero mayor que 0.');
  if (!Number.isInteger(config.inteligenciaDia) || config.inteligenciaDia < 0 || config.inteligenciaDia > 6) errores.push('INTELIGENCIA_DIA debe ser un número del 0 al 6.');
  return errores;
}
