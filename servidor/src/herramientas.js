// Herramientas que los agentes pueden usar. Cada agente solo recibe las que tiene en agentes.js.
import { q, ajuste, fijarAjuste } from './db.js';
import { config } from './config.js';
import { PRO, M } from './modulos.js';
import { emitir, log, calcularEmbudo, guardarInforme } from './bus.js';
import { AGENTES, IDS, puedeEncargar } from './agentes.js';
import * as empresas from './empresas.js';
import * as tareas from './tareas.js';
import * as departamentos from './departamentos.js';
import * as aprobaciones from './aprobaciones.js';
import * as video from './video.js';
import * as secuencias from './secuencias.js';
import * as correo from './correo.js';
import * as telegram from './telegram.js';
import * as aprendizajes from './aprendizajes.js';
import * as web from './web.js';
import * as memoria from './memoria.js';
import * as presupuesto from './presupuesto.js';
import * as alianzas from './alianzas.js';
import * as entradas from './entradas.js';
import * as fuentes from './fuentes.js';
import * as oficina from './oficina.js';
import * as contactos from './contactos.js';
import { herramientaOpenAI } from './llm.js';
import { comprobarVeto } from './empresa.js';

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const CAMPOS_EMPRESA = {
  nombre: str('Nombre comercial'), web: str('Web (dominio)'), sector: str('Sector'), municipio: str('Municipio'),
  cif: str('CIF si es público'), empleados: { type: 'integer', description: 'Empleados (solo si hay fuente)' },
  facturacion_eur: { type: 'number', description: 'Facturación anual en euros (solo si hay fuente)' },
  decisor: str('Nombre del gerente/propietario si es público'), cargo: str('Cargo del decisor'),
  linkedin_url: str('Perfil personal de LinkedIn del decisor (linkedin.com/in/...), SOLO si coincide nombre y empresa o cargo'),
  linkedin_empresa: str('Página de la empresa en LinkedIn (linkedin.com/company/...)'),
  email: str('Email de contacto de la empresa publicado en su web'), telefono: str('Teléfono GENERAL de la empresa (el móvil de una persona concreta va con guardar_contacto)'), whatsapp: str('Número o enlace de WhatsApp publicado por la empresa'),
  direccion: str('Dirección postal de la empresa o de su local principal, para una visita'), instagram: str('Instagram de la empresa (para informarse, no para escribir en frío)'), facebook: str('Facebook de la empresa (para informarse, no para escribir en frío)'),
  google_place_id: str('Identificador de Google Maps (place_id), si salió de buscar_maps'),
  fuente: str('URL(s) donde se comprobó, separadas por espacios'), notas: str('Señales y evidencias, breve'),
  origen: str('De dónde viene el contacto. Si lo has encontrado tú, en internet o donde sea, es «busqueda» (por defecto)', { enum: empresas.ORIGENES.filter(o => !empresas.SOLO_ENTRADA.includes(o)) }),
  origen_detalle: str('Detalle del origen: qué evento, qué gestoría, qué página…'),
  alianza_id: { type: 'integer', description: 'id de la alianza (gestoría, asociación o evento) por la que llegó, si aplica' },
};
const CAMPOS_ALIANZA = {
  tipo: str('Qué es', { enum: alianzas.TIPOS }), nombre: str('Nombre'), web: str('Web'), municipio: str('Municipio'),
  contacto: str('Persona de contacto (socio, gerente, organizador)'), cargo: str('Cargo'), email: str('Email publicado'), telefono: str('Teléfono publicado'),
  linkedin_url: str('LinkedIn del contacto, solo si está verificado'), fecha: str('Eventos: fecha AAAA-MM-DD'), lugar: str('Eventos: dónde'),
  notas: str('Por qué encaja, clientes que tiene, qué ofrece, precio de la entrada o cuota…'), fuente: str('URL donde se comprobó'),
};

