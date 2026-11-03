-- Esquema de la oficina de agentes. Idempotente: se ejecuta en cada arranque.

CREATE TABLE IF NOT EXISTS empresas (
  id                 TEXT PRIMARY KEY,
  nombre             TEXT NOT NULL,
  nombre_norm        TEXT NOT NULL,
  cif                TEXT,
  web                TEXT,
  sector             TEXT,
  municipio          TEXT,
  empleados          INTEGER,
  facturacion_eur    NUMERIC,
  fuente             TEXT,
  fecha_alta         DATE NOT NULL DEFAULT CURRENT_DATE,
  puntuacion         INTEGER,
  encaje             INTEGER,
  necesidad          INTEGER,
  capacidad          INTEGER,
  acceso             INTEGER,
  categoria          TEXT,
  confianza          TEXT,
  decisor            TEXT,
  cargo              TEXT,
  linkedin_url       TEXT,
  estado             TEXT NOT NULL DEFAULT 'nueva',
  etapa_max          INTEGER NOT NULL DEFAULT 0,
  ultimo_contacto    DATE,
  proximo_paso       TEXT,
  fecha_proximo_paso DATE,
  notas              TEXT,
  dossier            TEXT,
  creada             TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizada        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS empresas_web_unica ON empresas (lower(web)) WHERE web IS NOT NULL AND web <> '';
CREATE INDEX IF NOT EXISTS empresas_nombre_norm ON empresas (nombre_norm);
CREATE INDEX IF NOT EXISTS empresas_estado ON empresas (estado);

CREATE TABLE IF NOT EXISTS tareas (
  id          BIGSERIAL PRIMARY KEY,
  agente      TEXT NOT NULL,
  instruccion TEXT NOT NULL,
  empresa_id  TEXT REFERENCES empresas(id) ON DELETE SET NULL,
  origen      TEXT NOT NULL DEFAULT 'dueno',
  estado      TEXT NOT NULL DEFAULT 'pendiente',   -- pendiente · en_curso · hecha · error
  resultado   TEXT,
  intentos    INTEGER NOT NULL DEFAULT 0,
  no_antes    TIMESTAMPTZ NOT NULL DEFAULT now(),
  creada      TIMESTAMPTZ NOT NULL DEFAULT now(),
  empezada    TIMESTAMPTZ,
  terminada   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS tareas_pendientes ON tareas (estado, no_antes);

CREATE TABLE IF NOT EXISTS aprobaciones (
  id              TEXT PRIMARY KEY,
  agente          TEXT NOT NULL,
  empresa_id      TEXT REFERENCES empresas(id) ON DELETE SET NULL,
  tipo            TEXT NOT NULL,
  titulo          TEXT NOT NULL,
  texto           TEXT NOT NULL,
  estado          TEXT NOT NULL DEFAULT 'pendiente',  -- pendiente · aprobada · descartada
  telegram_msg_id BIGINT,
  creada          TIMESTAMPTZ NOT NULL DEFAULT now(),
  resuelta        TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS eventos (
  id    BIGSERIAL PRIMARY KEY,
  ts    TIMESTAMPTZ NOT NULL DEFAULT now(),
  datos JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS eventos_ts ON eventos (ts);

CREATE TABLE IF NOT EXISTS gasto (
  id         BIGSERIAL PRIMARY KEY,
  ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
  agente     TEXT,
  tarea_id   BIGINT,
  modelo     TEXT,
  tokens_in  INTEGER,
  tokens_out INTEGER,
  busquedas  INTEGER,
  usd        NUMERIC(10,5) NOT NULL
);
CREATE INDEX IF NOT EXISTS gasto_ts ON gasto (ts);
-- Con qué proveedor se hizo cada llamada (anthropic | openrouter). Hasta el 31-oct-2026 todo iba por OpenRouter.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'gasto' AND column_name = 'proveedor') THEN
    ALTER TABLE gasto ADD COLUMN proveedor TEXT;
    UPDATE gasto SET proveedor = 'openrouter';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ajustes (
  clave TEXT PRIMARY KEY,
  valor JSONB
);

-- Lo que el equipo aprende de Dirección: reglas fijas y correcciones a trabajos concretos
CREATE TABLE IF NOT EXISTS aprendizajes (
  id     SERIAL PRIMARY KEY,
  agente TEXT,                         -- NULL = para todo el equipo
  tipo   TEXT NOT NULL,                -- regla · correccion
  texto  TEXT NOT NULL,
  activo BOOLEAN NOT NULL DEFAULT true,
  creada TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tipo de tarea: trabajo normal o pregunta de Dirección (respuesta = opinión del agente)
ALTER TABLE tareas ADD COLUMN IF NOT EXISTS tipo TEXT NOT NULL DEFAULT 'trabajo';

-- Seguridad ante reintentos: si una tarea ya escribió algo, no se repite a ciegas
ALTER TABLE tareas ADD COLUMN IF NOT EXISTS con_efectos BOOLEAN NOT NULL DEFAULT false;
-- Referencia de una aprobación a otro objeto (p. ej. la regla que propone un agente)
ALTER TABLE aprobaciones ADD COLUMN IF NOT EXISTS ref TEXT;

-- Memoria de búsquedas web (30 días): lo que ya se buscó no se vuelve a pagar
CREATE TABLE IF NOT EXISTS busquedas (
  consulta   TEXT PRIMARY KEY,
  resultados JSONB NOT NULL,
  creada     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Datos de contacto de la empresa (sacados de su web)
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS telefono TEXT;
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS whatsapp TEXT;

-- Memoria de los agentes: lo que ya se ha publicado y la libreta de cada uno
CREATE TABLE IF NOT EXISTS publicaciones (
  id             SERIAL PRIMARY KEY,
  aprobacion_id  TEXT,
  agente         TEXT,
  titulo         TEXT NOT NULL,
  texto          TEXT NOT NULL,
  canal          TEXT NOT NULL DEFAULT 'linkedin',
  publicada      DATE NOT NULL DEFAULT CURRENT_DATE
);
CREATE TABLE IF NOT EXISTS memoria (
  id     SERIAL PRIMARY KEY,
  agente TEXT NOT NULL,
  texto  TEXT NOT NULL,
  activa BOOLEAN NOT NULL DEFAULT true,
  creada TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memoria_agente ON memoria (agente, creada);

-- Sesiones del panel (la cookie guarda un token; aquí solo su huella)
CREATE TABLE IF NOT EXISTS sesiones (
  id         SERIAL PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  creada     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expira     TIMESTAMPTZ NOT NULL,
  ultimo_uso TIMESTAMPTZ NOT NULL DEFAULT now(),
  larga      BOOLEAN NOT NULL DEFAULT false,
  ip         TEXT,
  navegador  TEXT
);

-- Secuencias de contacto: los pasos que prepara Javi y que Paula lleva por fechas
CREATE TABLE IF NOT EXISTS secuencias (
  id             SERIAL PRIMARY KEY,
  empresa_id     TEXT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  autor          TEXT,
  decisor        TEXT,
  linkedin_url   TEXT,
  notas          TEXT,
  estado         TEXT NOT NULL DEFAULT 'borrador',  -- borrador · activa · respondida · aparcada · cerrada · descartada
  control        TEXT,                              -- aceptacion · cierre (lo próximo que Paula te preguntará)
  control_fecha  DATE,
  control_veces  INTEGER NOT NULL DEFAULT 0,
  creada         TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizada    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS secuencias_empresa ON secuencias (empresa_id);
CREATE TABLE IF NOT EXISTS pasos (
  id             SERIAL PRIMARY KEY,
  secuencia_id   INTEGER NOT NULL REFERENCES secuencias(id) ON DELETE CASCADE,
  orden          INTEGER NOT NULL,
  clave          TEXT NOT NULL,      -- conexion · mensaje1 · seguimiento1 · seguimiento2 · llamada · presentacion · otro
  canal          TEXT NOT NULL,      -- linkedin · telefono · visita · email · whatsapp · presentacion
  titulo         TEXT NOT NULL,
  texto          TEXT NOT NULL,
  dias           INTEGER NOT NULL DEFAULT 0,        -- días tras el paso anterior
  tras_aceptar   BOOLEAN NOT NULL DEFAULT false,    -- espera a que acepte la conexión
  alternativo    BOOLEAN NOT NULL DEFAULT false,    -- plan B (llamada, presentación): solo si hace falta
  estado         TEXT NOT NULL DEFAULT 'pendiente', -- pendiente · programado · en_mesa · hecho · saltado · cancelado
  fecha          DATE,
  hecho          TIMESTAMPTZ,
  aprobacion_id  TEXT
);
CREATE INDEX IF NOT EXISTS pasos_programados ON pasos (estado, fecha);

-- Página de la empresa en LinkedIn (el perfil del decisor va en linkedin_url, solo si está verificado)
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS linkedin_empresa TEXT;

-- Botones a medida en una aprobación (p. ej. «Ha aceptado», «Aún no»)
ALTER TABLE aprobaciones ADD COLUMN IF NOT EXISTS opciones JSONB;

-- Configuración de la plantilla desde el panel: nombre, puesto, modelo y aspecto (id 'dueno' = tu aspecto)
CREATE TABLE IF NOT EXISTS config_agentes (
  id          TEXT PRIMARY KEY,
  nombre      TEXT,
  rol         TEXT,
  modelo      TEXT,
  look        JSONB,
  actualizada TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Modo ausencia: avisos de Telegram guardados mientras Dirección duerme o está de vacaciones
CREATE TABLE IF NOT EXISTS telegram_cola (
  id     SERIAL PRIMARY KEY,
  texto  TEXT NOT NULL,
  creada TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE aprobaciones ADD COLUMN IF NOT EXISTS telegram_pendiente BOOLEAN NOT NULL DEFAULT false;

-- Prioridad de lo que hay en la mesa de Dirección (1 urgente · 2 importante · 3 normal · 4 puede esperar) y fecha límite
ALTER TABLE aprobaciones ADD COLUMN IF NOT EXISTS prioridad INTEGER NOT NULL DEFAULT 3;
ALTER TABLE aprobaciones ADD COLUMN IF NOT EXISTS prioridad_motivo TEXT;
ALTER TABLE aprobaciones ADD COLUMN IF NOT EXISTS caduca DATE;

-- Informes y respuestas largas de los agentes, para abrirlos desde la actividad del panel
CREATE TABLE IF NOT EXISTS informes (
  id         SERIAL PRIMARY KEY,
  agente     TEXT NOT NULL,
  tipo       TEXT NOT NULL DEFAULT 'informe',   -- informe · opinion · resumen
  titulo     TEXT,
  texto      TEXT NOT NULL,
  empresa_id TEXT,
  creada     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Correo de la oficina: lo que llega, lo que sale y los borradores que esperan a Dirección
CREATE TABLE IF NOT EXISTS correos (
  id             SERIAL PRIMARY KEY,
  direccion      TEXT NOT NULL,          -- entrada · salida · borrador · descartado
  de             TEXT,
  para           TEXT,
  asunto         TEXT,
  texto          TEXT,
  message_id     TEXT UNIQUE,
  en_respuesta_a TEXT,
  empresa_id     TEXT REFERENCES empresas(id) ON DELETE SET NULL,
  clase          TEXT,                   -- lead · boletin · otro
  creada         TIMESTAMPTZ NOT NULL DEFAULT now(),
  enviado        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS correos_empresa ON correos (empresa_id);

-- De dónde viene cada contacto (busqueda = lo encontró Lucía; web, google, gestoria, evento… = llegó por otro canal)
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS origen TEXT NOT NULL DEFAULT 'busqueda';
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS origen_detalle TEXT;
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS alianza_id INTEGER;

-- Contactos que llegan solos por el formulario de la web (con su consentimiento)
CREATE TABLE IF NOT EXISTS entradas (
  id             SERIAL PRIMARY KEY,
  empresa_id     TEXT REFERENCES empresas(id) ON DELETE SET NULL,
  tipo           TEXT NOT NULL DEFAULT 'contacto',   -- contacto · diagnostico · calculadora
  nombre         TEXT,
  empresa        TEXT,
  email          TEXT,
  telefono       TEXT,
  sector         TEXT,
  mensaje        TEXT,
  datos          JSONB,
  pagina         TEXT,
  origen         TEXT,
  consentimiento BOOLEAN NOT NULL DEFAULT false,
  ip_hash        TEXT,
  creada         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Alianzas: gestorías, asociaciones y eventos que lleva Marta
CREATE TABLE IF NOT EXISTS alianzas (
  id                 SERIAL PRIMARY KEY,
  tipo               TEXT NOT NULL,                       -- gestoria · asociacion · evento · otro
  nombre             TEXT NOT NULL,
  nombre_norm        TEXT NOT NULL,
  web                TEXT,
  municipio          TEXT,
  contacto           TEXT,
  cargo              TEXT,
  email              TEXT,
  telefono           TEXT,
  linkedin_url       TEXT,
  fecha              DATE,                                -- eventos: cuándo es
  lugar              TEXT,
  estado             TEXT NOT NULL DEFAULT 'identificada', -- identificada · contactada · reunion · acuerdo · descartada (eventos: apuntado · asistido)
  notas              TEXT,
  fuente             TEXT,
  proximo_paso       TEXT,
  fecha_proximo_paso DATE,
  creada             TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizada        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS alianzas_unica ON alianzas (tipo, nombre_norm);

-- Canal y fecha prevista de lo que se publica (calendario de contenido)
ALTER TABLE aprobaciones ADD COLUMN IF NOT EXISTS canal TEXT;
ALTER TABLE aprobaciones ADD COLUMN IF NOT EXISTS fecha_prevista DATE;
ALTER TABLE publicaciones ADD COLUMN IF NOT EXISTS formato TEXT;

-- Premio del mes: el agente que más ha aportado a contactos que avanzan
CREATE TABLE IF NOT EXISTS premios (
  mes     TEXT PRIMARY KEY,          -- AAAA-MM
  agente  TEXT NOT NULL,
  puntos  INTEGER NOT NULL,
  detalle JSONB,
  creada  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enlace a lo publicado (p. ej. el post de LinkedIn)
ALTER TABLE aprobaciones ADD COLUMN IF NOT EXISTS enlace TEXT;
ALTER TABLE publicaciones ADD COLUMN IF NOT EXISTS enlace TEXT;

-- Asunto de un paso de LinkedIn (a veces LinkedIn lo pide: InMail o mensaje a quien aún no es contacto)
ALTER TABLE pasos ADD COLUMN IF NOT EXISTS asunto TEXT;

-- Imagen de cada post (diseño de Dirección), generada al prepararlo
CREATE TABLE IF NOT EXISTS imagenes (
  aprobacion_id TEXT PRIMARY KEY,
  titular       TEXT,
  destacado     TEXT,
  png           BYTEA NOT NULL,
  creada        TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Vídeo generado a partir de un guion (lo pide Dirección desde la tarjeta). Se guarda aquí para que sobreviva a un redespliegue
CREATE TABLE IF NOT EXISTS videos (
  aprobacion_id TEXT PRIMARY KEY,
  estado        TEXT NOT NULL,   -- generando · listo · error
  error         TEXT,
  mp4           BYTEA,           -- el último que salió bien: si falla al rehacerlo, sigue el anterior
  segundos      NUMERIC,
  generado      TIMESTAMPTZ
);
-- Dirección no graba: las tarjetas que ya estaban en la mesa dejan de decirlo
UPDATE aprobaciones SET prioridad_motivo='Guion de vídeo' WHERE tipo='video' AND prioridad_motivo LIKE '%grabación%';
ALTER TABLE aprobaciones ADD COLUMN IF NOT EXISTS tambien TEXT;   -- otra red donde publicar lo mismo (p. ej. facebook)

-- Llamadas de la centralita (Zadarma) y su transcripción, para que Paula saque lo importante
CREATE TABLE IF NOT EXISTS llamadas (
  call_id        TEXT PRIMARY KEY,
  empresa_id     TEXT REFERENCES empresas(id) ON DELETE SET NULL,
  tipo           TEXT,              -- out · in
  numero         TEXT,
  inicio         TIMESTAMPTZ,
  segundos       INTEGER,
  estado         TEXT NOT NULL DEFAULT 'pendiente',   -- pendiente · transcrita · analizada · sin_transcripcion
  intentos       INTEGER NOT NULL DEFAULT 0,
  transcripcion  TEXT,
  creada         TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE aprobaciones ADD COLUMN IF NOT EXISTS pospuesta TIMESTAMPTZ;   -- «más tarde»: al fondo de la mesa hasta esta fecha

-- Chats con leads (bot de Telegram de contacto; más adelante WhatsApp)
CREATE TABLE IF NOT EXISTS chats (
  id          SERIAL PRIMARY KEY,
  canal       TEXT NOT NULL,
  chat_id     TEXT NOT NULL,
  nombre      TEXT,
  usuario     TEXT,
  empresa_id  TEXT REFERENCES empresas(id) ON DELETE SET NULL,
  creado      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (canal, chat_id)
);
CREATE TABLE IF NOT EXISTS mensajes_chat (
  id         SERIAL PRIMARY KEY,
  chat       INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  direccion  TEXT NOT NULL,          -- entrada · salida · borrador · enviado
  texto      TEXT NOT NULL,
  auto       BOOLEAN NOT NULL DEFAULT false,
  creado     TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE aprobaciones ADD COLUMN IF NOT EXISTS perfil_url TEXT;   -- LinkedIn (u otro perfil) del destinatario cuando no es una empresa de la base
ALTER TABLE aprobaciones ADD COLUMN IF NOT EXISTS buscar TEXT;       -- nombre para buscarlo en LinkedIn si no hay perfil verificado

-- Agentes atascados: qué les falta, quién puede resolverlo y cuándo se resolvió
CREATE TABLE IF NOT EXISTS bloqueos (
  id          SERIAL PRIMARY KEY,
  agente      TEXT NOT NULL,
  motivo      TEXT NOT NULL,
  necesita    TEXT NOT NULL DEFAULT 'dueno',
  tarea_id    BIGINT,
  empresa_id  TEXT,
  creado      TIMESTAMPTZ NOT NULL DEFAULT now(),
  aviso       TIMESTAMPTZ,
  resuelto    TIMESTAMPTZ,
  como        TEXT
);
-- La tarea de quien puede resolverlo: cuando termina, el atasco se cierra solo. Los abiertos se enlazan con la tarea que ya se creó.
ALTER TABLE bloqueos ADD COLUMN IF NOT EXISTS ayuda_tarea_id BIGINT;
UPDATE bloqueos b SET ayuda_tarea_id = t.id FROM tareas t
 WHERE b.ayuda_tarea_id IS NULL AND b.resuelto IS NULL AND b.necesita <> 'dueno' AND t.agente = b.necesita AND t.origen = b.agente AND position(b.motivo IN t.instruccion) > 0;
ALTER TABLE aprobaciones ADD COLUMN IF NOT EXISTS publicar_en TIMESTAMPTZ;   -- día y hora a la que Dirección la ha programado
ALTER TABLE aprobaciones ADD COLUMN IF NOT EXISTS fallo_pub TIMESTAMPTZ;     -- último intento fallido de publicar (se reintenta a las 3 h)
CREATE TABLE IF NOT EXISTS recordatorios (
  id       SERIAL PRIMARY KEY,
  dia      DATE NOT NULL,
  hora     TEXT,                                  -- HH:MM (hora de Madrid) o vacío = todo el día
  texto    TEXT NOT NULL,
  creado_por TEXT NOT NULL DEFAULT 'dueno',
  avisado  TIMESTAMPTZ,
  hecho    TIMESTAMPTZ,
  creado   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS llamadas_voz (
  id         SERIAL PRIMARY KEY,
  telefono   TEXT,            -- últimos 9 dígitos, para reconocer a quien vuelve a llamar
  nombre     TEXT,
  empresa    TEXT,
  empresa_id TEXT,
  motivo     TEXT,
  quiere     TEXT,
  creada     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS llamadas_voz_tel ON llamadas_voz (telefono);
-- Llamadas: citas para devolverlas en el calendario y el resumen de cada una
ALTER TABLE recordatorios ADD COLUMN IF NOT EXISTS clase TEXT;        -- 'llamada' = devolver una llamada (sale como «📞 Llamadas»)
ALTER TABLE recordatorios ADD COLUMN IF NOT EXISTS empresa_id TEXT;
ALTER TABLE recordatorios ADD COLUMN IF NOT EXISTS telefono TEXT;
ALTER TABLE recordatorios ADD COLUMN IF NOT EXISTS detalle TEXT;
ALTER TABLE llamadas_voz ADD COLUMN IF NOT EXISTS resumen TEXT;
ALTER TABLE llamadas_voz ADD COLUMN IF NOT EXISTS cita_id INTEGER;
ALTER TABLE llamadas ADD COLUMN IF NOT EXISTS resumen TEXT;
ALTER TABLE llamadas_voz ADD COLUMN IF NOT EXISTS dudosa BOOLEAN NOT NULL DEFAULT false;   -- no parecía real: Dirección decide
ALTER TABLE llamadas_voz ADD COLUMN IF NOT EXISTS datos JSONB;                           -- el recado tal cual (para tramitarlo si Dirección dice que es real)
ALTER TABLE llamadas_voz ADD COLUMN IF NOT EXISTS conversacion_id TEXT;                  -- la conversación en ElevenLabs (para no tramitar dos veces la misma llamada)
CREATE UNIQUE INDEX IF NOT EXISTS llamadas_voz_conv ON llamadas_voz (conversacion_id);
ALTER TABLE llamadas_voz ADD COLUMN IF NOT EXISTS transcripcion TEXT;                    -- la conversación entera, para leerla desde el panel
ALTER TABLE llamadas_voz ADD COLUMN IF NOT EXISTS segundos INTEGER;                      -- cuánto duró la llamada
-- Llamadas desde la oficina: desde qué tarjeta se llamó y qué pasó (lo saca Paula de la transcripción)
CREATE TABLE IF NOT EXISTS marcaciones (
  id            SERIAL PRIMARY KEY,
  numero9       TEXT NOT NULL,          -- últimos 9 dígitos del número marcado
  empresa_id    TEXT,
  aprobacion_id TEXT,                   -- la tarjeta de la mesa desde la que se llamó
  notas         TEXT,                   -- lo que Dirección apunta durante la llamada
  creada        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS marcaciones_num ON marcaciones (numero9, creada);
ALTER TABLE llamadas ADD COLUMN IF NOT EXISTS aprobacion_id TEXT;
ALTER TABLE llamadas ADD COLUMN IF NOT EXISTS notas_dueno TEXT;
ALTER TABLE llamadas ADD COLUMN IF NOT EXISTS resultado TEXT;   -- hablado · no_contesta · buzon · no_esta · numero_equivocado · no_interesa · volver_a_llamar
ALTER TABLE llamadas ADD COLUMN IF NOT EXISTS disposicion TEXT; -- lo que dice la centralita (answered, no answer, busy…)
ALTER TABLE llamadas ADD COLUMN IF NOT EXISTS motivo TEXT;      -- por qué no hay transcripción
ALTER TABLE llamadas ADD COLUMN IF NOT EXISTS mejoras TEXT;     -- lo que Dirección puede mejorar al hablar, según lo que dijo en esta llamada
-- Chat de la oficina (tipo Slack): #general contigo, #trabajo con lo que se encargan entre ellos, #café y un privado con cada agente
CREATE TABLE IF NOT EXISTS chat (
  id          BIGSERIAL PRIMARY KEY,
  canal       TEXT NOT NULL,          -- general · trabajo · cafe · o el id de un agente (privado con él)
  autor       TEXT NOT NULL,          -- dueno · id de un agente · sistema
  para        TEXT,                   -- a quién va dirigido, si es a alguien concreto
  texto       TEXT NOT NULL,
  via         TEXT,                   -- panel · telegram · ficha (por dónde lo escribió Dirección)
  tarea_id    BIGINT,
  empresa_id  TEXT,
  informe_id  BIGINT,
  creado      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_canal ON chat (canal, id);
ALTER TABLE tareas ADD COLUMN IF NOT EXISTS canal TEXT;   -- si te contestan en el chat: en qué canal
ALTER TABLE recordatorios ADD COLUMN IF NOT EXISTS aprobacion_id TEXT;   -- tarjeta de la mesa pospuesta a ese día y hora
-- Objetivos: Dirección plantea uno, Rafa lo convierte en un plan de pasos y el equipo lo ejecuta tras su visto bueno
CREATE TABLE IF NOT EXISTS objetivos (
  id            SERIAL PRIMARY KEY,
  texto         TEXT NOT NULL,
  estado        TEXT NOT NULL DEFAULT 'planificando',   -- planificando · propuesto · en_marcha · hecho · descartado · detenido
  resumen       TEXT,
  medida        TEXT,
  plan          JSONB,                                   -- [{agente, instruccion, depende:[i], estado, tarea_id, resultado, est_eur}]
  estimado_eur  NUMERIC(8,3),
  aprobacion_id TEXT,
  creado        TIMESTAMPTZ NOT NULL DEFAULT now(),
  aprobado      TIMESTAMPTZ,
  terminado     TIMESTAMPTZ
);
ALTER TABLE tareas ADD COLUMN IF NOT EXISTS objetivo_id INTEGER;
-- Las personas de cada empresa: quién es quién y su teléfono. El teléfono de la ficha es el general
CREATE TABLE IF NOT EXISTS contactos (
  id           SERIAL PRIMARY KEY,
  empresa_id   TEXT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nombre       TEXT,
  cargo        TEXT,
  telefono     TEXT,
  clave        TEXT,                   -- últimos 9 dígitos: el mismo número no se repite
  email        TEXT,
  linkedin_url TEXT,
  notas        TEXT,
  preferente   BOOLEAN NOT NULL DEFAULT false,   -- a quien se llama primero
  origen       TEXT NOT NULL DEFAULT 'equipo',   -- equipo · dueno · notas · lola · web
  borrado      BOOLEAN NOT NULL DEFAULT false,   -- quitado a propósito: no vuelve aunque siga en las notas
  creado       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS contactos_numero ON contactos (empresa_id, clave) WHERE clave IS NOT NULL;
CREATE INDEX IF NOT EXISTS contactos_clave ON contactos (clave);
-- Boletín: a quién va cada uno (para no repetir) y quién se ha dado de baja
CREATE TABLE IF NOT EXISTS boletin_envios (
  id             SERIAL PRIMARY KEY,
  aprobacion_id  TEXT NOT NULL,
  email          TEXT NOT NULL,
  nombre         TEXT,
  token          TEXT NOT NULL UNIQUE,   -- la llave de su enlace de baja
  estado         TEXT NOT NULL DEFAULT 'pendiente',   -- pendiente · enviando · enviado · error · baja
  intentos       INTEGER NOT NULL DEFAULT 0,
  error          TEXT,
  enviado        TIMESTAMPTZ,
  creado         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (aprobacion_id, email)
);
CREATE TABLE IF NOT EXISTS boletin_bajas (email TEXT PRIMARY KEY, creada TIMESTAMPTZ NOT NULL DEFAULT now());
-- Vías de contacto que no son LinkedIn; de Google solo se guarda su identificador
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS direccion TEXT;
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS instagram TEXT;
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS facebook TEXT;
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS google_place_id TEXT;
ALTER TABLE tareas ADD COLUMN IF NOT EXISTS paso INTEGER;
