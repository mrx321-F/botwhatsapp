# Off-hours WhatsApp Bot

Bot minimal con Baileys que responde en grupos solo fuera de horario.

## Objetivo
- Responder un único mensaje en chats de grupo entre 7:00 PM y 7:00 AM con:
  "⚠️ Fuera de Servicio. Nuestro horario de atención es de 7:00 AM a 7:00 PM. Por favor, escríbenos mañana a partir de las 8:00 AM."
- Retraso de 3 segundos antes de enviar el mensaje.
- Sin IA.

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

## Notas
- Solo responde en grupos (`@g.us`).
- Ignora mensajes de la propia cuenta.
- Usa `@whiskeysockets/baileys` actualizado.

## Despliegue
- Ejecuta `npm ci --omit=dev` (si corresponde) y `npm start`.
- Asegura persistencia del directorio `sessions-offhours/`.
