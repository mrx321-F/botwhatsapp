# Off-hours WhatsApp Bot

Bot minimal con Baileys que responde automáticamente fuera de horario y en almuerzo.

## Comportamiento

- **Fuera de horario (19:00–08:00, America/New_York)**: responde en grupos y usuarios con el mensaje de fuera de servicio.
- **Almuerzo (12:00–14:00, America/New_York)**: responde solo en grupos con mensaje de almuerzo.
- **Delay**: 10 segundos antes de enviar la respuesta.
- **Cooldown**: 10 segundos por chat tras enviar (evita spam).
- **Dedupe**: garantiza 1 respuesta por evento, evitando duplicados simultáneos.
- **Programado**: a las 18:00 prepara la lista de grupos y a las 18:15 envía el mensaje de fuera de servicio a todos los grupos.

## Requisitos

- Node.js 20+

## Instalación

```bash
cd offhours-bot
npm install
```

## Ejecutar

```bash
npm run start
```
- Escanea el QR que aparecerá en consola.
- La sesión se guarda en `sessions-offhours/`.

## Mensajes

- `OFF_HOURS_MESSAGE`: "⚠️ Fuera de Servicio. Nuestro horario de atención es de 7:00 AM a 7:00 PM. Por favor, escríbenos mañana a partir de las 8:00 AM."
- `LUNCH_MESSAGE`: "⚠️ Fuera de Servicio por almuerzo. Nuestro horario se reanuda a las 2:00 PM (12:00 PM - 2:00 PM)."

## Notas

- El bot ignora mensajes de la propia cuenta.
- Maneja el QR en el evento `connection.update`.
- Usa `@whiskeysockets/baileys` actualizado.

## Cómo ajustar parámetros en `index.js`

- **[mensaje de fuera de horario]**: cambia `OFF_HOURS_MESSAGE` en la parte superior de `offhours-bot/index.js`.
- **[mensaje de almuerzo]**: cambia `LUNCH_MESSAGE` en la parte superior de `offhours-bot/index.js`.
- **[zona horaria]**: el código usa `'America/New_York'` en `getHourInTimeZone()`, `isOffHours()` e `isLunchBreak()`. Si necesitas otra zona, reemplaza ese valor en dichas funciones y en el bloque de programación diaria (funciones `getNYParts()` y `msUntilNY()`).
- **[horario de servicio]**: en `isOffHours()` modifica la condición:
  - Actual: `return h < 8 || h >= 19;` (fuera de horario antes de 8:00 y desde 19:00).
  - Ajusta `8` y `19` según tu ventana.
- **[ventana de almuerzo solo para grupos]**: en `isLunchBreak()` modifica:
  - Actual: `return h >= 12 && h < 14;` (12:00–14:00). Solo aplica a grupos por el chequeo en `messages.upsert`:
  - `if (lunchNow && !isGroup) return;`
- **[delay antes de responder]**: en el handler `messages.upsert`, busca `await sleep(10000)` y modifica `10000` (ms). Ese valor determina los 10s de espera.
- **[cooldown por chat]**: en el handler, tras enviar, se ejecuta `cooldownUntil.set(remoteJid, Date.now() + 10_000);`. Cambia `10_000` (ms) para alterar el tiempo de enfriamiento. El chequeo previo es `const until = cooldownUntil.get(remoteJid) || 0; if (now < until) return;`.
- **[antiduplicado]**:
  - Por mensaje: `processedMessageIds` evita responder dos veces al mismo `msg.key.id`.
  - Durante el delay: `respondingUntil` bloquea envíos paralelos al mismo chat mientras corre el `sleep(...)`. Si ajustas el delay, puedes ajustar también el margen en `respondingUntil.set(remoteJid, now + 10000 + 500);`.
- **[envío programado a grupos]**: en `setupDailySchedules()` y utilidades asociadas:
  - Prepara a las `18:00` (`msUntilNY(18, 0)`).
  - Envía a las `18:15` (`msUntilNY(18, 15)`).
  - Cambia estos minutos/horas para otra programación.

## Despliegue
- Ejecuta `npm ci --omit=dev` (si corresponde) y `npm start`.
- Asegura persistencia del directorio `sessions-offhours/`.
