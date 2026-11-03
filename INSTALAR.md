# Instalar la oficina en un servidor, paso a paso

Esta guía es para quien nunca ha instalado nada en un servidor. No hace falta saber programar: casi todo es copiar y pegar. Calcula una hora.

## Cinco palabras que vas a ver

| Palabra | Qué es |
|---|---|
| **Servidor** | Un ordenador alquilado que está siempre encendido. Ahí vive la oficina, aunque apagues el tuyo. |
| **Terminal** | La ventana donde se escriben órdenes. Sirve para manejar el servidor desde tu ordenador. |
| **Docker** | El programa que instala y arranca la oficina y su base de datos con una sola orden. |
| **Dominio** | La dirección web, por ejemplo `oficina.tuempresa.com`. |
| **HTTPS** | El candado del navegador. Hace que lo que escribes viaje cifrado. Aquí se pone solo. |

## Lo que necesitas antes de empezar

- **Un servidor** con Ubuntu 24.04 y al menos 2 GB de memoria. Sirve cualquier proveedor de «VPS»: Hetzner, OVH, Hostinger, IONOS… Suele costar entre 5 y 10 € al mes.
- **Un dominio**, que puede ser uno que ya tengas para tu web.
- **Una clave de IA**, de [platform.claude.com](https://platform.claude.com) o de [openrouter.ai](https://openrouter.ai). La pegarás al final, en la propia oficina. Lo que gastan los agentes se lo pagas a ese proveedor. La oficina trae un tope de 50 € al mes y puedes cambiarlo.

## Paso 1. Contrata el servidor

Al contratarlo, elige **Ubuntu 24.04** como sistema. Al terminar, el proveedor te da dos datos. Apúntalos:

- **La IP**, cuatro números como `203.0.113.10`.
- **La contraseña de `root`**, que es el usuario principal del servidor.

## Paso 2. Apunta tu dominio al servidor

Entra donde compraste el dominio y busca la zona «DNS». Crea un registro nuevo:

| Campo | Qué poner |
|---|---|
| Tipo | `A` |
| Nombre | `oficina` |
| Valor o destino | La IP del servidor |

Tu oficina estará en `oficina.tuempresa.com`. El cambio tarda desde unos minutos hasta unas horas. Para saber si ya está, escribe esto en la terminal de tu ordenador: tiene que salir la IP de tu servidor.

```bash
ping -c 1 oficina.tuempresa.com
```

## Paso 3. Entra en el servidor

Abre la terminal de tu ordenador. En Mac se llama **Terminal**. En Windows, **PowerShell**. Escribe esto con tu IP:

```bash
ssh root@203.0.113.10
```

- La primera vez pregunta si te fías del servidor: escribe `yes` y pulsa Intro.
- Después pide la contraseña. **Al escribirla no se ve nada**: es normal. Escríbela o pégala y pulsa Intro.

Si la línea de la terminal ahora empieza por `root@`, ya estás dentro. A partir de aquí, todo se pega en esa ventana.

## Paso 4. Instala lo necesario

Pega estas órdenes de una en una y espera a que termine cada una.

Pone el servidor al día. Si sale una pantalla preguntando algo, pulsa Intro:

```bash
apt update && apt upgrade -y
```

Instala Docker:

```bash
curl -fsSL https://get.docker.com | sh
```

Instala Git, que sirve para descargar la oficina:

```bash
apt install -y git
```

Cierra todas las puertas menos las necesarias:

```bash
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
```

Algunos proveedores tienen además un cortafuegos en su web. Si es tu caso, abre allí los puertos 22, 80 y 443.

## Paso 5. Descarga la oficina

Cambia `DIRECCION-DEL-REPOSITORIO` por la que sale en GitHub, en el botón verde «Code». Si el repositorio es privado, te pedirá tu usuario y un token: se crea en GitHub, en Settings › Developer settings › Personal access tokens.

```bash
cd /opt && git clone DIRECCION-DEL-REPOSITORIO oficina && cd oficina
```

## Paso 6. Rellena la configuración

Crea tu archivo de configuración:

```bash
cp .env.example .env
```

Esta orden inventa una contraseña larga. Ejecútala **dos veces** y guarda las dos en un sitio seguro, como un gestor de contraseñas:

```bash
openssl rand -hex 24
```

Abre el archivo:

```bash
nano .env
```

Muévete con las flechas y rellena estas líneas:

| Línea | Qué poner |
|---|---|
| `DB_PASSWORD=` | La primera contraseña inventada. **No la cambies nunca después de arrancar.** |
| `CLAVE_CIFRADO=` | La segunda contraseña inventada. Tampoco la cambies: si cambia, tendrás que volver a pegar tus claves. |
| `PANEL_PASSWORD=` | La contraseña con la que entrarás a la oficina. Elige una que puedas escribir y que sea larga. |
| `PANEL_URL=` | `https://oficina.tuempresa.com` |
| `DOMINIO=` | `oficina.tuempresa.com`, sin `https://` |

Lo demás, déjalo como está. Para guardar y salir, pulsa `Ctrl+O`, luego Intro y luego `Ctrl+X`.

## Paso 7. Arranca la oficina

La primera vez tarda varios minutos:

```bash
docker compose up -d --build
```

Comprueba que está funcionando:

```bash
docker compose ps
```

Tienen que salir tres líneas: `agentes-db`, `agentes-oficina` y `agentes-caddy`, todas con `Up`. Si alguna dice `Restarting`, mira [Si algo falla](#si-algo-falla).

## Paso 8. Entra

Abre `https://oficina.tuempresa.com` en tu navegador. La primera vez puede tardar un minuto, mientras se prepara el candado.

1. Escribe la contraseña que pusiste en `PANEL_PASSWORD`.
2. Pega tu clave de IA.
3. Rafa, el director de la oficina, te hará unas preguntas sobre tu empresa. Esa conversación cuesta unos 30 céntimos de IA y nadie más trabaja hasta que termine.

Ya está en marcha. Telegram, el correo, LinkedIn y lo demás son opcionales: los tienes en [CONFIGURACION.md](CONFIGURACION.md).

## El día a día

Para todo esto, entra primero en el servidor como en el paso 3 y pega:

```bash
cd /opt/oficina
```

Actualizar a la última versión:

```bash
git pull && docker compose up -d --build
```

Ver qué está pasando:

```bash
docker compose logs --tail 50 oficina
```

Reiniciar la oficina:

```bash
docker compose restart oficina
```

Pararla. Tus datos no se borran, están en la carpeta `data`:

```bash
docker compose down
```

Volver a arrancarla:

```bash
docker compose up -d
```

## Copias de seguridad

**Hazlo el primer día.** Sin copia, si el servidor falla pierdes tus empresas y contactos.

Esto deja una copia cada noche a las 3:30. Guarda una por cada día de la semana y va sobrescribiendo las antiguas:

```bash
mkdir -p /opt/copias && (crontab -l 2>/dev/null; echo '30 3 * * * docker exec agentes-db pg_dump --clean --if-exists -U agentes agentes | gzip > /opt/copias/oficina-$(date +\%a).sql.gz') | crontab -
```

Esas copias están en el mismo servidor, así que no te salvan si se pierde entero. De vez en cuando bájate una a tu ordenador, con esta orden en tu ordenador y no en el servidor:

```bash
scp root@203.0.113.10:/opt/copias/oficina-Mon.sql.gz .
```

Guarda también tu archivo `.env` en lugar seguro. Sin `CLAVE_CIFRADO` no se pueden leer las claves que pegaste en el panel. Muchos proveedores ofrecen además copias del servidor entero por unos euros al mes.

Para recuperar una copia:

```bash
docker compose stop oficina
```

```bash
gunzip -c /opt/copias/oficina-Mon.sql.gz | docker exec -i agentes-db psql -q -U agentes agentes
```

```bash
docker compose start oficina
```

## Si algo falla

| Qué pasa | Qué hacer |
|---|---|
| La web no abre o avisa de un problema de seguridad | Comprueba con el `ping` del paso 2 que el dominio ya apunta a tu IP. Mira que los puertos 80 y 443 estén abiertos en el cortafuegos del proveedor. Luego mira qué dice: `docker compose logs --tail 30 caddy` |
| `Falta DB_PASSWORD en .env` | No has creado el archivo `.env` o estás en otra carpeta. Vuelve al paso 6 y comprueba que estás en `/opt/oficina`. |
| `agentes-oficina` dice `Restarting` | Mira el motivo con `docker compose logs --tail 30 oficina`. Suele ser una línea de `.env` mal escrita, y el mensaje dice cuál. |
| `agentes-caddy` no arranca y sale `address already in use` | Ya hay otra web en ese servidor usando los puertos 80 y 443. Lo más fácil es usar un servidor solo para la oficina. Si sabes lo que haces, borra la línea `COMPOSE_PROFILES=https` de `.env` y usa tu propio proxy, con `Caddyfile.ejemplo` como modelo. |
| Falla la base de datos después de cambiar `DB_PASSWORD` | La contraseña solo se aplica la primera vez. Vuelve a poner la de antes en `.env` y ejecuta `docker compose up -d`. |
| Se queda a medias en el paso 7 o se cierra sola | Puede que falte memoria. Pega esto y repite el paso 7: `fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile` |
| He olvidado la contraseña de entrada | Cámbiala en `PANEL_PASSWORD` con `nano .env` y ejecuta `docker compose up -d`. |

Si no das con ello, los últimos mensajes de `docker compose logs --tail 50 oficina` suelen decir qué falta. Quita antes cualquier contraseña si se los enseñas a alguien.
