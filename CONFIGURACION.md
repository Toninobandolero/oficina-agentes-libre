# Configuración: todo lo que hay que conectar

Guía para poner en marcha la oficina desde cero y conectar cada servicio. Para instalarla en el servidor (Docker, dominio, Caddy), mira primero [README.md](README.md).

**Regla de oro:** las claves nunca van en el repositorio. Unas van en el archivo `.env` (que está en `.gitignore`) y otras se pegan en el panel, que las guarda **cifradas** en la base de datos.

**La primera vez que abres el panel**, te pide tu clave de IA y, con ella, Rafa te ayuda a configurar la empresa, la imagen de marca y el presupuesto. Esta guía es para conectar el resto, cuando quieras.

## Resumen

| Pieza | Para qué sirve | ¿Obligatoria? | Dónde se configura |
|---|---|---|---|
| [Inteligencia artificial](#0-inteligencia-artificial) | El cerebro de los agentes: Claude (o OpenRouter) | Sí | Panel → ☰ Menú → Configuración → Inteligencia artificial |
| [Contraseña y clave de cifrado](#1-lo-imprescindible-env) | Entrar al panel y cifrar lo que se guarda | Sí | `.env` |
| [Tu empresa](#2-tu-empresa-mi-empresa) | Lo que los agentes saben de ti, tu zona y tu tono | Sí | Panel → ☰ Menú → Mi empresa |
| [Presupuesto y ritmo](#3-presupuesto-y-ritmo) | Cuánto puede gastar el equipo y a qué ritmo trabaja | Recomendada | Panel (clic en «IA: …») o `.env` |
| [Telegram (bot de la oficina)](#4-telegram) | Avisos y aprobaciones en el móvil | Recomendada | `.env` |
| [Correo de la oficina](#5-correo) | Enviar y leer correo; avisos de LinkedIn | Opcional | `.env` |
| [LinkedIn](#6-linkedin) | Publicar los posts aprobados | Opcional | `.env` + panel |
| [Facebook](#7-facebook) | Publicar en tu página | Opcional | Panel |
| [Bot de contacto de Telegram](#8-bot-de-contacto-de-telegram) | Que los clientes te escriban y Paula prepare la respuesta | Opcional | Panel |
| [Formulario de tu web](#9-formulario-de-tu-web) | Que los formularios de tu web lleguen a la oficina | Opcional | `.env` + tu web |
| [Calendario en el móvil](#10-calendario-en-el-movil) | Ver posts, llamadas y citas en tu calendario | Opcional | Panel → 📅 Calendario |

---

## 0. Inteligencia artificial

Panel → ☰ Menú → ⚙️ Configuración → **🧠 Claves de IA**. Las claves se pegan ahí, se comprueban antes de guardarlas y se guardan cifradas (no se vuelven a mostrar).

- **Claude (API de Anthropic)**, recomendado. Crea la clave en platform.claude.com → *API keys* (sin caducidad). Si tienes **plan Max de Claude**, activa primero sus créditos de API: claude.ai → Configuración → Facturación → **Créditos de API** → vincular la organización (pon «Continuar sin tarjeta» si no quieres que te cobren nada aparte). Sin plan Max, compra saldo en platform.claude.com.
- Activa la **búsqueda web** en platform.claude.com (Seguridad y datos), si aparece la opción: la necesita Lucía.
- **OpenRouter**, opcional: como proveedor principal (pago por uso) o como **respaldo** si se acaba el crédito de Claude. Con el respaldo, la oficina avisa al cambiar y vuelve sola a Claude cuando hay crédito. Ponle también un límite de gasto en openrouter.ai.
- El gasto (hoy, semana, mes, por agente y por proveedor) está en «IA: … €», arriba en el panel.

## 1. Lo imprescindible (`.env`)

Copia `.env.example` como `.env` y rellena como mínimo:

```env
DB_PASSWORD=una-larga-inventada
PANEL_PASSWORD=la-contraseña-del-panel
PANEL_URL=https://agentes.tudominio.com
CLAVE_CIFRADO=otra-larga-inventada  # cifra las claves que pegas en el panel
```

> ⚠️ **`CLAVE_CIFRADO`**: si no la pones, se calcula a partir de `PANEL_PASSWORD` y `DATABASE_URL`. Entonces, si un día cambias la contraseña del panel, las claves guardadas (Zadarma, LinkedIn, Facebook…) dejan de poder leerse y hay que volver a pegarlas. Ponla desde el principio y no la cambies.

Los modelos de cada agente se cambian con `MODELO_<AGENTE>` (por ejemplo `MODELO_JAVI=anthropic/claude-sonnet-5.5`). Dejándolos vacíos se usan los recomendados.

## 2. Tu empresa («Mi empresa»)

Panel → ☰ Menú → ⚙️ Configuración → **Datos de la empresa**. Es lo primero que conviene rellenar, porque todos los agentes lo leen:

- Nombre, web, teléfono (el que das a los clientes) y **localidad** (también sirve para el tiempo del paisaje).
- Qué vendes, precios orientativos, cliente ideal, sectores, en qué te diferencias y casos de éxito.
- Tu presentación, tu tono al escribir y lo que **nunca** hay que decir.

Rafa lee tu web y la resume en cuanto la guardas.

En **Imagen de marca**, al lado, defines el logo, los colores, la letra de los titulares, el lema, la web y las normas de uso. Las imágenes de los posts salen solas con esa marca, y ves una muestra antes de guardar. Todos los agentes lo leen. Lo que dejes vacío sale con el diseño original.

## 3. Presupuesto y ritmo

Pulsa en **«IA: … €»** (arriba) y verás:

- **Tope semanal o mensual** de gasto en IA. Al llegar al 80 % avisa; al llegar al 100 % el equipo se para solo y vuelve cuando hay margen.
- **Empujón**: +5, +10, +25 o +50 € para la semana o el mes en curso.
- **«Esta semana nada»**: tope a 0 € solo para ese periodo (vacaciones).
- **Empresas a buscar**: cuántas quieres encontrar a la semana o al día. Te dice cuánto costará y cuántos contactos te dejará en la mesa. Con 0, esta oficina no busca (para quien ya tiene cartera). En blanco, Lucía busca cuando se vacía la cola. El coste es orientativo hasta que haya gasto real: luego se calcula con el de los últimos 60 días, y no incluye seguimientos, respuestas, informes ni llamadas de Lola.
- **Google Maps (opcional)**: pega tu clave para que Lucía y Carmen saquen negocios por zona y sector. Créala en console.cloud.google.com con «Places API (New)» activada. Sus condiciones limitan qué se puede guardar. Cada consulta cuenta unos 0,03 € en tu presupuesto, aunque Google regala unas cuantas al mes.
- **🚀 Modo turbo**: sin topes diarios. Empieza al activarlo y reparte trabajo cada 30 segundos, a cualquier hora. Lucía busca sin parar, Mateo y Carmen puntúan y preparan dossiers, y trabajan más agentes a la vez, hasta agotar el presupuesto. Si tu mesa se llena, los redactores esperan; si estás de vacaciones, no empieza trabajo nuevo.

Por Telegram: `/turbo`, `/turbo off`, `/empujon 10`.

El valor inicial sale de `PRESUPUESTO_EUR` (euros al mes). Los topes del ritmo normal se ajustan en `.env`:

| Variable | Qué hace | Por defecto |
|---|---|---|
| `MAX_ANALISIS_DIA` | Empresas que Mateo puntúa al día (ritmo normal; sube solo si el objetivo pide más) | 40 |
| `CONCURRENCIA` | Agentes trabajando a la vez (en turbo, +2) | 2 |
| `BUSQUEDAS_AUTO` | Qué busca Lucía, separado por `\|` (rota entre ellas) | — |
| `EMPRESAS_POR_BUSQUEDA` | Empresas por búsqueda | 8 |
| `BORME_PROVINCIA` | Provincia que se mira por defecto en el Registro Mercantil. Vacío: el agente indica cuál | — |
| `SECTORES_PRIORITARIOS` | Sectores en los que se centra el equipo | — |

## 4. Telegram

Es por donde te llegan los avisos y desde donde puedes aprobar, encargar y preguntar.

1. En Telegram, habla con **@BotFather** → `/newbot` → copia el **token**.
2. Escribe cualquier cosa a tu bot nuevo.
3. Abre `https://api.telegram.org/bot<TOKEN>/getUpdates` y copia el número de `"chat":{"id": …}`.
4. En `.env`:

```env
TELEGRAM_TOKEN=123456:ABC...
TELEGRAM_CHAT_ID=123456789
TELEGRAM_USER_ID=123456789   # en un chat privado es el mismo número
```

El bot solo obedece a ese chat. Escribe `/ayuda` para ver los comandos.

**Horas de silencio** (opcional): `SUENO_DESDE=23:30` y `SUENO_HASTA=08:00`. En ese rato Telegram calla y al despertar te llega un resumen.

## 5. Correo

Un buzón para la oficina (por ejemplo `oficina@tudominio.com`), distinto del tuyo. Con Hostinger:

```env
CORREO_USUARIO=oficina@tudominio.com
CORREO_CLAVE=la-contraseña-del-buzón
CORREO_SMTP=smtp.hostinger.com:465
CORREO_IMAP=imap.hostinger.com:993
CORREO_NOMBRE=Tu Empresa
```

Nada sale sin tu aprobación, y no se envía correo en frío (LSSI): solo a quien ya te ha escrito o te ha dado permiso.

**Boletín.** Álex lo prepara el primer martes de cada mes y te llega a la mesa con el botón «📧 Enviar a N interesados». Lo reciben quienes se apuntaron en tu web con su permiso (formulario con `tipo: oficina`, en la sección del formulario de tu web). Sale uno cada 30 segundos, como mucho 90 al día, y cada correo lleva su enlace de baja. Para conectarlo:

1. En Hostinger, entra en **Correos** y crea el buzón `oficina@tudominio.com`, si no lo tienes. Apunta su contraseña.
2. En el servidor, abre el `.env` de la oficina y pon las líneas de arriba, además de `PANEL_URL`, que hace falta para el enlace de baja.
3. Reinicia la oficina: `docker compose up -d`.
4. En Hostinger, mira que el dominio tenga bien SPF y DKIM: sin eso, el correo suele acabar en spam. Hostinger te dice si falta algo.
5. Antes de enviar a la lista, pulsa **🧪 Enviarme una prueba** en la tarjeta. Te llega solo a ti, con «[Prueba]» en el asunto, y la tarjeta sigue en la mesa. Si la contraseña está mal, te lo dice ahí. Su enlace de baja no da de baja a nadie.

**Avisos de LinkedIn.** LinkedIn no deja leer mensajes ni comentarios por su API. El truco es que te lleguen por correo:

- En LinkedIn, deja activados los avisos por correo.
- En tu correo, crea una regla que **reenvíe** a `oficina@` los correos de `linkedin.com`.
- Añade los remitentes de LinkedIn a tus contactos para que no acaben en spam.

Con eso la oficina se entera sola de quién acepta tu invitación, quién te contesta y quién comenta.

## 6. LinkedIn

Para publicar en tu perfil los posts que apruebes:

1. En [linkedin.com/developers](https://www.linkedin.com/developers/) crea una app asociada a una página de empresa.
2. Añade los productos **Share on LinkedIn** y **Sign In with LinkedIn using OpenID Connect**.
3. En *Auth*, en *Authorized redirect URLs*, pon `https://TU-DOMINIO/api/linkedin/vuelta`.
4. En `.env`, pon `LINKEDIN_CLIENT_ID=…` (el *Client ID*).
5. En el panel → **Tu mesa** → LinkedIn, pega el *Client Secret* y pulsa **Conectar LinkedIn**.

El permiso dura 60 días y LinkedIn no deja renovarlo solo: la oficina te avisa antes de que caduque.

## 7. Facebook

Para publicar en la página de tu empresa:

1. En [developers.facebook.com](https://developers.facebook.com/) crea una app de tipo **Empresa**.
2. Añade **Inicio de sesión con Facebook para empresas**.
3. Pon como URL de redirección válida `https://TU-DOMINIO/api/facebook/vuelta`.
4. Permisos necesarios: `pages_show_list`, `pages_read_engagement` y `pages_manage_posts`.
5. En el panel → **Tu mesa** → Facebook, pega el *App ID* y la *clave secreta* y pulsa **Conectar Facebook**. Elige tu página.

El token de página no caduca.

## 8. Bot de contacto de Telegram

Es un **segundo** bot (distinto del de la oficina) para que los clientes te escriban: el primer mensaje se contesta al momento con un acuse y Paula prepara la respuesta de verdad, que envías tú.

1. Crea otro bot con **@BotFather**.
2. En el panel → **Tu mesa** → Bot de contacto, pega su token.
3. Pon el enlace `t.me/tu_bot` en tu web y tus perfiles.

## 9. Formulario de tu web

Los formularios de tu web pueden mandar a la oficina los contactos, diagnósticos o cálculos:

```env
ENTRADA_ORIGENES=https://tudominio.com,https://www.tudominio.com
```

Desde tu web, envía un `POST https://TU-DOMINIO/api/entrada` con JSON:

```json
{ "tipo": "contacto", "nombre": "Ana", "empresa": "Bar Ana", "email": "ana@bar.es",
  "telefono": "600000000", "mensaje": "…", "consentimiento": true, "sitio_web": "" }
```

- `tipo` es `contacto`, `diagnostico`, `calculadora` u `oficina`. Con `oficina`, la persona va a tu lista de interesados: no entra en el embudo y, si manda `consentimiento`, recibe el boletín.
- `sitio_web` es una trampa para robots: déjalo vacío y oculto.

La empresa entra en «conversación», te llega el aviso y Paula o Nuria preparan la respuesta.

## 10. Calendario en el móvil

Panel → **📅 Calendario** → **📲 En el móvil**. Copia la dirección (`webcal://…`) y añádela como **calendario suscrito**:

- **iPhone**: Ajustes → Calendario → Cuentas → Añadir cuenta → Otra → *Añadir calendario suscrito*.
- **Google Calendar**: en la web, *Otros calendarios* → *Desde URL*.

Ahí verás los posts programados, las llamadas que devolver (con aviso 10 minutos antes), los seguimientos y las reuniones. La dirección es secreta: si se filtra, genera una nueva desde el mismo sitio.

## 11. Comprobar que todo va

- [ ] El panel abre y pide contraseña. Arriba pone la fecha y la hora, y el gasto de IA.
- [ ] `/estado` en Telegram responde.
- [ ] Encarga una prueba: `/encargar lucia Busca 3 grupos de hostelería en Madrid`. Verás a Lucía trabajar y luego a Mateo puntuar.
