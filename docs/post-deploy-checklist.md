# Checklist Post-Despliegue

1. `openclaw` arranca sin errores y carga plugin `biwenger-focus`.
2. Tool `biwenger_focus_create` responde `ok=true`.
3. Se crea `FOCUS_DB_PATH` y tablas SQLite.
4. El worker procesa focos (cambia de `PENDING` a `ARMED/BIDDING`).
5. No hay pujas fuera de ventana (`remaining > start_when_remaining_sec`).
6. Se respeta `cooldown_sec` entre pujas.
7. Nunca supera `max_price`.
8. `biwenger_focus_cancel` finaliza en `CANCELLED`.
9. Reiniciar `systemd` conserva focos y runtime.
10. Telegram recibe eventos clave (creado, puja, sobrepuja, cierre, errores).
