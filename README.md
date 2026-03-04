# openclaw-biwenger-focus

Plugin de OpenClaw para gestionar focos automáticos de subasta en Biwenger con estrategia conservadora.

## Features

- Tools públicas:
  - `biwenger_focus_create`
  - `biwenger_focus_status`
  - `biwenger_focus_list`
  - `biwenger_focus_update`
  - `biwenger_focus_cancel`
- Integración con `biwenger-mcp` local vía `stdio`.
- Persistencia SQLite.
- Worker de pujas en segundo plano con límite estricto y cooldown.
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
- Credenciales Biwenger para el MCP:
  - `BIWENGER_TOKEN` **o** `BIWENGER_EMAIL` + `BIWENGER_PASSWORD`
  - `BIWENGER_LEAGUE_ID`
  - `BIWENGER_USER_ID`

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
