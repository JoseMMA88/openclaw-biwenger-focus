# openclaw-biwenger-focus

Plugin de OpenClaw para gestionar focos automáticos de subasta en Biwenger con estrategia conservadora.

## Features

- Tools públicas:
  - `biwenger_focus_create`
  - `biwenger_focus_status`
  - `biwenger_focus_list`
  - `biwenger_focus_update`
  - `biwenger_focus_cancel`
  - `biwenger_clause_schedule_create`
  - `biwenger_clause_schedule_status`
  - `biwenger_clause_schedule_list`
  - `biwenger_clause_schedule_update`
  - `biwenger_clause_schedule_cancel`
  - `biwenger_market_report_status`
  - `biwenger_market_report_now`
- Integración con `biwenger-mcp` local vía `stdio`.
- Persistencia SQLite.
- Worker de pujas en segundo plano con límite estricto y cooldown.
- Informe diario con dos bloques separados:
  - Mercado diario (altas, subidas y recomendados por momentum de precio).
  - Subastas/pujas (actividad y subidas en subasta).
- Notificaciones por Telegram + logs JSON.

## Requisitos

- Node.js 22+
- OpenClaw `2026.x`
- `biwenger-mcp` compilado (ej. `/opt/biwenger-mcp/dist/server.js`)

## Instalación local

```bash
npm install
npm run build
npm test
```

## Variables de entorno

Copia `.env.example` a `.env` y ajusta:

- `MCP_COMMAND=/usr/bin/node` (recomendado en systemd)
- `MCP_ARGS=/opt/biwenger-mcp/dist/server.js`
- `MCP_CWD=/opt/biwenger-mcp` (recomendado)
- `FOCUS_DB_PATH=/var/lib/openclaw/biwenger-focus.db`
- `TELEGRAM_BOT_TOKEN=...`
- `TELEGRAM_CHAT_ID=...`
- `TZ=Europe/Madrid`
- `FOCUS_BIDDING_POLL_SEC=900` (15 min en estado `BIDDING`)
- `FOCUS_ARMED_MAX_POLL_SEC=900` (tope de polling en `ARMED`)
- En `ARMED`, el siguiente ciclo se programa para despertar cerca de la ventana de 1h, sin superar el tope configurado.
- `MARKET_REPORT_ENABLED=true` (activar informe diario de mercado)
- `MARKET_REPORT_HOUR=9` (hora local del informe diario)
- `MARKET_REPORT_MINUTE=0` (minuto local del informe diario)
- `MARKET_REPORT_OPENING_ONLY=true` (por defecto; solo consulta API cuando el informe está vencido por hora, ideal para "foto de apertura")
- `MARKET_REPORT_TICK_SEC=60` (frecuencia de comprobación del scheduler; si `MARKET_REPORT_OPENING_ONLY=true`, no implica llamadas a API fuera de ventana)
- `MARKET_REPORT_TOP_LIMIT=10` (máximo de jugadores por bloque del informe)
- Credenciales Biwenger para el MCP:
  - `BIWENGER_TOKEN` **o** `BIWENGER_EMAIL` + `BIWENGER_PASSWORD`
  - `BIWENGER_LEAGUE_ID`
  - `BIWENGER_USER_ID`

## Automatizacion del interruptor de subastas

El workflow `Biwenger auction settings` prepara el estado que Biwenger aplicara a las 07:00 del dia siguiente:

- Jueves alrededor de las 23:00, hora de Madrid: configura `auctions=true` y `auctionsFreePlayers=15`.
- Domingo alrededor de las 20:00, hora de Madrid: configura `auctions=false` y `auctionsFreePlayers=0`.
- Ejecucion manual: permite elegir `open` o `close` desde GitHub Actions.

El cron principal usa `timezone: Europe/Madrid`: jueves a las 23:07 para abrir y domingo a las 20:07 para cerrar, con cambio de hora automatico. La accion se obtiene del cron de origen, no de la hora a la que GitHub termine iniciando el job. Si una ejecucion programada llega fuera de su ventana anterior a las 07:00, falla y requiere revision manual. Las ejecuciones manuales `open` y `close` son explicitas y permiten actuar fuera de esa ventana.