export const DEFINICIONES = {
  buscar_web: {
    description: 'Busca en internet (cada búsqueda cuesta dinero: piensa bien la consulta). Devuelve URLs, títulos y extractos.',
    input_schema: { type: 'object', properties: { consulta: str('Qué buscar, concreto y en el idioma de las empresas que buscas: «grupo restauración Getafe varios locales gerente»') }, required: ['consulta'] },
  },
  leer_web: {
    description: 'Lee el texto de una página web (gratis). Úsala con URLs de resultados de búsqueda o de la ficha de la empresa.',
    input_schema: { type: 'object', properties: { url: str('URL completa, con https://') }, required: ['url'] },
  },
  consultar_borme: {
    description: 'Lee el Boletín del Registro Mercantil (gratis): sociedades de una provincia con sus actos: constituciones, administradores nombrados, domicilio, objeto social, cambios de capital. Responde «quién decide» sin LinkedIn y saca sociedades nuevas. No busca por nombre en todo el histórico: mira los últimos días.',
    input_schema: { type: 'object', properties: {
      empresa: str('Filtra por nombre de la sociedad'), tipo: str('Qué actos', { enum: ['todo', 'constitucion', 'nombramientos'] }),
      dias: { type: 'integer', description: 'Cuántos días atrás mirar, de 1 a 30 (por defecto 5)' }, provincia: str('Provincia. Hace falta si la oficina no tiene una por defecto'),
      documento: str('Para un acto antiguo que has encontrado con buscar_web: su identificador, como BORME-A-2026-211-29'),
    } },
  },
  buscar_maps: {
    description: 'Busca negocios en Google Maps por zona y sector: nombre, dirección, web, teléfono y número de opiniones. Cuesta dinero: piensa la consulta. Sirve para descubrir: a la ficha solo pasa lo que confirmes en otra fuente.',
    input_schema: { type: 'object', properties: { consulta: str('Sector y zona: «clínicas dentales en Madrid»') }, required: ['consulta'] },
  },
  consultar_oficina: {
    description: 'Consulta lo que sabe la oficina: informes (de cualquiera), actividad (lo que ha hecho cada uno), conversaciones (lo que Dirección ha hablado con cualquier compañero), trabajo (encargos entre compañeros), notas (las libretas de todos), aprendido (reglas y correcciones de Dirección), planes (objetivos de Dirección) y reunion (la última acta). Mírala antes de decidir o de preguntar lo que ya se sabe.',
    input_schema: { type: 'object', properties: { que: str('Qué consultar', { enum: oficina.CONSULTAS }), texto: str('Filtra por este texto'), limite: { type: 'integer', description: 'Cuántos, hasta 30 (por defecto 10)' } }, required: ['que'] },
  },
  listar_empresas: {
    description: 'Lista empresas de la base de datos comercial. Úsala para evitar duplicados o ver el estado del embudo.',
    input_schema: { type: 'object', properties: {
      estado: str('Filtra por estado', { enum: empresas.ESTADOS }), sector: str('Texto del sector'),
      categoria: str('A, B, C o D'), texto: str('Busca en nombre o web'), limite: { type: 'integer' } } },
  },
  leer_empresa: {
    description: 'Lee el expediente de una empresa: su ficha (notas y dossier incluidos) y todo lo que ha pasado con ella: encargos, mensajes, llamadas y actividad. Las llamadas traen su resumen; con transcripciones, lo que se dijo palabra por palabra.',
    input_schema: { type: 'object', properties: { id: str('id de la empresa'), transcripciones: { type: 'boolean', description: 'true solo si necesitas lo que se dijo exactamente: en vez del expediente, devuelve las transcripciones de sus llamadas, de la última a la primera' } }, required: ['id'] },
  },
  guardar_empresas: {
    description: 'Añade empresas nuevas a la base de datos (estado «nueva»). Omite duplicadas por nombre o web. Cada empresa debe llevar fuente.',
    input_schema: { type: 'object', properties: { empresas: { type: 'array', items: { type: 'object', properties: CAMPOS_EMPRESA, required: ['nombre', 'fuente'] } } }, required: ['empresas'] },
  },
  actualizar_empresa: {
    description: 'Actualiza campos de una empresa: puntuación y ejes, categoría, confianza, decisor, estado, próximos pasos, notas…',
    input_schema: { type: 'object', properties: {
      id: str('id de la empresa'),
      campos: { type: 'object', properties: {
        ...CAMPOS_EMPRESA,
        puntuacion: { type: 'integer' }, encaje: { type: 'integer' }, necesidad: { type: 'integer' }, capacidad: { type: 'integer' }, acceso: { type: 'integer' },
        categoria: str('A, B, C o D', { enum: ['A', 'B', 'C', 'D'] }), confianza: str('alta, media o baja', { enum: ['alta', 'media', 'baja'] }),
        estado: str('Estado del embudo', { enum: empresas.ESTADOS }),
        proximo_paso: str('Siguiente acción'), fecha_proximo_paso: str('AAAA-MM-DD'), ultimo_contacto: str('AAAA-MM-DD'),
        dolores: str('Lo que le duele, dicho por ellos y con sus palabras: una línea por punto, con la fecha. Pasa la lista entera, lo de antes y lo nuevo'),
      } } }, required: ['id', 'campos'] },
  },
  corregir_contacto: {
    description: 'Corrige los datos de contacto de la ficha de una empresa. Un campo vacío lo borra. Solo cambia lo que indiques.',
    input_schema: { type: 'object', properties: {
      id: str('id de la empresa'),
      campos: { type: 'object', properties: { decisor: CAMPOS_EMPRESA.decisor, cargo: CAMPOS_EMPRESA.cargo, linkedin_url: CAMPOS_EMPRESA.linkedin_url, linkedin_empresa: CAMPOS_EMPRESA.linkedin_empresa,
        telefono: CAMPOS_EMPRESA.telefono, email: CAMPOS_EMPRESA.email, direccion: CAMPOS_EMPRESA.direccion, instagram: CAMPOS_EMPRESA.instagram, facebook: CAMPOS_EMPRESA.facebook, proximo_paso: str('Siguiente acción'), fecha_proximo_paso: str('AAAA-MM-DD') } },
    }, required: ['id', 'campos'] },
  },
  guardar_dossier: {
    description: 'Guarda el dossier comercial (markdown) de una empresa y la marca con estado «dossier».',
    input_schema: { type: 'object', properties: { id: str('id de la empresa'), markdown: str('Dossier completo en markdown') }, required: ['id', 'markdown'] },
  },
  pedir_aprobacion: {
    description: 'Deja un trabajo en la mesa de Dirección para que lo apruebe; le llega por Telegram y al panel. Nada sale fuera sin esto.',
    input_schema: { type: 'object', properties: {
      tipo: str('Qué es', { enum: ['mensaje', 'respuesta', 'post', 'video', 'articulo', 'boletin', 'anuncio', 'propuesta', 'otro'] }),
      documento: { type: 'object', description: 'Solo para un diagnóstico o una propuesta (tipo «propuesta»): lo mismo que el texto, por partes, y sale en un PDF de una página con la marca de la empresa, imágenes y gráficos. Lo que no sepas, no lo pongas: una cifra sin fuente no sale.', properties: {
        tipo: str('Qué documento es', { enum: ['diagnostico', 'propuesta'] }),
        titulo: str('Titular que le importe al dueño, hasta 70 letras: su problema o lo que gana, no «Diagnóstico para X»'), para: str('Persona a la que va'),
        gancho: str('La idea central en una o dos frases, hasta 170 letras'), situacion: str('Lo que nos cuenta, con sus palabras, hasta 420 letras'),
        cifras: { type: 'array', description: 'Hasta 3 datos grandes', items: { type: 'object', properties: { valor: str('Corto: «40 h/mes»'), etiqueta: str('Qué es, hasta 60 letras'), fuente: str('De dónde sale: «estimación prudente», «lo que nos contaste»') }, required: ['valor', 'etiqueta', 'fuente'] } },
        grafico: { type: 'object', description: 'Barras: cómo está hoy y cómo quedaría', properties: { titulo: str('Título'), unidad: str('h, €…'), fuente: str('De dónde salen los números'), filas: { type: 'array', items: { type: 'object', properties: { etiqueta: str('Tarea'), hoy: { type: 'number' }, despues: { type: 'number' } }, required: ['etiqueta', 'hoy'] } } }, required: ['fuente', 'filas'] },
        esquema: { type: 'object', description: 'Antes y después sin números', properties: { hoy: { type: 'array', items: { type: 'string' }, description: 'Hasta 4 cosas cortas: «Excel de cada centro»' }, despues: { type: 'array', items: { type: 'string' }, description: 'Hasta 2' } } },
        puntos: { type: 'array', description: 'Hasta 3 oportunidades', items: { type: 'object', properties: { titulo: str('Título'), texto: str('Hasta 170 letras') }, required: ['titulo'] } },
        primero: { type: 'object', properties: { titulo: str('Lo primero que haríamos'), texto: str('En lenguaje de negocio'), plazo: str('Plazo'), precio: str('Solo si Dirección lo quiere: rango orientativo') }, required: ['titulo'] },
        no_haria: str('Lo que no haríamos todavía'), siguiente: str('Siguiente paso, hasta 130 letras'), imagen: str('Un trabajo nuestro, solo si se parece de verdad a su negocio. Si no, no pongas ninguna', { enum: ['talleres', 'gestion', 'automatizacion', 'turnos', 'reservas'] }),
      } },
      canal: str('Contenido: dónde se publica', { enum: ['linkedin', 'facebook', 'instagram', 'youtube', 'google', 'web', 'boletin', 'anuncios'] }),
      fecha_prevista: str('Contenido: día previsto de publicación (AAAA-MM-DD)'),
      empresa_id: str('id de la empresa, si aplica'),
      titulo: str('Frase corta en tercera persona, sin sujeto: «ha preparado el mensaje de LinkedIn para Marta (Clínica X)»'),
      texto: str('Contenido completo, listo para copiar'),
      caduca: str('Opcional. Fecha (AAAA-MM-DD) a partir de la cual esto ya no sirve (p. ej. un gancho ligado a una apertura o un evento)'),
      perfil_url: str('Si el mensaje es para alguien que no está en la base de empresas (p. ej. un socio de una gestoría): URL de su LinkedIn SOLO si está verificada.'),
      buscar_linkedin: str('Si no hay perfil verificado: nombre de la persona o empresa para que Dirección la busque en LinkedIn con un clic (p. ej. «Asesoría Ejemplo»).'),
      imagen_titular: str('Solo posts de redes y de la ficha de Google: frase principal de la imagen del post (corta, el gancho; máx. 70 caracteres). Si no la pones, se usa la primera frase del post.'),
      imagen_destacado: str('Solo posts de redes y de la ficha de Google: segunda frase de la imagen, que sale en color (el giro o la consecuencia; máx. 70 caracteres).'),
      importancia: str('Opcional. «urgente» si un contacto está esperando algo de Dirección hoy (ha pedido que le llamen, ha contestado con interés); «alta» solo si hay un motivo claro; «baja» si puede esperar', { enum: ['urgente', 'alta', 'normal', 'baja'] }),
      motivo_importancia: str('Opcional. Por qué, en una frase'),
    }, required: ['tipo', 'titulo', 'texto'] },
  },
  guardar_secuencia: {
    description: 'Entrega el PRIMER CONTACTO con una empresa: notas para Dirección y solicitud de conexión (o, si no hay LinkedIn, la llamada, el correo o la presentación). Solo un paso: el mensaje 1 y los seguimientos se te piden después, cuando acepte o cuando toque. Sustituye a pedir_aprobacion para los mensajes de prospección.',
    input_schema: { type: 'object', properties: {
      empresa_id: str('id de la empresa'),
      decisor: str('Nombre del decisor al que va dirigida (vacío si no se sabe: «la gerencia»)'),
      linkedin_url: str('URL del perfil de LinkedIn del decisor SOLO si está verificado (que es él y esta empresa). Si no, vacío y explícalo en las notas.'),
      notas: str('Notas para Dirección que no se envían: decisor, cómo tratarle, qué está verificado y qué no, qué evitar, horario de llamada…'),
      caduca: str('Opcional. Fecha (AAAA-MM-DD) en que el gancho deja de valer (p. ej. «abren el 5 de noviembre»)'),
      pasos: { type: 'array', description: 'El primer contacto: «conexion» (solicitud de LinkedIn) y, si hay teléfono, también «llamada» (el guion para llamar al día siguiente, sin esperar a que acepte). Sin LinkedIn, el paso de la vía que haya: «llamada», «visita», «carta» o «presentacion». Lo demás no se guarda: se escribe cuando toque.', items: { type: 'object', properties: {
        clave: str('Qué paso es', { enum: secuencias.CLAVES }),
        canal: str('Por dónde', { enum: ['linkedin', 'telefono', 'visita', 'email', 'whatsapp', 'presentacion'] }),
        texto: str('El texto exacto listo para copiar (en llamada, el guion)'),
        asunto: str('LinkedIn: asunto corto (máx. 60 caracteres) por si LinkedIn lo pide (InMail o mensaje a quien aún no es contacto). Si no lo pones, se pone uno por defecto.'),
        dias: { type: 'integer', description: 'Días que hay que esperar desde el paso anterior (llamada: 1, al día siguiente de la solicitud, o 0 el mismo día; seguimiento 1: 4–5; seguimiento 2: 5–6). Opcional.' },
      }, required: ['clave', 'texto'] } },
    }, required: ['empresa_id', 'pasos'] },
  },
  anadir_paso: {
    description: 'Entrega el siguiente mensaje de una secuencia que ya está en marcha (mensaje 1 cuando acepta, seguimiento 1 o 2 si no contesta, guion de llamada). Va a la mesa de Dirección al momento.',
    input_schema: { type: 'object', properties: {
      empresa_id: str('id de la empresa'),
      clave: str('Qué paso es', { enum: ['mensaje1', 'seguimiento1', 'seguimiento2', 'llamada', 'visita', 'presentacion', 'otro'] }),
      texto: str('El texto exacto listo para copiar (en llamada, el guion)'),
      asunto: str('LinkedIn: asunto corto (máx. 60 caracteres) por si LinkedIn lo pide. Opcional.'),
    }, required: ['empresa_id', 'clave', 'texto'] },
  },
  leer_chat: {
    description: 'Lee la conversación de un chat con un lead (Telegram de contacto o WhatsApp).',
    input_schema: { type: 'object', properties: { chat: { type: 'integer', description: 'Número del chat' } }, required: ['chat'] },
  },
  responder_chat: {
    description: 'Prepara la respuesta a un lead que nos ha escrito por chat. Va a la mesa de Dirección con el botón «Enviar»; nada sale sin él.',
    input_schema: { type: 'object', properties: { chat: { type: 'integer', description: 'Número del chat' }, texto: str('El mensaje tal cual se envía: corto, de tú a tú, firmado como Dirección si hace falta') }, required: ['chat', 'texto'] },
  },
  encargar: {
    description: 'Pasa trabajo a un compañero. Si no es un paso directo de la cadena (lo tienes en tus instrucciones), le llega a Rafa, que decide a quién va.',
    input_schema: { type: 'object', properties: { agente: str('id del compañero', { enum: IDS }), instruccion: str('Qué tiene que hacer, con todo el contexto necesario'), empresa_id: str('id de la empresa, si aplica') }, required: ['agente', 'instruccion'] },
  },
  estoy_atascado: {
    description: 'Úsalo cuando NO puedas seguir con la tarea porque te falta algo (un dato, un id, un permiso, algo de un compañero o una decisión de Dirección). Di exactamente qué te falta y quién te lo puede dar. Se verá en la oficina, se le encargará a quien pueda resolverlo y, si sigue así horas después, se avisa a Dirección. No lo uses para dudas que puedes resolver tú con tus herramientas.',
    input_schema: { type: 'object', properties: {
      motivo: str('Qué te falta exactamente y para qué (una o dos frases)'),
      quien: { ...str('Quién te lo puede dar: el id de un compañero o «dueno»'), get enum() { return [...IDS, 'dueno']; } },
    }, required: ['motivo', 'quien'] },
  },
  apuntar_en_calendario: {
    description: 'Apunta algo con día (y si se sabe, hora) en el calendario de Dirección, que le avisa a esa hora por Telegram y le sale en el móvil. Úsalo para compromisos con fecha: devolver o volver a hacer una llamada (tipo «llamada»), mandar algo prometido, una reunión acordada… (tipo «recordatorio»). Una línea clara: «Llamar a Marta (Gestoría Ruiz) para ver la demo».',
    input_schema: { type: 'object', properties: {
      dia: str('Día, AAAA-MM-DD'), hora: str('Hora de Madrid, HH:MM (opcional)'), texto: str('Qué hay que hacer, en una línea'),
      tipo: str('«llamada» si es para llamar a alguien; si no, «recordatorio»', { enum: ['llamada', 'recordatorio'] }),
      empresa_id: str('id de la empresa, si es de una (opcional)'), telefono: str('Teléfono al que llamar (opcional)'), detalle: str('Por qué: lo que dijo o lo acordado, con su fecha. Obligatorio si es de una empresa: un recordatorio sin motivo no sirve'),
    }, required: ['dia', 'texto', 'tipo'] },
  },
  registrar_interes: {
    description: 'Registra lo que ha dicho un contacto, con sus palabras y por el canal que sea. El protocolo comercial fija el siguiente paso, la fecha y el recordatorio con su motivo, para la secuencia en frío y dice cuándo dejar de insistir. Te devuelve lo que toca hacer ahora.',
    input_schema: { type: 'object', properties: {
      empresa_id: str('id de la empresa'),
      nivel: str('Cómo está, de lo más frío a lo más caliente', { enum: ['baja', 'rechazo', 'ahora_no', 'objecion', 'deriva', 'informacion', 'interes', 'urgente'] }),
      frase: str('Lo que dijo, literal y entre 3 y 25 palabras. Es el motivo de lo que venga después: no lo resumas ni lo inventes'),
      canal: str('Por dónde lo dijo: llamada, correo, chat, en persona…'),
      cuando: str('Si dijo una fecha: AAAA-MM-DD HH:MM (hora de Madrid)'),
    }, required: ['empresa_id', 'nivel', 'frase'] },
  },
  anotar: {
    description: 'Escribe una línea en el registro de actividad que ve Dirección. Tercera persona, empieza por verbo: «ha puntuado X: 82/100, categoría A».',
    input_schema: { type: 'object', properties: { texto: str('Una línea'), empresa_id: str('id de la empresa de la que hablas, si la hay y no es la de la tarea: así Dirección abre su ficha desde Actividad'), urgente: { type: 'boolean', description: 'Solo si un contacto está esperando algo de Dirección hoy (ha pedido que le llamen, ha contestado con interés). Sale destacado en Actividad y le avisa al móvil.' } }, required: ['texto'] },
  },
  guardar_contacto: {
    description: 'Guarda a una persona de una empresa con su teléfono: el dueño, el gerente, un encargado. Es lo que Dirección ve al pulsar «Llamar». Si el número ya estaba, completa lo que falte.',
    input_schema: { type: 'object', properties: {
      empresa_id: str('id de la empresa (si no es la de la tarea)'), nombre: str('Nombre de la persona'), cargo: str('Qué es en la empresa: dueño, gerente, encargado…'),
      telefono: str('Su teléfono. Un móvil personal, solo si lo ha dado esa persona o es público'), email: str('Su correo'), linkedin_url: str('Su LinkedIn, solo si está verificado'),
      preferente: { type: 'boolean', description: 'true si es a quien hay que llamar primero' }, notas: str('De dónde sale el dato o cuándo se le localiza'),
    } },
  },
  retirar_tarjeta: {
    description: 'Quita de la mesa de Dirección una tarjeta que ya no toca (id de ver_mesa). No sirve para rechazar trabajo: solo para lo que han dejado atrás los hechos. Di por qué: Dirección lo ve en Actividad.',
    input_schema: { type: 'object', properties: { id: str('id de la tarjeta'), motivo: str('Por qué ya no toca, en una frase') }, required: ['id', 'motivo'] },
  },
  limpiar_empresa: {
    description: 'Ha cambiado algo con una empresa y lo pendiente se ha quedado viejo: retira sus pasos de contacto y los avisos de llamar que apuntó el equipo, y marca lo preparado para que Dirección lo revise. Los avisos de Dirección no se tocan.',
    input_schema: { type: 'object', properties: { empresa_id: str('id de la empresa'), que: str('Qué ha cambiado: «tu llamada con el dueño»') }, required: ['empresa_id', 'que'] },
  },
  ver_mesa: {
    description: 'Lo que espera en la mesa de Dirección: cada tarjeta con su id, quién la preparó, empresa, prioridad y desde cuándo.',
    input_schema: { type: 'object', properties: {} },
  },
  priorizar_tarjeta: {
    description: 'Cambia la prioridad de una tarjeta de la mesa de Dirección. «urgente» la pone la primera, la saca de «más tarde», la destaca en Actividad y le avisa al móvil.',
    input_schema: { type: 'object', properties: { id: str('id de la tarjeta (ver_mesa)'), nivel: str('Prioridad', { enum: ['urgente', 'importante', 'normal', 'puede_esperar'] }), motivo: str('Por qué, en una frase: Dirección lo ve en la tarjeta') }, required: ['id', 'nivel', 'motivo'] },
  },
  ver_cola: {
    description: 'El trabajo pendiente y en curso del equipo: id, agente, de dónde viene y qué es.',
    input_schema: { type: 'object', properties: { agente: str('Solo el de este compañero (opcional)', { enum: IDS }) } },
  },
  mover_tarea: {
    description: 'Adelanta una tarea para que sea lo siguiente que haga su agente, o cancela una que ya no hace falta. Lo que ha pedido Dirección y los pasos de un plan aprobado no se cancelan.',
    input_schema: { type: 'object', properties: { id: { type: 'integer', description: 'id de la tarea (ver_cola)' }, accion: str('Qué hacer', { enum: ['adelantar', 'cancelar'] }), motivo: str('Por qué, en una frase') }, required: ['id', 'accion', 'motivo'] },
  },
  guardar_nota: {
    description: 'Apunta en tu libreta algo que te servirá en futuras tareas (una idea pendiente, algo que funcionó, un compromiso con fecha). Breve y concreto.',
    input_schema: { type: 'object', properties: { texto: str('La nota, en una o dos frases') }, required: ['texto'] },
  },
  aprender: {
    description: 'Cuando Dirección te ha corregido algo que también vale para próximos trabajos: guarda lo que debes hacer siempre a partir de ahora. Se aplica desde tu siguiente tarea y Dirección lo ve en sus reglas, donde puede quitarlo. Solo funciona al rehacer un trabajo que Dirección te ha corregido.',
    input_schema: { type: 'object', properties: { texto: str('Lo que debes hacer, en una frase que se entienda sin contexto. Ejemplo: «Cada post de Google lleva imagen con el diseño de la empresa; no pidas foto a Dirección.»') }, required: ['texto'] },
  },
  olvidar_nota: {
    description: 'Tacha de tu libreta una nota que ya no sirve (por su número).',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
  },
  listar_publicaciones: {
    description: 'Lista lo que Dirección ya ha publicado en LinkedIn (fecha, título e inicio del texto).',
    input_schema: { type: 'object', properties: { limite: { type: 'integer' } } },
  },
  resumen_embudo: {
    description: 'Cifras del embudo, empresas por categoría, seguimientos vencidos, aprobaciones pendientes, trabajo de la semana y gasto del mes.',
    input_schema: { type: 'object', properties: {} },
  },
  guardar_regla: {
    description: 'Propone a Dirección guardar una preferencia suya sobre cómo debe trabajar el equipo (o un agente). Le llega para aprobar; solo se aplica cuando la aprueba. Úsala solo si Dirección expresa una preferencia estable, no para encargos puntuales.',
    input_schema: { type: 'object', properties: { texto: str('La regla, en imperativo y breve: «No envíes nada antes de las 9:00»'), agente: str('id del agente si solo le aplica a uno; vacío = todo el equipo', { enum: IDS }) }, required: ['texto'] },
  },
  ver_normas: { description: 'Las normas de trabajo que tiene el equipo ahora, con su id.', input_schema: { type: 'object', properties: {} } },
  quitar_norma: { description: 'Quita una norma de trabajo. Solo si te lo pide Dirección.', input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
  cambiar_objetivo: { description: 'Cambia cuántas empresas busca el equipo y de qué tipo. Solo si te lo pide Dirección.', input_schema: { type: 'object', properties: { cantidad: { type: 'integer' }, periodo: str('dia o semana', { enum: ['dia', 'semana'] }), focos: { type: 'array', items: { type: 'string' }, description: 'Opcional. Tipos de empresa a buscar, con tamaño y zona. Sin esto se mantienen los de ahora.' } }, required: ['cantidad', 'periodo'] } },
  deshacer_cambio: { description: 'Deshace tu último cambio de normas u objetivo. Solo si te lo pide Dirección.', input_schema: { type: 'object', properties: {} } },
  apuntar_fallo: { description: 'Apunta un fallo de la aplicación que no puedes arreglar tú (un botón que no funciona, algo que se ve mal), con lo que le ha pasado a Dirección, para que se arregle.', input_schema: { type: 'object', properties: { texto: str('Qué falla, dónde y qué esperaba Dirección') }, required: ['texto'] } },
  preparar_correo: {
    description: 'Prepara un correo desde el buzón de la oficina. Llega a la mesa de Dirección con el botón «Enviar»; no sale sin él. A quién se escribe lo decide Dirección: a quien aún no nos conoce, solo si te lo pide.',
    input_schema: { type: 'object', properties: {
      empresa_id: str('id de la empresa'), para: str('Dirección de correo del destinatario'),
      asunto: str('Asunto (si respondes, se pone «Re: …» solo)'), texto: str('Cuerpo del correo, sin firma (la firma se añade sola)'),
      en_respuesta_a: { type: 'integer', description: 'id del correo recibido al que contestas, si es una respuesta' },
      adjuntar_documento: str('id de la tarjeta de un diagnóstico o propuesta: su PDF va adjunto y el texto del correo solo lo acompaña'),
    }, required: ['para', 'texto'] },
  },
  leer_boletines: {
    description: 'Boletines y alertas que han llegado al correo de la oficina (sector, normativa, ayudas) en los últimos días.',
    input_schema: { type: 'object', properties: { dias: { type: 'integer', description: 'Cuántos días atrás (por defecto 7)' } } },
  },
  resumen_origenes: {
    description: 'De dónde llegan los contactos: empresas por origen (búsqueda, web, Google, gestorías, eventos, anuncios…) y hasta qué etapa llega cada canal; últimos contactos de la web y estado de las alianzas.',
    input_schema: { type: 'object', properties: {} },
  },
  listar_alianzas: {
    description: 'Lista gestorías, asociaciones y eventos guardados (con su estado y los clientes que nos han traído).',
    input_schema: { type: 'object', properties: { tipo: str('Filtra por tipo', { enum: alianzas.TIPOS }), estado: str('Filtra por estado', { enum: alianzas.ESTADOS }), texto: str('Busca en el nombre'), limite: { type: 'integer' } } },
  },
  guardar_alianzas: {
    description: 'Guarda gestorías, asociaciones o eventos nuevos (omite los que ya existen). Cada uno con fuente.',
    input_schema: { type: 'object', properties: { alianzas: { type: 'array', items: { type: 'object', properties: CAMPOS_ALIANZA, required: ['tipo', 'nombre', 'fuente'] } } }, required: ['alianzas'] },
  },
  actualizar_alianza: {
    description: 'Actualiza una alianza o evento: estado, contacto, próximo paso, notas…',
    input_schema: { type: 'object', properties: { id: { type: 'integer' }, campos: { type: 'object', properties: {
      ...CAMPOS_ALIANZA, estado: str('Estado', { enum: alianzas.ESTADOS }), proximo_paso: str('Siguiente acción'), fecha_proximo_paso: str('AAAA-MM-DD') } } }, required: ['id', 'campos'] },
  },
  resumen_canales: {
    description: 'Qué está funcionando en nuestros contactos: secuencias por estado, aceptaciones de conexión, respuestas por paso y canal, días hasta responder y planes B usados.',
    input_schema: { type: 'object', properties: {} },
  },
  proponer_plan: {
    description: 'Entrega a Dirección el plan para un objetivo suyo: pasos para el equipo, en orden. Le llega a su mesa con el coste estimado; si lo aprueba, cada paso se encarga solo a su compañero cuando le toca.',
    input_schema: { type: 'object', properties: {
      objetivo_id: { type: 'integer', description: 'Número del objetivo' },
      resumen: str('El enfoque del plan en 2–4 frases (y lo que hayas supuesto si el objetivo no estaba claro)'),
      medida: str('Cómo sabremos que se ha conseguido'),
      pasos: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'object', properties: {
        agente: str('id del compañero que lo hace', { enum: IDS }),
        instruccion: str('Qué tiene que hacer, cuánto, con qué criterio y qué entrega'),
        depende_de: { type: 'array', items: { type: 'integer' }, description: 'Números (1, 2…) de los pasos que tienen que terminar antes; vacío si puede empezar ya' },
      }, required: ['agente', 'instruccion'] } },
    }, required: ['objetivo_id', 'resumen', 'pasos'] },
  },
  enviar_informe: {
    description: 'Envía un informe a Dirección por Telegram.',
    input_schema: { type: 'object', properties: { texto: str('Informe en texto plano, breve') }, required: ['texto'] },
  },
};

