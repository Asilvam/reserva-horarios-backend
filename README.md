# Reserva Horarios Backend

API backend para la gestion de horarios y reservas, construida con NestJS y TypeScript.

Actualmente el proyecto se encuentra en una fase inicial: los modulos base ya existen y las rutas estan definidas, pero los servicios todavia devuelven respuestas de ejemplo.

## Estado actual

- Modulo `schedules` creado con endpoints CRUD basicos.
- Modulo `reservations` creado con endpoints CRUD basicos.
- Servicios en modo placeholder (sin persistencia real ni reglas de negocio completas).

## Requisitos

- Node.js 20+
- npm 10+

## Instalacion

```bash
npm install
```

## Ejecucion

```bash
# desarrollo
npm run start:dev

# compilacion
npm run build

# produccion (requiere build previo)
npm run start:prod
```

La aplicacion levanta por defecto en `http://localhost:3000`.

## Scripts utiles

```bash
# iniciar en modo normal
npm run start

# iniciar en modo debug
npm run start:debug

# lint con autocorreccion
npm run lint

# formatear codigo
npm run format
```

## Pruebas

```bash
# pruebas unitarias
npm run test

# pruebas end-to-end
npm run test:e2e

# cobertura
npm run test:cov
```

## Endpoints disponibles

### Schedules

- `POST /schedules`
- `GET /schedules`
- `GET /schedules/:id`
- `PATCH /schedules/:id`
- `DELETE /schedules/:id`

### Reservations

- `POST /reservations`
- `GET /reservations`
- `GET /reservations/:id`
- `PATCH /reservations/:id`
- `DELETE /reservations/:id`

## Nota importante

Las implementaciones actuales de `SchedulesService` y `ReservationsService` devuelven strings de ejemplo. Aun no hay persistencia de datos ni validaciones de negocio completas.

## Stack tecnologico

- NestJS
- TypeScript
- Mongoose (integracion con MongoDB)
- Jest (testing)
- ESLint + Prettier

## Canales de WhatsApp

Se separan dos canales:

- `wspWEB`: integracion con `whatsapp-web.js` (sesion via QR en navegador automatizado)
- `wspMETA`: nombre reservado para futura integracion con WhatsApp Cloud API de Meta

### Variables de entorno para `wspMETA`

- `WSP_META_ENABLED` (default: `false`)
- `WSP_META_TOKEN` (token permanente/sistema de Meta)
- `WSP_META_PHONE_NUMBER_ID` (ID del numero de WhatsApp en Meta)
- `WSP_META_API_VERSION` (default: `v20.0`)

Si `WSP_META_ENABLED=true` y la configuracion esta completa, el backend enviara mensajes por Cloud API de Meta.
Si falla el envio por `wspMETA`, el flujo de reserva hace fallback a `wspWEB` para no perder la notificacion.

### Variables de entorno para `wspWEB`

- `WSP_WEB_ENABLED` (default: `false`)
- `WSP_WEB_CLIENT_ID` (default: `wspWEB`)
- `WSP_WEB_SESSION_PATH` (default: `.wwebjs_auth`)
- `WSP_WEB_HEADLESS` (default: `true`)

Si `WSP_WEB_ENABLED=true`, el backend inicializa el cliente en el arranque y muestra el QR en logs para vincular la sesion.

## Estructura principal

```text
src/
  main.ts
  app.module.ts
  schedules/
    dto/
    entities/
    schedules.controller.ts
    schedules.service.ts
  reservations/
    dto/
    entities/
    reservations.controller.ts
    reservations.service.ts
```

## Proximos pasos sugeridos

1. Implementar persistencia real con MongoDB y modelos de Mongoose.
2. Agregar validaciones robustas en DTOs y manejo de errores consistente.
3. Incorporar autenticacion/autorizacion si aplica al dominio.
4. Documentar la API con Swagger/OpenAPI.
5. Completar pruebas unitarias y e2e para la logica de negocio.
