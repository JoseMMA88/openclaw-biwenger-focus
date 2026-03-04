# Instalación en VPS (root + systemd)

## Opción A: repo ya copiado en VPS

```bash
cd /opt/openclaw/plugins/biwenger-focus
cp -n .env.example .env
nano .env
bash scripts/install-biwenger-focus.sh
```

## Opción B: instalar desde GitHub

```bash
export PLUGIN_REPO_URL="https://github.com/<org>/<repo>.git"
export PLUGIN_REPO_REF="main"

curl -fsSL "https://raw.githubusercontent.com/<org>/<repo>/main/scripts/install-from-github.sh" | bash
```

Si también quieres clonar/actualizar `biwenger-mcp` automáticamente:

```bash
export MCP_REPO_URL="https://github.com/<org>/biwenger-mcp.git"
curl -fsSL "https://raw.githubusercontent.com/<org>/<repo>/main/scripts/install-from-github.sh" | bash
```

## Variables mínimas requeridas en `.env`

- `MCP_COMMAND` (recomendado: `/usr/bin/node`)
- `MCP_ARGS` (ej: `/opt/biwenger-mcp/dist/server.js`)
- `MCP_CWD` (ej: `/opt/biwenger-mcp`)
- `FOCUS_DB_PATH`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `BIWENGER_TOKEN` **o** (`BIWENGER_EMAIL` + `BIWENGER_PASSWORD`)
- `BIWENGER_LEAGUE_ID` (o `LEAGUE_ID`)
- `BIWENGER_USER_ID` (o `USER_ID`)

## Verificación rápida

```bash
systemctl status $(systemctl list-units --type=service --all | awk '/openclaw/{print $1; exit}') --no-pager
journalctl -u $(systemctl list-units --type=service --all | awk '/openclaw/{print $1; exit}') -n 120 --no-pager
```