/** Las herramientas de un agente: las suyas, la web si la tiene, Google Maps si está conectado, y las comunes (la información de todos, la libreta y el atasco). Una sola lista para ofrecerlas y para permitirlas. */
// Rafa solo cambia cómo trabaja el equipo si se lo pide Dirección: nunca por lo que lea en una web, un correo o un encargo automático
const pideDueno = ctx => ctx.tarea?.origen === 'dueno';
const SOLO_DUENO = 'Esto solo se cambia si te lo pide Dirección directamente.';
async function apuntarCambio(c) {
  const lista = await ajuste('cambios_rafa', []);
  lista.push({ cuando: new Date().toISOString(), ...c });
  await fijarAjuste('cambios_rafa', lista.slice(-50));
}
// Los de un departamento propio solo ven empresas e informes con su permiso «clientes»
const COMUNES = ['ver_mesa', 'leer_empresa', 'listar_empresas', 'consultar_oficina'], SIEMPRE = ['guardar_nota', 'olvidar_nota', 'aprender', 'estoy_atascado'];
export function nombresDe(id) {
  const a = AGENTES[id];
  const SOLO_CENTRALITA = ['resultado_llamada', 'resumen_llamada'];   // el análisis de llamadas es de la edición Pro
  return [...new Set([...(a.web ? [...(a.web.busquedas > 0 ? ['buscar_web'] : []), 'leer_web'] : []), ...(a.maps && fuentes.mapsActivo() ? ['buscar_maps'] : []), ...a.herramientas, ...(a.skill ? COMUNES : []), ...SIEMPRE])]
    .filter(n => PRO.centralita || !SOLO_CENTRALITA.includes(n));
}
export function paraAgente(id) {
  return nombresDe(id).map(n => herramientaOpenAI(n, DEFINICIONES[n]));
}