Antes de escribir consulta la liga, no envia cambios si `auctions` y `auctionsFreePlayers` ya tienen los valores deseados y vuelve a consultar despues para verificar ambos. El job falla si detecta que Biwenger ha modificado cualquier otro ajuste, incluidas las clausulas. Las peticiones tienen un timeout de 15 segundos que incluye la lectura del cuerpo. Las lecturas y el login hacen como maximo tres intentos para errores de red, HTTP 408, 429 y 5xx, con espera y `Retry-After` limitado a 30 segundos. No se reintentan automaticamente errores de credenciales o permisos.

Un `PUT` interrumpido puede haberse guardado: se vuelve a leer la liga antes de repetirlo. Si los valores ya son correctos no se repite; si siguen incorrectos se permite una segunda escritura tras esperar, usando los metadatos recien leidos. Nunca se repite una escritura si se detectan cambios ajenos o ya ha vencido el plazo del ciclo. El timeout global de cada job sigue siendo de 10 minutos.

Las peticiones no incluyen `X-Version`. Se ha comprobado con autenticacion que Biwenger acepta el login, la consulta de cuenta, la lectura de liga y el guardado de ajustes sin esa cabecera. Asi se evita fijar una version de cliente que Biwenger pueda retirar. Esto no garantiza compatibilidad con futuros cambios de la API.

### Supervisor y alertas

El segundo workflow `Biwenger auction supervisor` se programa cada hora al minuto 37 UTC. Calcula su ventana usando Madrid en el momento real de ejecucion:

- Comprueba siempre que el workflow principal este activo. El principal comprueba a su vez que el supervisor este activo.
- Desde el jueves a las 23:00 hasta el viernes antes de las 07:00, comprueba y repara la apertura; desde el domingo a las 20:00 hasta el lunes antes de las 07:00, comprueba y repara el cierre.
- Tras 90 minutos de margen desde el inicio de la ventana, avisa si no consta una ejecucion correcta del workflow principal, aunque el supervisor haya reparado los ajustes.
- De las 07:00 a las 12:00 del viernes y lunes, solo lee: comprueba ajustes y consulta `/market`. Al abrir exige confirmar nuevas subastas de jugadores libres del ciclo; al cerrar detecta nuevas subastas de libres sin considerar un fallo que sigan terminando subastas antiguas. Fechas ausentes o formatos desconocidos generan una incidencia; no se interpretan como mercado vacio o correcto.
- Fuera de esas ventanas no modifica ni consulta la liga; solo comprueba disponibilidad del workflow principal. Un lanzamiento manual del supervisor permite ademas diagnostico de solo lectura fuera de las ventanas.

Los dos workflows comparten un grupo de concurrencia para serializar sus escrituras. Las incidencias se crean en GitHub con titulos `[Biwenger auctions] primary`, `workflow`, `cycle` o `supervision`, enlace a logs y texto sin credenciales; se asignan a `JoseMMA88`. Se deduplican los fallos repetidos y se cierran automaticamente al confirmar la recuperacion de cada comprobacion. No se necesitan secretos adicionales: se usa `GITHUB_TOKEN` con permisos `actions: read` e `issues: write`. Las notificaciones dependen de la configuracion de notificaciones de GitHub del destinatario. El lanzamiento manual del supervisor admite `test_alert=true` para crear y cerrar una incidencia `self-test` y comprobar los permisos reales.

El workflow `Auction automation tests` ejecuta tests, TypeScript y validacion sintactica del script de avisos en cambios relevantes. Se fija el runner a Ubuntu 24.04 para evitar cambios automaticos de version de `ubuntu-latest`.

Limitaciones: GitHub puede retrasar o perder ejecuciones; estos horarios no son una garantia de entrega. Todo reside en GitHub por decision del administrador, por lo que una caida completa o la desactivacion simultanea de ambos workflows no puede detectarse desde fuera. En repositorios publicos GitHub puede desactivar cron tras 60 dias sin actividad: revisar ambos workflows periodicamente. Un fallo detectado despues de las 07:00 se comunica, pero no puede recuperar automaticamente el ciclo perdido. La consulta del mercado confirma observaciones, no garantiza el proceso interno de generacion de Biwenger.

Configura estos secretos en el Environment `Secrets` de GitHub Actions:

- `BIWENGER_EMAIL`
- `BIWENGER_PASSWORD`
- `BIWENGER_LEAGUE_ID`

Para una prueba local:

```bash
BIWENGER_EMAIL='...' \
BIWENGER_PASSWORD='...' \
BIWENGER_LEAGUE_ID='1500231' \
npm run auctions:set -- open
```

