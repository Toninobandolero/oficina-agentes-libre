# Seguridad

## Si encuentras un fallo

**No abras una incidencia pública.** Avísanos en privado con el botón **Security → Report a vulnerability** de este repositorio en GitHub. Cuéntanos qué has visto, cómo repetirlo y qué podría hacer alguien con ello. Contestamos lo antes posible y, cuando esté arreglado, te citamos si quieres.

*English: please report vulnerabilities privately with the "Report a vulnerability" button (Security tab), not in a public issue.*

## Lo que ya protege la oficina

- **Panel con contraseña** (10 caracteres o más; sin ella la oficina no arranca), sesión en una cookie `HttpOnly` y `SameSite=Strict`, y freno a los intentos repetidos.
- **Las órdenes solo valen desde el propio panel** (JSON y mismo origen), así que otra web no puede darlas por ti.
- **Las claves** (IA, Telegram, LinkedIn, Facebook…) se guardan cifradas (AES-256-GCM) y el panel solo enseña las cuatro últimas letras.
- **Lo que se envía a un tercero pasa antes por ti.** La única excepción es la publicación automática en LinkedIn o Facebook, que solo funciona si la activas tú.
- **Las páginas que leen los agentes** no pueden ser de la red interna del servidor (ni `localhost`, ni direcciones privadas, ni por redirección).
- La base de datos y el puerto de la aplicación solo escuchan dentro del propio servidor; al público se llega por el HTTPS de Caddy.

## Lo que tienes que cuidar tú

- **Pon HTTPS** (el `docker-compose.yml` lo trae con Caddy). Sin HTTPS, la contraseña viaja a la vista de todos.
- **Contraseña larga y que no uses en otro sitio.** Inventa también `CLAVE_CIFRADO` y guárdala aparte.
- **Copias de seguridad** de `data/postgres`, y mantén al día Docker y las imágenes (`docker compose pull && docker compose up -d --build`).
- **No abras el puerto de la base de datos** ni el de la aplicación en el cortafuegos.

## Límites que conviene conocer

- Los agentes leen webs, correos y formularios de desconocidos. Un texto malicioso puede intentar darle «órdenes» al modelo. Por eso nada sale sin tu aprobación: **mira bien destinatarios y enlaces antes de aprobar.**
- La lectura de páginas comprueba que la dirección no sea interna, pero no protege del todo frente a un dominio que cambie de dirección a mitad de camino. Si el servidor tiene otras cosas en su red interna, pon la oficina en una red aparte.
- Es un proyecto pequeño y no ha pasado una auditoría externa. Úsalo con ese criterio.