const SOLO_CONTACTO = ['decisor', 'cargo', 'linkedin_url', 'linkedin_empresa', 'telefono', 'email', 'direccion', 'instagram', 'facebook', 'proximo_paso', 'fecha_proximo_paso'];
const CON_EFECTOS = new Set(['registrar_interes', 'guardar_contacto', 'proponer_plan', 'guardar_alianzas', 'actualizar_alianza', 'preparar_correo', 'guardar_empresas', 'actualizar_empresa', 'corregir_contacto', 'guardar_dossier', 'pedir_aprobacion', 'guardar_secuencia', 'anadir_paso', 'responder_chat', 'encargar', 'guardar_regla', 'aprender', 'enviar_informe', 'priorizar_tarjeta', 'mover_tarea']);
const MAX_ENCARGOS_TAREA = 3, MAX_ENCARGOS_DIA = 20, MAX_ENCARGOS_DIA_RAFA = 40, MAX_MAPS_TAREA = 3;

/** Ejecuta una herramienta. ctx = { agente, tarea, anotado, esperando } */
/** ¿Ya se ha hablado con esta empresa? Entonces un guion parte de lo que contaron, no de cero. */
async function yaHablado(id) {
  if (!id) return false;
  const e = await empresas.leer(id);
  return Boolean(e && (e.interes || ['conversacion', 'reunion', 'propuesta', 'cliente'].includes(e.estado)));
}