### Cómo llegan las credenciales al MCP

- El plugin lanza `biwenger-mcp` por `stdio` heredando el `env` del proceso de OpenClaw.
- Si defines `BIWENGER_*` en el `.env`/servicio de OpenClaw, el MCP los recibe directamente.
- Alternativa: usar `DOTENV_CONFIG_PATH=/opt/biwenger-mcp/.env` para que el MCP cargue su propio `.env`.

## Despliegue (VPS Ubuntu + systemd)

1. Copiar plugin a:
   - `/opt/openclaw/plugins/biwenger-focus`
2. Instalar dependencias y build:
   - `cd /opt/openclaw/plugins/biwenger-focus`
   - `npm install`
   - `npm run build`
   - usar `plugins.load.paths` apuntando a `/opt/openclaw/plugins/biwenger-focus/dist/index.js`
3. Crear `.env` en la carpeta del plugin.
   - Incluye también `BIWENGER_*` (o `DOTENV_CONFIG_PATH` apuntando al `.env` del MCP).
4. Verificar permisos de DB:
   - `sudo mkdir -p /var/lib/openclaw`
   - `sudo chown <usuario-openclaw>:<grupo-openclaw> /var/lib/openclaw`
5. Reiniciar OpenClaw:
   - `sudo systemctl restart <servicio-openclaw>`
6. Validar carga del plugin y tools en OpenClaw.

## Instalador automático

- Instalador local en VPS: [scripts/install-biwenger-focus.sh](/Users/josemanuelmalagonalba/Documents/openclaw-biwenger-focus/scripts/install-biwenger-focus.sh)
- Instalador desde GitHub: [scripts/install-from-github.sh](/Users/josemanuelmalagonalba/Documents/openclaw-biwenger-focus/scripts/install-from-github.sh)
- Guía rápida: [docs/install-vps.md](/Users/josemanuelmalagonalba/Documents/openclaw-biwenger-focus/docs/install-vps.md)

## Contrato resumido de tools

### `biwenger_focus_create`
Input:

```json
{
  "player_query": "Mbappe",
  "max_price": 1200000,
  "start_when_remaining_sec": 3600,
  "bid_step": 50000,
  "poll_sec": 20,
  "cooldown_sec": 75,
  "competition": "la-liga"
}
```

### `biwenger_focus_status`
Input:

```json
{
  "focus_id": "<uuid>"
}
```

### `biwenger_focus_list`
Input:

```json
{
  "status": "BIDDING",
  "limit": 50
}
```

### `biwenger_focus_update`
Input:

```json
{
  "focus_id": "<uuid>",
  "max_price": 1500000,
  "bid_step": 75000
}
```

### `biwenger_focus_cancel`
Input:

```json
{
  "focus_id": "<uuid>"
}
```

### `biwenger_clause_schedule_create`
Input:

```json
{
  "player_query": "Marc Casadó",
  "execute_at_iso": "2026-03-06T20:00:00+01:00"
}
```

`execute_at` (epoch) también está soportado.

`max_clause_amount` es opcional. Si no se indica, el plugin usa automáticamente la cláusula actual del jugador como tope.

### `biwenger_clause_schedule_status`
Input:

```json
{
  "clause_id": "<uuid>"
}
```

### `biwenger_clause_schedule_list`
Input:

```json
{
  "status": "PENDING",
  "limit": 50
}
```

### `biwenger_clause_schedule_update`
Input:

```json
{
  "clause_id": "<uuid>",
  "max_clause_amount": 1200000,
  "execute_at_iso": "2026-03-06T21:30:00+01:00"
}
```

### `biwenger_clause_schedule_cancel`
Input:

```json
{
  "clause_id": "<uuid>"
}
```

### `biwenger_market_report_status`
Input:

```json
{}
```

### `biwenger_market_report_now`
Input:

```json
{
  "force": true
}
```

### Criterio del informe diario

- `Mercado diario`:
  - `Nuevos mercado diario`: jugadores recién detectados hoy en el mercado diario.
  - `Más calientes`: mayor subida porcentual desde primera observación del día.
  - `Recomendados`: score 0-100 basado en `subida % hoy` (70%) + `momentum de última lectura` (30%).
- `Subastas/Pujas`:
  - Subidas reales de precio en subastas activas.
  - Jugadores que salieron de subasta desde el último informe.