export async function ejecutar(ctx, nombre, input = {}) {
  if (!nombresDe(ctx.agente).includes(nombre)) throw new Error(`No tienes la herramienta ${nombre}`);
  if (CON_EFECTOS.has(nombre)) { ctx.efectos = true; await tareas.marcarEfectos(ctx.tarea.id); }
  switch (nombre) {
    case 'buscar_web': {
      const consulta = String(input.consulta || '').slice(0, 300);
      const clave = empresas.normalizar(consulta);
      const guardada = await q(`SELECT resultados FROM busquedas WHERE consulta=$1 AND creada > now() - interval '30 days'`, [clave]);
      if (guardada.rows.length) return { ...guardada.rows[0].resultados, de_memoria: true, busquedas_restantes: ctx.web.busquedas };
      if (ctx.web.busquedas <= 0) throw new Error('Has agotado las búsquedas de esta tarea. Trabaja con lo que tienes o lee alguna URL ya encontrada.');
      ctx.web.busquedas--;
      const r = await web.buscar(consulta);
      await presupuesto.registrar(ctx.agente, ctx.tarea.id, r.modelo, r.coste, { proveedor: r.proveedor }, 1);
      const salida = { resultados: r.resultados, resumen: r.resumen };
      await q(`INSERT INTO busquedas (consulta, resultados) VALUES ($1,$2) ON CONFLICT (consulta) DO UPDATE SET resultados=EXCLUDED.resultados, creada=now()`, [clave, salida]);
      return { ...salida, busquedas_restantes: ctx.web.busquedas };
    }
    case 'leer_web': {
      if (ctx.web.lecturas <= 0) throw new Error('Has agotado las lecturas de esta tarea.');
      ctx.web.lecturas--;
      return { ...(await web.leer(String(input.url || ''))), lecturas_restantes: ctx.web.lecturas };
    }
    case 'consultar_borme': {
      if (ctx.web.lecturas <= 0) throw new Error('Has agotado las lecturas de esta tarea.');
      ctx.web.lecturas--;
      return fuentes.consultarBorme(input);
    }
    case 'buscar_maps': {
      ctx.web.maps = ctx.web.maps ?? MAX_MAPS_TAREA;
      if (ctx.web.maps <= 0) throw new Error('Has agotado las consultas a Google Maps de esta tarea.');
      ctx.web.maps--;
      const { coste_usd, ...r } = await fuentes.buscarMaps(String(input.consulta || '').slice(0, 200));
      await presupuesto.registrar(ctx.agente, ctx.tarea.id, 'google/places', coste_usd, { proveedor: 'google' });
      return { ...r, consultas_restantes: ctx.web.maps };
    }
    case 'consultar_oficina': return oficina.consultar(input);
    case 'listar_empresas': return empresas.listar(input);
    case 'leer_empresa': {
      const e = await empresas.expediente(input.id);
      if (!e) throw new Error(`No existe la empresa ${input.id}. Usa listar_empresas para ver los id.`);
      // ponytail: el motor corta cada respuesta a 20.000 letras; Paula recibe la llamada entera en su tarea
      if (input.transcripciones) return { id: e.id, llamadas: (await empresas.historial(e.id)).llamadas.filter(l => l.transcripcion).map(({ via, cuando, transcripcion }) => ({ via, cuando, transcripcion })) };
      return e;
    }
    case 'guardar_empresas': {
      const res = await empresas.crear((input.empresas || []).map(e => empresas.SOLO_ENTRADA.includes(e.origen) ? { ...e, origen: 'busqueda' } : e));
      if (!departamentos.trabaja('mateo')) return res;   // Sin Investigación no se puntúa: pasárselo a Rafa solo gastaría IA
      const topeMateo = (await (await import('./planificador.js')).topes()).mateo;
      let encargadas = 0;
      for (const [i, e] of res.creadas.entries()) {
        if ((await tareas.creadasHoy('mateo')) >= topeMateo) break;
        await tareas.crear('mateo', `Puntúa la empresa ${e.nombre} (id ${e.id}).`, { empresa_id: e.id, origen: ctx.agente, animar: i === 0 });
        encargadas++;
      }
      return { ...res, pasadas_a_mateo: encargadas, nota: encargadas < res.creadas.length ? 'Se ha alcanzado el límite diario de análisis; el resto se puntuará otro día.' : undefined };
    }
    case 'actualizar_empresa': {
      const e = await empresas.actualizar(input.id, input.campos || {}, { desdeAgente: true });
      return { ok: true, id: e.id, estado: e.estado, categoria: e.categoria, puntuacion: e.puntuacion };
    }
    case 'corregir_contacto': {
      const campos = Object.fromEntries(Object.entries(input.campos || {}).filter(([k]) => SOLO_CONTACTO.includes(k)));
      if (!Object.keys(campos).length) throw new Error(`Indica qué corregir: ${SOLO_CONTACTO.join(', ')}.`);
      const e = await empresas.actualizar(input.id, campos, { desdeAgente: true });
      await log(ctx.agente, `ha corregido el contacto en la ficha de ${e.nombre}: ${Object.keys(campos).join(', ')}.`, { empresa_id: e.id });
      return { ok: true, id: e.id, decisor: e.decisor, linkedin_url: e.linkedin_url };
    }
    case 'guardar_dossier': {
      const actual = await empresas.leer(input.id);
      if (!actual) throw new Error(`No existe la empresa ${input.id}`);
      const campos = { dossier: input.markdown };
      if (['nueva', 'puntuada'].includes(actual.estado)) campos.estado = 'dossier';   // si ya está más avanzada, solo se actualiza el texto
      const e = await empresas.actualizar(input.id, campos, { desdeAgente: true });
      return { ok: true, id: e.id };
    }
    case 'pedir_aprobacion': {
      comprobarVeto(input.texto);
      if (PRO.guiones && /^\s*(GUION|GUIÓN)\b/m.test(String(input.texto || '')) && input.tipo !== 'video') {
        const faltan = M.guiones.revisar(input.texto, { hablado: await yaHablado(input.empresa_id || ctx.tarea?.empresa_id) });
        if (faltan.length) return { error: M.guiones.motivoRechazo(faltan) };
        input.texto = M.guiones.completar(input.texto);
      }
      if (input.documento) {
        if (PRO.ines && ctx.agente !== 'ines') return { error: 'Los documentos para clientes los hace Inés: pásale el contenido con encargar (agente «ines»), o a quien os lleve hasta ella.' };
        const doc = await import('./documento.js');
        const fallos = doc.revisarDocumento(input.documento);
        if (!fallos.length && !doc.cabeEnUnaPagina(doc.limpiarDocumento(input.documento))) fallos.push('no cabe en una página: quita lo que menos aporte');
        if (fallos.length) return { error: `Este documento no cabe bien: ${fallos.join('; ')}. Recórtalo y vuelve a entregarlo.` };
      }
      if (input.tipo === 'boletin') { const b = (await import('./boletin.js')).leerBoletin(input.texto); if (b.error) throw new Error(`${b.error} Corrígelo y vuelve a entregarlo.`); }
      const guion = input.tipo === 'video' ? video.leerEscenas(input.texto) : null;
      if (guion?.error) throw new Error(`${guion.error} Sin el bloque ESCENAS DEL VÍDEO, con una escena por línea («frase | frase en color | segundos»), Dirección no puede generar el vídeo. Corrígelo y vuelve a entregarlo.`);
      const id = await aprobaciones.crear({ agente: ctx.agente, tipo: input.tipo, titulo: input.titulo, texto: input.texto, empresa_id: input.empresa_id || ctx.tarea.empresa_id,
        caduca: input.caduca, importancia: input.importancia, motivo: input.motivo_importancia, canal: input.canal, fecha_prevista: input.fecha_prevista,
        imagen: input.imagen_titular ? { titular: input.imagen_titular, destacado: input.imagen_destacado } : null,
        perfil_url: input.perfil_url, buscar: input.buscar_linkedin });
      ctx.esperando = true;
      if (input.documento) await q(`UPDATE aprobaciones SET documento=$2 WHERE id=$1`, [id, (await import('./documento.js')).limpiarDocumento(input.documento)]);
      const imagen = Boolean(await aprobaciones.imagenDe(id));
      const sobreImagen = input.tipo !== 'post' && !input.imagen_titular ? '' : imagen ? ' Lleva su imagen.' : ' No lleva imagen: no digas que la lleva.';
      const sobreVideo = guion ? ` El vídeo durará ${video.segundosTxt(guion.total)} s y aún no existe: lo genera Dirección desde su mesa. No digas que está hecho.` : '';
      return { ok: true, aprobacion: id, imagen, nota: `Está en la mesa de Dirección.${sobreImagen}${sobreVideo} No hace falta que hagas nada más con esto.` };
    }
    case 'guardar_secuencia': {
      (input.pasos || []).forEach(x => comprobarVeto(x?.texto));
      const paraSecuencia = await empresas.leer(input.empresa_id || ctx.tarea.empresa_id);
      if (['perdida', 'descartada'].includes(paraSecuencia?.estado)) return { error: `${paraSecuencia.nombre} está ${paraSecuencia.estado}: no se le prepara contacto. Si ha cambiado algo, díselo a Dirección.` };
      if (paraSecuencia) {
        const { faltan } = await (await import('./protocolo.js')).minimo({ ...paraSecuencia, linkedin_url: input.linkedin_url || paraSecuencia.linkedin_url, decisor: input.decisor || paraSecuencia.decisor });
        if (faltan.length) return { error: `Antes de contactar con ${paraSecuencia.nombre} falta saber: ${faltan.join(', ').toLowerCase()}. Complétalo o pídeselo a quien corresponda: no le escribas sin eso.` };
      }
      if (PRO.guiones) for (const p of input.pasos || []) if (p?.clave === 'llamada' || p?.canal === 'telefono') {
        const faltan = M.guiones.revisar(p.texto, { hablado: await yaHablado(input.empresa_id || ctx.tarea?.empresa_id) });
        if (faltan.length) return { error: M.guiones.motivoRechazo(faltan) };
        p.texto = M.guiones.completar(p.texto);
      }
      const r = await secuencias.guardar({ autor: ctx.agente, empresa_id: input.empresa_id || ctx.tarea.empresa_id, decisor: input.decisor, linkedin_url: input.linkedin_url, notas: input.notas, pasos: input.pasos, caduca: input.caduca });
      ctx.esperando = true;
      return { ok: true, ...r, nota: 'Está en la mesa de Dirección. Paula se encargará de los pasos siguientes en su fecha.' };
    }
    case 'anadir_paso': {
      if (PRO.guiones && input.clave === 'llamada') {
        const faltan = M.guiones.revisar(input.texto, { hablado: await yaHablado(input.empresa_id || ctx.tarea?.empresa_id) });
        if (faltan.length) return { error: M.guiones.motivoRechazo(faltan) };
        input.texto = M.guiones.completar(input.texto);
      }
      const r = await secuencias.anadirPaso({ empresa_id: input.empresa_id || ctx.tarea.empresa_id, clave: input.clave, texto: input.texto, asunto: input.asunto });
      ctx.esperando = true;
      return { ok: true, ...r, nota: 'Está en la mesa de Dirección.' };
    }
    case 'estoy_atascado': {
      const atascos = await import('./atascos.js');
      const id = await atascos.abrir({ agente: ctx.agente, motivo: input.motivo, necesita: input.quien, tarea_id: ctx.tarea.id || null, empresa_id: ctx.tarea.empresa_id || null });
      ctx.atascado = true;
      return { ok: true, atasco: id, nota: 'Queda registrado y se ha pedido ayuda. Termina la tarea con un resumen de lo que sí has podido hacer.' };
    }
    case 'leer_chat': return (await import('./chats.js')).hilo(Number(input.chat));
    case 'responder_chat': {
      const id = await (await import('./chats.js')).prepararRespuesta({ agente: ctx.agente, chatId: Number(input.chat), texto: input.texto });
      ctx.esperando = true;
      return { ok: true, aprobacion: id, nota: 'Está en la mesa de Dirección con el botón «Enviar».' };
    }
    case 'proponer_plan': {
      const r = await (await import('./objetivos.js')).proponer(input);
      ctx.esperando = true;   // Rafa queda esperando a que Dirección apruebe el plan
      return r;
    }
    case 'encargar': {
      if (input.agente === ctx.agente) throw new Error('No puedes encargarte trabajo a ti mismo: hazlo ahora o díselo a Dirección.');
      ctx.encargos = (ctx.encargos || 0) + 1;
      if (ctx.encargos > MAX_ENCARGOS_TAREA) throw new Error(`Máximo ${MAX_ENCARGOS_TAREA} encargos por tarea.`);
      if ((await tareas.creadasHoyPorOrigen(ctx.agente)) >= (ctx.agente === 'rafa' ? MAX_ENCARGOS_DIA_RAFA : MAX_ENCARGOS_DIA)) throw new Error('Has llegado al límite diario de encargos. Avisa a Dirección.');
      // La cadena: los pasos directos del mapa, y contestar a quien te lo encargó. Lo demás lo reparte Rafa
      if (!puedeEncargar(ctx.agente, input.agente) && ctx.tarea.origen !== input.agente) {
        const r = await tareas.crear('rafa', `(${AGENTES[ctx.agente].nombre} quiere pasarle esto a ${AGENTES[input.agente]?.nombre ?? input.agente}. Decide: encárgaselo tal cual, a otro compañero o díselo a Dirección.)\n${input.instruccion}`, { empresa_id: input.empresa_id || null, origen: ctx.agente });
        return { ok: true, tarea: r.id, nota: 'No es un paso directo de la cadena: se lo he pasado a Rafa, que decide a quién va.' };
      }
      const t = await tareas.crear(input.agente, input.instruccion, { empresa_id: input.empresa_id || null, origen: ctx.agente });
      await (await import('./atascos.js')).resolver(input.agente, `${AGENTES[ctx.agente]?.nombre ?? ctx.agente} le ha pasado lo que necesitaba`).catch(() => {});
      return { ok: true, tarea: t.id, ...(t.espera ? { aviso: 'Su departamento ha llegado a su tope de gasto del mes: el trabajo espera. Si corre prisa, díselo a Dirección.' } : {}) };
    }
    case 'apuntar_en_calendario': {
      ctx.citas = (ctx.citas || 0) + 1;
      if (ctx.citas > 4) return { error: 'Ya has apuntado 4 cosas en el calendario en esta tarea: con eso basta.' };
      const hoy = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(new Date());
      if (String(input.dia || '') < hoy) return { error: `El día tiene que ser hoy (${hoy}) o después, en formato AAAA-MM-DD.` };
      const emp = input.empresa_id || ctx.tarea.empresa_id || null;
      if (emp && input.tipo === 'llamada' && ['perdida', 'descartada'].includes((await q(`SELECT estado FROM empresas WHERE id=$1`, [emp])).rows[0]?.estado)) return { error: 'Esa empresa está perdida o descartada: no se apunta llamarla.' };
      if (emp && !String(input.detalle || '').trim()) return { error: 'Di en «detalle» por qué: lo que dijo o lo acordado, con su fecha. Un recordatorio sin motivo no sirve.' };
      const id = await (await import('./agenda.js')).recordar({ dia: input.dia, hora: input.hora, texto: input.texto, clase: input.tipo === 'llamada' ? 'llamada' : null, creado_por: ctx.agente,
        empresa_id: emp, telefono: input.telefono || null, detalle: input.detalle || null });
      await log(ctx.agente, `ha apuntado en tu calendario${input.tipo === 'llamada' ? ' una llamada' : ''} para el ${input.dia}${input.hora ? ` a las ${input.hora}` : ''}: ${String(input.texto).slice(0, 160)}`, { empresa_id: emp || undefined });
      return { ok: true, id };
    }
    case 'registrar_interes': return (await import('./protocolo.js')).registrar(input.empresa_id || ctx.tarea.empresa_id, input.nivel, { frase: input.frase, canal: input.canal, cuando: input.cuando, por: ctx.agente });
    case 'anotar': {
      const txt = String(input.texto ?? input.text ?? '').trim();
      if (!txt || txt === 'undefined') return { error: 'Falta el texto: llama a anotar con {"texto": "ha hecho…"}' };
      const urgente = input.urgente === true;
      const deLaLinea = input.empresa_id && (await empresas.leer(String(input.empresa_id))) ? String(input.empresa_id) : null;   // un id que no existe no deja un enlace roto
      await log(ctx.agente, txt.slice(0, 400), { empresa_id: deLaLinea || ctx.tarea.empresa_id, urgente: urgente || null });
      if (urgente) await telegram.avisar(`🔴 ${AGENTES[ctx.agente].nombre} ${txt.slice(0, 400)}`);
      ctx.anotado = true;
      return { ok: true };
    }
    case 'guardar_contacto': {
      const id = input.empresa_id || ctx.tarea.empresa_id;
      if (!id) throw new Error('Di de qué empresa es (empresa_id).');
      const c = await contactos.guardar(id, input);
      await log(ctx.agente, `ha apuntado a ${c.nombre || c.telefono || c.email}${c.cargo ? `, ${c.cargo},` : ''} en los contactos de la empresa.`, { empresa_id: id });
      return { ok: true, contacto: c.id };
    }
    case 'retirar_tarjeta': {
      const r = (await q(`UPDATE aprobaciones SET estado='superada', resuelta=now() WHERE id=$1 AND estado='pendiente' RETURNING id, titulo, empresa_id`, [String(input.id || '')])).rows[0];
      if (!r) return { error: 'Esa tarjeta ya no está en la mesa: míralo con ver_mesa.' };
      await emitir({ tipo: 'aprobacion_resuelta', id: r.id, resultado: 'superada' });
      await log(ctx.agente, `ha retirado de tu mesa «${String(r.titulo).slice(0, 100)}»: ${String(input.motivo || '').slice(0, 200)}`, { empresa_id: r.empresa_id || undefined });
      return { ok: true };
    }
    case 'limpiar_empresa': return { ok: true, ...(await (await import('./mesaViva.js')).ocurrio(input.empresa_id || ctx.tarea.empresa_id, { que: input.que })) };
    case 'ver_mesa': {
      const pend = await aprobaciones.pendientes();
      return pend.map(a => ({ a, p: aprobaciones.prioridadDe(a) })).sort((x, y) => x.p.nivel - y.p.nivel)
        .map(({ a, p }) => ({ id: a.id, agente: a.agente, tipo: a.tipo, titulo: a.titulo, empresa_id: a.empresa_id, prioridad: p.etiqueta, motivo: p.motivo, desde: a.creada, pospuesta_hasta: a.pospuesta, texto: String(a.texto || '').slice(0, 300) }));
    }
    case 'priorizar_tarjeta': {
      const ap = await aprobaciones.priorizar(input.id, input.nivel, input.motivo);
      const urgente = input.nivel === 'urgente';
      await log(ctx.agente, `${urgente ? 'pone como urgente' : `pone en «${String(input.nivel).replace('_', ' ')}»`}: ${ap.titulo}. ${String(input.motivo).slice(0, 200)}`, { aprobacion_id: ap.id, empresa_id: ap.empresa_id, urgente: urgente || null });
      if (urgente) await telegram.avisar(`🔴 ${AGENTES[ctx.agente].nombre} lo pone como urgente: ${ap.titulo}\n${String(input.motivo).slice(0, 200)}`);
      ctx.anotado = true;
      return { ok: true, id: ap.id, nivel: input.nivel };
    }
    case 'ver_cola': {
      const r = await q(`SELECT id, agente, estado, origen, left(instruccion, 160) AS instruccion, empresa_id, no_antes FROM tareas WHERE estado IN ('pendiente','en_curso') AND ($1::text IS NULL OR agente=$1) ORDER BY no_antes, id LIMIT 40`, [input.agente || null]);
      return r.rows;
    }
    case 'mover_tarea': {
      const t = await tareas.mover(Number(input.id), input.accion, input.motivo);
      await log(ctx.agente, `${input.accion === 'adelantar' ? 'adelanta' : 'cancela'} el trabajo de ${AGENTES[t.agente]?.nombre ?? t.agente}: «${t.instruccion.split('\n')[0].slice(0, 120)}». ${String(input.motivo || '').slice(0, 160)}`, { empresa_id: t.empresa_id });
      return { ok: true };
    }
    case 'guardar_nota': return { ok: true, nota: await memoria.apuntar(ctx.agente, input.texto) };
    case 'aprender': {
      // Solo al rehacer lo que Dirección ha corregido: una regla manda sobre las instrucciones, y un correo o una web no pueden dictarla
      if (ctx.tarea.origen !== 'dueno' || !String(ctx.tarea.instruccion || '').startsWith('Dirección ha pedido cambios')) throw new Error('Solo puedes aprender de una corrección de Dirección.');
      const texto = String(input.texto || '').trim().slice(0, 400);
      if (!texto) throw new Error('Falta lo que has aprendido.');
      await aprendizajes.nuevaRegla(texto, ctx.agente);
      await log(ctx.agente, `ha aprendido de tu corrección: «${texto}»`);
      return { ok: true, nota: 'Guardado: se aplica desde tu siguiente tarea. Cuéntaselo a Dirección en una línea.' };
    }
    case 'olvidar_nota': return { ok: await memoria.olvidar(ctx.agente, Number(input.id)) };
    case 'listar_publicaciones': return memoria.publicaciones(Math.min(Number(input.limite) || 40, 100));
    case 'resumen_embudo': {
      const [embudo, cat, vencidos, pend, semana, gasto, colas, objetivo, tp] = await Promise.all([
        calcularEmbudo(),
        q(`SELECT coalesce(categoria,'sin puntuar') categoria, count(*)::int n FROM empresas GROUP BY 1 ORDER BY 1`),
        empresas.seguimientosVencidos(),
        q(`SELECT a.titulo, a.agente, a.creada FROM aprobaciones a WHERE estado='pendiente' ORDER BY creada`),
        q(`SELECT agente, count(*)::int hechas FROM tareas WHERE estado='hecha' AND terminada > now() - interval '7 days' GROUP BY agente`),
        presupuesto.gastoMes(),
        q(`SELECT agente, count(*)::int pendientes, round((extract(epoch FROM now() - min(creada)) / 86400)::numeric, 1)::float dias_espera_mas_antigua
             FROM tareas WHERE estado='pendiente' GROUP BY agente ORDER BY pendientes DESC`),
        (await import('./busqueda.js')).estado(),
        (await import('./planificador.js')).topes(),
      ]);
      return { embudo, por_categoria: cat.rows, seguimientos_vencidos: vencidos, aprobaciones_pendientes: pend.rows, tareas_ultimos_7_dias: semana.rows, colas_de_trabajo: colas.rows, limite_analisis_dia: tp.mateo, objetivo_empresas: objetivo, gasto_mes_eur: gasto };
    }
    case 'guardar_regla': {
      // Las reglas que propone un agente no se activan hasta que Dirección las aprueba
      // Si es Dirección quien se lo pide a Rafa, se aplica ya: Rafa es quien manda en cómo trabaja el equipo, y se puede deshacer
      if (ctx.agente === 'rafa' && pideDueno(ctx)) {
        const r = await aprendizajes.nuevaRegla(input.texto, input.agente || null, { activa: true });
        await apuntarCambio({ tipo: 'norma', id: r.id, que: r.texto });
        await log('rafa', `ha aplicado una norma nueva${input.agente ? ` para ${AGENTES[input.agente].nombre}` : ''}: «${r.texto}»`);
        return { ok: true, nota: 'Ya se aplica. Díselo en una línea y recuérdale que se puede deshacer.' };
      }
      const r = await aprendizajes.nuevaRegla(input.texto, input.agente || null, { activa: false });
      const para = input.agente ? ` para ${AGENTES[input.agente].nombre}` : ' para todo el equipo';
      await aprobaciones.crear({ agente: ctx.agente, tipo: 'regla', titulo: `propone esta regla${para}`, texto: r.texto, ref: String(r.id) });
      ctx.esperando = true;
      return { ok: true, nota: 'Propuesta enviada a Dirección. Se aplicará cuando la apruebe. Díselo así en tu respuesta.' };
    }
    case 'quitar_norma': {
      if (!pideDueno(ctx)) return { error: SOLO_DUENO };
      if (!(await aprendizajes.quitar(Number(input.id)))) return { error: 'Esa norma no existe o ya no está activa. Míralas con ver_normas.' };
      await apuntarCambio({ tipo: 'norma_quitada', id: Number(input.id) });
      return { ok: true };
    }
    case 'ver_normas': return { normas: await aprendizajes.reglas() };
    case 'cambiar_objetivo': {
      if (!pideDueno(ctx)) return { error: SOLO_DUENO };
      const busqueda = await import('./busqueda.js');
      const antes = await busqueda.leer();
      const o = await busqueda.fijar({ cantidad: input.cantidad, periodo: input.periodo, ...(input.focos?.length ? { focos: input.focos } : {}) });
      await apuntarCambio({ tipo: 'objetivo', antes });
      await log('rafa', `ha cambiado el objetivo de empresas: ${o?.cantidad ?? 'sin objetivo'}${o ? ` al ${o.periodo === 'dia' ? 'día' : 'semana'}` : ''}.`);
      return { ok: true, objetivo: o };
    }
    case 'deshacer_cambio': {
      if (!pideDueno(ctx)) return { error: SOLO_DUENO };
      const lista = await ajuste('cambios_rafa', []), c = lista.pop();
      if (!c) return { error: 'No hay ningún cambio que deshacer.' };
      if (c.tipo === 'norma') await aprendizajes.quitar(c.id);
      if (c.tipo === 'norma_quitada') await aprendizajes.activar(c.id);
      if (c.tipo === 'objetivo') await (await import('./busqueda.js')).fijar(c.antes ? { ...c.antes } : { cantidad: '' });
      await fijarAjuste('cambios_rafa', lista);
      await log('rafa', `ha deshecho su último cambio (${c.tipo}).`);
      return { ok: true, deshecho: c };
    }
    case 'apuntar_fallo': {
      const fallos = await ajuste('fallos_app', []);
      fallos.push({ cuando: new Date().toISOString(), texto: String(input.texto).slice(0, 1000) });
      await fijarAjuste('fallos_app', fallos.slice(-100));
      return { ok: true, nota: 'Apuntado para arreglarlo. Díselo a Dirección en una línea.' };
    }
    case 'preparar_correo': {
      const r = await correo.preparar({ agente: ctx.agente, empresa_id: input.empresa_id || ctx.tarea.empresa_id, para: input.para, asunto: input.asunto, texto: input.texto, adjuntar_documento: input.adjuntar_documento, en_respuesta_a: input.en_respuesta_a });
      ctx.esperando = true;
      return { ok: true, ...r, nota: 'Está en la mesa de Dirección con el botón «Enviar».' };
    }
    case 'resumen_origenes': {
      const [porOrigen, web, ali] = await Promise.all([empresas.embudoPorOrigen(), entradas.recientes(10), alianzas.resumen()]);
      return { por_origen: porOrigen, ultimos_contactos_web: web.map(({ datos, ...e }) => e), alianzas: ali,
        nota: 'busqueda = las que encontramos nosotros (Lucía). Con menos de 10 casos por canal, no hay conclusiones.' };
    }
    case 'listar_alianzas': return alianzas.listar(input);
    case 'guardar_alianzas': {
      const r = await alianzas.guardar(input.alianzas || []);
      if (r.creadas.length) await log(ctx.agente, `ha añadido ${r.creadas.length} alianza${r.creadas.length === 1 ? '' : 's'}: ${r.creadas.slice(0, 3).map(a => a.nombre).join(', ')}${r.creadas.length > 3 ? '…' : ''}`);
      return r;
    }
    case 'actualizar_alianza': return { ok: true, alianza: await alianzas.actualizar(input.id, input.campos || {}) };
    case 'leer_boletines': return { boletines: await correo.boletines(Math.min(30, Number(input.dias) || 7)) };
    case 'resumen_canales': {
      const [sec, aceptacion, respuestas, pasos, tiempos] = await Promise.all([
        q(`SELECT estado, count(*)::int n FROM secuencias WHERE estado <> 'descartada' GROUP BY 1`),
        q(`SELECT estado AS resultado, count(*)::int n FROM aprobaciones WHERE ref LIKE 'ctl:%' AND titulo LIKE '%ha aceptado%' AND estado <> 'pendiente' GROUP BY 1`),
        q(`SELECT p.clave AS paso, p.canal, count(*)::int respuestas FROM aprobaciones a JOIN pasos p ON a.ref = 'paso:' || p.id
             WHERE a.estado = 'respondido' GROUP BY 1, 2 ORDER BY 3 DESC`),
        q(`SELECT p.clave AS paso, p.canal, p.estado, count(*)::int n FROM pasos p JOIN secuencias s ON s.id = p.secuencia_id
             WHERE s.estado <> 'descartada' GROUP BY 1, 2, 3 ORDER BY 1, 3`),
        q(`SELECT round(avg(extract(epoch FROM s.actualizada - c.hecho) / 86400)::numeric, 1)::float dias_hasta_respuesta, count(*)::int n
             FROM secuencias s JOIN pasos c ON c.secuencia_id = s.id AND c.clave = 'conexion' AND c.hecho IS NOT NULL WHERE s.estado = 'respondida'`),
      ]);
      return { secuencias_por_estado: sec.rows, preguntas_de_aceptacion: aceptacion.rows, respuestas_por_paso: respuestas.rows, pasos_por_estado: pasos.rows,
        tiempo_hasta_respuesta: tiempos.rows[0], nota: 'Con menos de 10 casos, no hay conclusiones: muestra pequeña.' };
    }
    case 'enviar_informe': {
      await telegram.avisar(`📊 Informe de ${AGENTES[ctx.agente].nombre}\n\n${input.texto}`);
      const primera = String(input.texto).split('\n').find(l => l.trim()) || 'Informe';
      const informe_id = await guardarInforme({ agente: ctx.agente, titulo: primera.slice(0, 120), texto: String(input.texto), empresa_id: ctx.tarea.empresa_id });
      await log(ctx.agente, `ha enviado el informe: ${primera.slice(0, 200)}`, { informe_id, empresa_id: ctx.tarea.empresa_id });
      // Lo importante llega también por el chat (en su canal si Dirección se lo pidió ahí; si no, en #general), con el informe enlazado
      await (await import('./chat.js')).escribir({ canal: ctx.tarea.canal || 'general', autor: ctx.agente, para: 'dueno', texto: `📊 ${primera.slice(0, 200)}`, tarea_id: ctx.tarea.id || null, informe_id, empresa_id: ctx.tarea.empresa_id }).catch(e => console.error('Chat:', e.message));
      ctx.anotado = true;
      return { ok: true, telegram: telegram.activo() };
    }
    default: throw new Error(`Herramienta desconocida: ${nombre}`);
  }
}
