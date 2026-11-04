# Implementation Plan

## Overview

Plan de implementación de Link in Bio a partir de `requirements.md` y `design.md`. Las tareas van de dentro hacia fuera: primero los contratos y el dominio puro (sin AWS), después los adaptadores y los handlers, luego la infraestructura y por último el frontend.

Definición de "terminada" según el tipo de tarea:

- **Código** (`shared`, `backend`, `frontend`): `npm run build` (`tsc -b` más `vite build`), `npm run lint` (`eslint .` y `prettier --check .`) y `npm test` (`vitest --run`) en verde.
- **Infraestructura** (tarea 13): además `npx cdk synth` sin errores desde `infra/`.
- **Prueba de carga** (tarea 16): en verde los tests de sus funciones puras (percentil, emparejamiento de latencias). La ejecución real contra un entorno desplegado queda para la fase de despliegue.
- **Verificaciones manuales** (contraste real, carga con Fast 3G, uso con lector de pantalla): no son tareas de código; se listan al final del plan.

## Tasks

- [x] 1. Preparar el monorepo y las herramientas de calidad
  - Comprobar `node -v` (debe ser 24.x, acorde con `.nvmrc` y `nodejs24.x`); si hay otra versión, instalar Node 24 con nvm-windows antes de seguir
  - Crear `package.json` raíz con npm workspaces (`shared`, `frontend`, `backend`, `infra`), `engines.node` `>=24`, y los scripts: `build` (`tsc -b` y luego `vite build` del frontend, en el orden `shared`, `frontend`, `backend`, `infra`), `lint` (`eslint .` y `prettier --check .`), `format` (`prettier --write .`) y `test` (`vitest --run`)
  - Crear `tsconfig.base.json` con `strict: true`; cada workspace tiene su `tsconfig.json` que lo extiende, con referencias de proyecto (`tsc -b`)
  - Crear `.nvmrc` (24), `.prettierrc`, `.gitignore` (`node_modules/`, `dist/`, `cdk.out/`, `*.tsbuildinfo`, `.env*`, `coverage/`) y `eslint.config.js`
  - En `eslint.config.js`: `no-restricted-imports` por carpeta para que `backend/src/lib/domain/` no importe `@aws-sdk/*`, `handlers/` ni `adapters/`, y `shared/` no importe nada de Node, DOM ni AWS; `no-console` en todo el backend con excepción solo para el adaptador de `Logger`
  - Configurar Vitest en la raíz para que encuentre los `*.test.ts` de todos los workspaces y fijar `TZ` (por ejemplo `UTC`) y `FC_NUM_RUNS` (100 por defecto; el hook de guardado lo baja a 20)
  - Instalar con versiones exactas: `typescript`, `vitest`, `eslint`, `prettier`, `fast-check`, `@types/node` y `@types/aws-lambda` (desarrollo) y `zod` en `shared/` (producción). `happy-dom` se instala en la tarea 14.6, cuando hace falta
  - Añadir un test trivial por workspace para comprobar que `npm test` los ejecuta todos (se borran cuando llegue el primer test real)
  - _Requirements: ninguno (steering `tech.md` y `structure.md`)_

- [x] 2. Contratos compartidos (`shared/src/`)
  - [x] 2.1 Canales de origen (`channel.ts`)
    - `PREDEFINED_CHANNELS`: `qr`, `instagram`, `tiktok`, `x`, `facebook`, `linkedin`, `youtube`, `whatsapp`, `telegram`, `github`
    - `normalizeChannel(value)`: sin valor o cadena vacía devuelve `directo`; en otro caso convierte **solo** las letras A-Z a minúsculas con una función propia (`replace(/[A-Z]/g, ...)`), **nunca** `toLowerCase()` (convertiría el signo Kelvin U+212A en `k`); devuelve el resultado si es un Canal_Predefinido, `directo` u `otro`, y `otro` en cualquier otro caso
    - `compareChannels(a, b)`: Clics descendente y, en empate, nombre ascendente comparado por unidades de código (`<`/`>`), sin `localeCompare` (su resultado depende del idioma del entorno)
    - _Requirements: 4.2, 4.3, 4.4, 4.5, 4.7, 7.4, 8.3_
  - [x] 2.2 Tests de los canales
    - **Property 1: Normalización del canal** (idempotencia y dominio de salida)
    - Casos unitarios de `normalizeChannel`: `Instagram`, `directo`, un canal inventado, un valor de solo espacios (no vacío → `otro`), uno no ASCII, uno de más de 32 caracteres, el signo Kelvin (`lin`+U+212A+`edin` → `otro`) y `İ` (U+0130)
    - Test de propiedad de `compareChannels`: orden total y estable; casos de empate por Clics resuelto por nombre
    - **Validates: Requirements 4.2, 4.3, 4.4, 4.5, 4.7, 7.4, 8.3**
  - [x] 2.3 Reglas de los Enlaces (`link-rules.ts`)
    - `validateTitle(raw)`: aplica `trim()` de JavaScript (quita espacios, saltos de línea finales, NBSP y BOM; un `\n` final se acepta, uno interior se rechaza); acepta si tras `trim` tiene 1 a 80 **puntos de código** (`[...s].length`), sin `\p{Cc}` ni control bidireccional (U+202A–U+202E, U+2066–U+2069); devuelve el valor recortado
    - `validateUrl(raw)`: valida primero la **cadena original** (empieza por `http://` o `https://` sin distinguir mayúsculas, seguido de un carácter distinto de `/`; sin espacios ni `\p{Cc}`; longitud 1 a 2048); después parsea con `new URL` y rechaza si `username` o `password` no están vacíos o si el host está vacío. Guarda la URL tal como llegó (sin `trim`)
    - _Requirements: 6.6, 6.7_
  - [x] 2.4 Test de propiedad de la validación de título y URL
    - **Property 8: Validación de título y URL**
    - Casos unitarios: título de 80 puntos de código con emojis (válido) y de 81 (no), título con `\n` interior y con `\n` final, `https:/ejemplo.com`, `http:///ejemplo.com`, `http://a.com/a b`, `http://user:pass@a.com`, `javascript:alert(1)`, host vacío
    - **Validates: Requirements 6.6, 6.7, 6.8**
  - [x] 2.5 Esquemas de la API (`schemas.ts`) y constantes compartidas
    - Con Zod: `ClickRequest` (`{ linkId: uuid, channel?: string }`), `VisitRequest` (`{ channel?: string }`) con `channel` de `max(256)` en UTF-16, `CreateLinkRequest`, `UpdateLinkRequest` (al menos un campo), `ReorderRequest` (`{ ids: uuid[] }`), el esquema del parámetro `id` (uuid) y el formato de error
    - `title` y `url` se validan con `refine` que delega en `validateTitle`/`validateUrl`; no usar `.max()`, `.min()`, `.url()` ni `.trim()` de Zod para ellos
    - Modo: `strict` en administración (rechaza campos extra), `strip` en `clicks` y `visits` (los ignora)
    - Tipos de respuesta: `PublicLink`, `AdminLink`, `PublicLinksResponse`, `AdminLinksResponse`, `TicketResponse`, `ResetMetricsResponse`, `ReorderResponse`, con sus tipos inferidos exportados
    - Constantes compartidas de rutas (`/api/clicks`, …) y de códigos de error, para no repetir literales en los tres workspaces
    - _Requirements: 14.1, 14.2, 14.3, 6.8_
  - [x] 2.6 Mensajes de tiempo real (`realtime.ts`)
    - `MetricsSnapshot`, `ActivityEvent`, `RealtimeMessage` (`type: 'snapshot'`), la constante `KEEPALIVE` (`{ "type": "keepalive" }`) y `parseKeepalive`
    - `serialize` y `parse`; `parse` devuelve un error descriptivo ante JSON no válido o que no cumple el esquema
    - La medición de los 128 bytes del keepalive **no** va aquí (`shared/` no usa `TextEncoder` ni Node/DOM); se hace en el handler `ws` con `Buffer.byteLength`
    - _Requirements: 14.6, 14.7, 14.10, 8.13_
  - [x] 2.7 Test de propiedad de ida y vuelta de los mensajes
    - **Property 14: Ida y vuelta de los mensajes**
    - **Validates: Requirements 14.6, 14.7, 14.8, 14.10**

- [x] 3. Dominio: funciones puras de métricas (`backend/src/lib/domain/`)
  - [x] 3.1 Minutos e incrementos
    - `minuteStart(tsMs: number): number` devuelve los segundos Unix del inicio del Minuto UTC; `lastMinutes(nowMs, 60): number[]`
    - `buildClickIncrement(linkId, channel, minuteSec)` y `buildVisitIncrement(channel)` devuelven los nombres de atributo a sumar (`totalClicks`, `l#<id>`, `cc#<canal>`, `m#<minutoSec>`, `totalVisits`, `cv#<canal>`)
    - Convención de la clave de Minuto: segundos Unix en DynamoDB (`m#`) y en el estado del Panel; ISO 8601 solo en la `MetricsSnapshot`. La conversión vive en `parseMetricsItem` (seg → ISO) y en `applySnapshot` (ISO → seg)
    - _Requirements: 2.5, 3.2, 7.3_
  - [x] 3.2 Lectura del elemento de métricas
    - `parseMetricsItem(item, nowMs)`: totales, Clics por Enlace, por canal y por Minuto (solo los 60 últimos, emitidos como ISO), época 0 si falta `epoch`, ignorando atributos desconocidos
    - _Requirements: 7.2, 7.3, 7.7, 16.8_
  - [x] 3.3 Test de propiedad de conservación de los incrementos
    - **Property 2: Conservación de los incrementos** (sobre un elemento en memoria que simula `ADD`, en cualquier orden)
    - Nota: la garantía real la da el `UpdateItem` atómico; se confirma en la tarea 16
    - **Validates: Requirements 2.5, 2.8, 3.2, 3.7, 12.1, 12.2, 12.3, 12.5**
  - [x] 3.4 Test de propiedad de la lectura del elemento de métricas
    - **Property 3: Lectura del elemento de métricas**
    - **Validates: Requirements 7.2, 7.3, 7.7**

- [x] 4. Dominio: puertos, entidades, errores y dobles en memoria
  - Entidades del dominio: `Link`, `StoredEvent`, `Connection`, `MetricsItem`
  - Puertos: `LinkRepository`, `MetricsRepository`, `EventRepository`, `RealtimeAccessRepository`, `OwnerTokenProvider`, `RealtimeNotifier`, `Clock` (con `now()` y `sleep(ms)`), `IdGenerator`, `RandomSource` y `Logger`
  - `Logger` acepta solo campos permitidos (código de error, ruta, id de invocación); su tipo impide registrar un cuerpo, cabeceras, token o ticket
  - Errores de dominio: `NotFound`, `LimitReached`, `ValidationError`, `Unauthorized`, `ServerMisconfigured`
  - Dobles en memoria de cada puerto (solo en tests): cumplen el contrato de los adaptadores reales, incluido el TTL de eventos y conexiones y el consumo atómico del ticket; el doble de `EventRepository` calcula el `ttl` como `ts/1000 + 86400`; permiten inyectar fallos (`EventRepository.put`, `removeLinkCounter`, `RealtimeNotifier.send`); `FakeClock`, generador de ids secuencial y `RandomSource` determinista
  - Batería de contrato (`runRepositoryContract`) reutilizable, que se ejecutará en la tarea 9 contra los adaptadores reales con un cliente falso
  - La frontera del dominio se vigila con la regla de ESLint de la tarea 1 (no un test)
  - _Requirements: 5.18, 11.2, 11.6, 11.8_

- [x] 5. Dominio: casos de uso de Enlaces
  - [x] 5.1 `listPublicLinks`
    - Devuelve solo los Enlaces activos, ordenados por posición ascendente, sin repetidos
    - _Requirements: 1.1, 1.3_
  - [x] 5.2 Test de propiedad de la lista pública
    - **Property 5: Lista pública**
    - **Validates: Requirements 1.1, 1.3, 6.11**
  - [x] 5.3 `createLink`, `updateLink`, `reorderLinks` y `removeLink`
    - `position` empieza en 0; `reorderLinks` renumera 0..n-1; `createLink` asigna `max(position) + 1`, o 0 si no hay Enlaces
    - `createLink`: máximo 10 Enlaces (activos e inactivos), título recortado, id nuevo distinto de los existentes y de los eliminados
    - `updateLink`: edita título, URL o estado con condición `attribute_exists(pk)` (no recrear un Enlace fantasma); `NotFound` si no existe; no toca id, posición ni contador
    - `reorderLinks`: exige una permutación exacta de los ids existentes; una `TransactionCanceledException` se traduce a `ValidationError` (6.13), no a 500
    - `removeLink`: primero comprueba que existe (`NotFound` sin tocar contadores), luego borra el Enlace y después su contador `l#<id>`; si el borrado del contador falla, lo registra y termina con éxito
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.8, 6.9, 6.12, 6.13_
  - [x] 5.4 Test de propiedad del límite de Enlaces e identificadores únicos
    - **Property 6: Límite de Enlaces e identificadores únicos**
    - **Validates: Requirements 6.1, 6.9**
  - [x] 5.5 Test de propiedad de la reordenación
    - **Property 7: Reordenación**
    - **Validates: Requirements 6.4, 6.13**
  - [x] 5.6 Test de propiedad de eliminar un Enlace
    - **Property 9: Eliminar un Enlace conserva el histórico**
    - **Validates: Requirements 6.5**

- [x] 6. Dominio: casos de uso de Clics, Visitas y Métricas
  - [x] 6.1 `registerClick` y `registerVisit`
    - `registerClick` lee el Enlace (`NotFound` si no existe o está inactivo), normaliza el canal, hace **una sola** llamada a `Clock.now()` (para el Minuto y el Evento), incrementa con una sola operación y, **solo si el incremento tuvo éxito**, guarda el Evento con el título vigente
    - `registerVisit` hace lo mismo con los contadores de Visitas (sin leer Enlace)
    - Si guardar el Evento falla, se registra con `Logger` y el caso de uso termina con éxito
    - Los casos de uso no reciben IP, User-Agent ni Referer. El TTL del Evento lo calcula el adaptador, no el dominio
    - _Requirements: 2.5, 2.6, 2.7, 3.2, 4.2, 4.3, 4.4, 9.3, 11.1, 11.8_
  - [x] 6.2 `getMetrics` y `resetMetrics`
    - `getMetrics` recibe también `LinkRepository` y filtra `links` por los Enlaces existentes (cubre el contador huérfano de 6.5 y una posible carrera Clic/borrado); construye la `MetricsSnapshot` con `parseMetricsItem` y los últimos 20 eventos con `sk` estrictamente posterior al mayor de: época y ahora−24 h. La `sk` de los eventos usa 13 dígitos rellenados con ceros
    - `resetMetrics` sustituye el elemento de métricas por uno vacío con `epoch = now`. Riesgo anotado: dos reinicios en el mismo milisegundo no producirían una época mayor (16.3); aceptable con un único Propietario humano
    - Precedencia de errores: `ServerMisconfigured` (500) gana a `Unauthorized` (401)
    - _Requirements: 5.18, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 11.2, 11.8, 16.3, 16.7, 16.8_
  - [x] 6.3 Test de propiedad del reinicio
    - **Property 4: Reinicio**
    - **Validates: Requirements 16.3, 16.7, 16.8**
  - [x] 6.4 Test de propiedad de los datos permitidos (nivel dominio)
    - **Property 18 (parte 1): Solo se guardan datos permitidos**
    - Comprobar que lo que `registerClick` y `registerVisit` entregan a los dobles (Evento y atributos de métricas) contiene únicamente los atributos de la lista blanca del diseño. La parte HTTP (cabeceras arbitrarias) se prueba en 10.5
    - **Validates: Requirements 11.1, 11.2**

- [x] 7. Dominio: acceso del Propietario y tiempo real
  - [x] 7.1 `authorizeOwner`
    - `ServerMisconfigured` si el Token_Propietario tiene menos de 32 caracteres (gana a cualquier otro error: con un token de servidor corto, toda petición da 500, 5.5)
    - Compara los hash SHA-256 con `timingSafeEqual`
    - _Requirements: 5.2, 5.3, 5.4, 5.5_
  - [x] 7.2 `issueTicket`, `openConnection` y `closeConnection`
    - `issueTicket`: 32 bytes aleatorios en `base64url`; guarda solo el hash SHA-256 en hexadecimal de esa cadena; devuelve el ticket con caducidad de 60 s
    - `openConnection`: valida longitud y alfabeto del ticket antes de hashear, lo consume de forma atómica (`expiresAt > now`; en `now === expiresAt` se rechaza) y guarda la Conexión con caducidad de 24 h
    - `closeConnection`: elimina la Conexión
    - _Requirements: 5.7, 5.15, 5.16, 5.17, 11.5, 11.6, 11.7_
  - [x] 7.3 Test de propiedad de los tickets de un solo uso
    - **Property 16: Tickets de un solo uso** (incluido el ticket justo en el límite de 60 s)
    - **Validates: Requirements 5.7, 5.16**
  - [x] 7.4 `notifyPanels`
    - Lista primero las Conexiones no caducadas; si no hay ninguna, sale sin leer métricas ni esperar
    - Construye la instantánea con `getMetrics`; si `getMetrics` falla, lanza (la Lambda reintenta una vez)
    - Envía a todas las Conexiones con concurrencia fija (por ejemplo 10), elimina las que responden `gone` (410) y continúa ante otros fallos
    - _Requirements: 8.1, 8.2, 12.6, 12.7, 16.5_

- [x] 8. Checkpoint del dominio
  - Ejecutar `npm run build`, `npm run lint` y `npm test` y comprobar que pasan. Preguntar al usuario si surgen dudas.

- [x] 9. Adaptadores de salida (`backend/src/lib/adapters/`)
  - [x] 9.1 Constructores puros de expresiones de DynamoDB
    - Funciones puras que construyen: el `ADD` del Clic y de la Visita, el `PutItem` condicional del Enlace (`attribute_not_exists(pk)`), el `UpdateItem` condicional de edición (`attribute_exists(pk)`), el `DeleteItem` condicional del ticket, el `TransactWriteItems` de la reordenación y el filtro de edad de eventos y `ttl > ahora`
    - Todos los nombres de atributo van como `ExpressionAttributeNames` (llevan `#` y `-`)
    - _Requirements: 2.5, 3.2, 5.16, 6.1, 6.4, 12.3, 16.3_
  - [x] 9.2 Tests de los constructores y del mapeo de errores
    - Un Clic genera un único `UpdateItem` con los 4 `ADD` y una Visita con los 2; las condiciones del ticket y del Enlace son las del diseño
    - Con un `send` falso: `ConditionalCheckFailedException` en el ticket → "no consumido"; en la edición de un Enlace → `NotFound`; `TransactionCanceledException` en la reordenación → `ValidationError`
    - _Requirements: 2.5, 3.2, 5.16, 6.12, 6.13_
  - [x] 9.3 Adaptadores de DynamoDB
    - `LinkRepository`, `MetricsRepository`, `EventRepository` y `RealtimeAccessRepository` sobre `LinkInBioTable` con `@aws-sdk/lib-dynamodb`, usando los constructores de 9.1
    - Cliente creado con `removeUndefinedValues: true` (los Eventos de Visita no tienen `title`); `ConsistentRead: true` en las lecturas que el diseño marca como consistentes
    - Ejecutar `runRepositoryContract` (tarea 4) contra estos adaptadores con un cliente falso
    - _Requirements: 6.1, 6.4, 11.6, 11.8, 16.3_
  - [x] 9.4 Adaptadores de SSM, API Gateway Management, Node y `Logger`
    - `OwnerTokenProvider` lee `/link-in-bio/owner-token` con descifrado y lo cachea a nivel de módulo con caducidad (por ejemplo 5 min; rotar el token tarda hasta ese tiempo)
    - `RealtimeNotifier` usa `PostToConnection` y traduce el 410 a `gone`
    - `Clock` (`now` y `sleep`), `IdGenerator` (UUID), `RandomSource` y el adaptador de `Logger` (único punto con `console`) con las APIs de Node
    - _Requirements: 5.3, 5.18, 11.2, 12.7_

- [x] 10. Canalización HTTP y handlers de la API
  - [x] 10.1 Canalización común (`backend/src/lib/http/`)
    - Orden: tamaño del cuerpo **decodificado** (según `isBase64Encoded`; más de 10 240 bytes → 400 `validation` con `reason: payload_too_large`), token (solo administración; parsear `Authorization: Bearer <token>`), JSON y esquema; después traduce los errores de dominio a HTTP
    - `catch` global que responde `500 server_error` sin detalles ni traza
    - Todas las respuestas llevan `Cache-Control: no-store`; ninguna lleva cabeceras CORS
    - Registros (vía `Logger`) solo con código de error, ruta e id de invocación
    - _Requirements: 5.6, 5.18, 14.1, 14.2, 14.4, 14.5, 17.3_
  - [x] 10.2 Test de propiedad de la autorización
    - **Property 17: Autorización** (un anónimo con cuerpo inválido recibe 401, no un error de esquema)
    - **Validates: Requirements 5.3, 5.6**
  - [x] 10.3 Handler `public-api` y su raíz de composición
    - `GET /api/links`, `POST /api/visits` y `POST /api/clicks` (202), con las respuestas de error del diseño
    - La raíz de composición falla rápido y con mensaje claro si falta una variable de entorno
    - _Requirements: 1.3, 2.5, 2.6, 2.7, 3.2, 14.1_
  - [x] 10.4 Handler `admin-api` y su raíz de composición
    - Rutas de tickets, métricas, reinicio y gestión de Enlaces (`GET`, `POST`, `PATCH`, `DELETE`, `PUT order`)
    - Parámetro `id`: `400 validation` si no es UUID; `404 not_found` si lo es y no existe
    - La respuesta del ticket incluye `wsUrl`, leída de una variable de entorno; la raíz falla rápido si falta
    - _Requirements: 5.2, 5.3, 5.15, 6.1, 6.2, 6.3, 6.4, 6.5, 6.9, 6.12, 6.13, 7.6, 16.3, 16.4_
  - [x] 10.5 Tests de los handlers HTTP con dobles en memoria
    - Códigos de la tabla de errores del diseño (400, 401, 404, 409, 500)
    - **Property 18 (parte 2):** peticiones con cabeceras arbitrarias (IP, User-Agent, Referer) a `public-api`; ninguna acaba en los dobles ni en los registros
    - Token "canario": ni las respuestas ni los registros contienen el token, el cuerpo ni las cabeceras
    - _Requirements: 2.6, 5.3, 5.18, 6.9, 6.12, 11.1, 11.2, 14.2_

- [x] 11. Handlers de WebSocket y de Streams
  - [x] 11.1 Handler `ws`
    - `$connect` lee `ticket` de la consulta y responde 200 o 401; `$disconnect` elimina la Conexión; `$default` descarta todo lo que no sea `keepalive` o supere 128 bytes (medidos con `Buffer.byteLength`) y devuelve siempre 200
    - Comprobar que `routeSelectionExpression` deja `{"type":"keepalive"}` en `$default`
    - _Requirements: 5.7, 5.16, 8.14, 11.5, 11.7_
  - [x] 11.2 Handler `notify-panel`
    - Ignora el contenido de los registros del stream, llama a `notifyPanels` y espera con `Clock.sleep` hasta completar 1 s desde el inicio de la invocación
    - _Requirements: 8.1, 8.2, 8.7, 12.6, 12.7, 16.5_
  - [x] 11.3 Tests de los handlers `ws` y `notify-panel`
    - Ticket ausente, caducado y usado; mensajes no válidos y de más de 128 bytes; pausa mínima de 1 s con `FakeClock`
    - _Requirements: 5.7, 8.7, 8.14_

- [x] 12. Checkpoint del backend
  - Ejecutar `npm run build`, `npm run lint` y `npm test` y comprobar que pasan. Preguntar al usuario si surgen dudas.

- [x] 13. Infraestructura con CDK (`infra/`)
  - [x] 13.1 App, `cdk.json` y cableado común
    - `infra/bin/` con la app en `us-east-1`, un único stack y `cdk.json`
    - Orden de constructs por dependencias: `Storage`, `Realtime`, `Api` (`admin-api` necesita `wsUrl`), `Frontend` (la CSP necesita el dominio del WebSocket y el origen de la API)
    - Nombres de variables de entorno (tabla, parámetro SSM, `wsUrl`, endpoint de gestión del WebSocket) desde una sola constante compartida por las raíces de composición y por el CDK
    - `LogGroup` explícito por Lambda con retención (por ejemplo 1 semana)
    - Puede empezar justo después de la tarea 1; no depende del checkpoint 12
    - _Requirements: 11.2_
  - [x] 13.2 Construct `Storage`
    - Tabla `LinkInBioTable` `PAY_PER_REQUEST` con `pk`/`sk`, TTL `ttl`, stream `KEYS_ONLY` y política `DESTROY`
    - _Requirements: 11.6, 11.8_
  - [x] 13.3 Construct `Api`
    - HTTP API con las rutas del diseño y Lambdas `public-api` y `admin-api` (`NodejsFunction`, `nodejs24.x`, ARM64, 512 MB, minificación, `depsLockFilePath` al `package-lock.json` de la raíz)
    - Timeouts explícitos (por ejemplo `public-api` 5 s, `admin-api` 10 s)
    - Throttling por ruta con `CfnStage.routeSettings` (el L2 `HttpStage` solo admite un límite de stage): `POST /api/clicks` 150/300 y `POST /api/visits` 50/100, con las claves de ruta exactas
    - Permisos con `table.grant(...)`; lectura del parámetro SSM solo para `admin-api`
    - _Requirements: 5.3, 12.8, 12.9_
  - [x] 13.4 Construct `Realtime`
    - WebSocket API (etapa `prod`) sin registros de acceso ni de ejecución; Lambdas `ws` (5 s) y `notify-panel` (10 s, timeout explícito porque la pausa de 1 s supera el valor por defecto de 3 s)
    - Mapeo de origen con filtro exacto (`eventName` en `INSERT`/`MODIFY` y `dynamodb.Keys.pk.S` en `METRICS`/`EVENTS`), `LATEST`, `retryAttempts: 1`, `maxRecordAge: 60 s`, `ParallelizationFactor: 1`, `batchSize` y `maxBatchingWindow` 0
    - `execute-api:ManageConnections` solo sobre `@connections/*` de la etapa
    - _Requirements: 8.7, 11.2, 11.5, 12.7, 17.1_
  - [x] 13.5 Construct `Frontend` y tres políticas de cabeceras
    - Bucket S3 privado con OAC, CloudFront con `REDIRECT_TO_HTTPS`, comportamientos `/api/*`, `/panel.html` y por defecto, sin registros de acceso
    - Política pública y política del Panel (CSP, HSTS, `nosniff`, `Referrer-Policy`, y `X-Robots-Tag: noindex` en el Panel); **tercera política** para `/api/*` que añade `Cache-Control: no-store` (el 429 del throttling y los 404 de ruta los genera API Gateway, no la Lambda, 17.3)
    - Caché larga `immutable` en `assets/` y `no-cache` en los HTML
    - `frontend/dist` debe existir al sintetizar; para los tests, usar un directorio de prueba y el contexto `aws:cdk:bundling-stacks: []` para no empaquetar con esbuild
    - _Requirements: 11.2, 11.4, 17.1, 17.2, 17.3, 17.4_
  - [x] 13.6 Tests de infraestructura con `aws-cdk-lib/assertions`
    - Tabla on-demand con TTL y stream; runtime `nodejs24.x`; timeouts; para las políticas de **los 4 roles de Lambda del proyecto**, ninguna sentencia con acción `*`/`servicio:*` ni recurso `*` (si aparece una excepción como `dynamodb:ListStreams`, listarla con comentario); throttling por ruta sobre `AWS::ApiGatewayV2::Stage`; filtro del mapeo de Streams; registros de acceso desactivados; las tres políticas de cabeceras y el `no-store` en `/api/*`
    - _Requirements: 11.2, 12.8, 17.1, 17.2, 17.3, 17.4_

- [x] 14. Frontend: base y página pública (`frontend/src/`)
  - [x] 14.1 Configuración de Vite, esqueleto HTML y cliente de la API
    - Build multipágina con los HTML en la raíz de `frontend/` (`index.html`, `panel.html`) y los scripts en `src/public/` y `src/dashboard/`; verificar que `frontend/dist` contiene exactamente `index.html`, `panel.html` y `assets/`
    - Esqueleto de `index.html` (donde la vista pinta) incluido aquí
    - Cliente de la API en `lib/` con `AbortController` a 5 s, importando de `shared` solo con `import type` y constantes (que `zod` no entre en el bundle público); CSS plano mobile first con la pila de fuentes del sistema (sin fuentes web, 11.4)
    - Módulo `frontend/src/lib/messages.ts` con los literales en español que fijan los requisitos
    - _Requirements: 1.5, 11.4, 13.1_
  - [x] 14.2 Lectura del canal (`public/channel.ts`)
    - Primer valor de `src` con `URLSearchParams.get`, recortado a 256 caracteres (UTF-16, misma unidad que `VisitRequest.channel`), sin normalizar
    - _Requirements: 4.1, 4.6, 4.8, 4.9_
  - [x] 14.3 Tests unitarios de la lectura del canal
    - `src` repetido, `%E0%A4%A`, otros parámetros que no cambian el valor, valor de más de 256 caracteres; un test de que lo que emite `channel.ts` siempre cumple `VisitRequest`
    - _Requirements: 4.1, 4.6, 4.8, 4.9_
  - [x] 14.4 Clic y Visita (`public/click.ts`, `public/visit.ts`)
    - Lógica pura con `fetch`, `navigate` y `location` inyectados
    - Clic principal (botón principal, Intro, y Ctrl/Cmd/Shift/Alt): escuchar `click`; `auxclick` con `button === 1` para el botón central. Con modificador o botón central no se llama a `preventDefault` (el navegador abre la pestaña); en el Clic principal, `navigate()` en el mismo tick, antes de cualquier espera
    - `fetch('/api/clicks', { keepalive: true })` sin esperar la respuesta ni reintentar
    - Visita una sola vez tras pintar la lista con éxito (incluso tras "Reintentar"), sin esperar respuesta ni reintentar
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 3.1, 3.3, 3.4, 3.5, 3.6_
  - [x] 14.5 Vista y orquestación (`public/links-view.ts`, `public/main.ts`)
    - Estados carga ("Cargando enlaces…" con `role="status"`), lista, vacío y error con "Reintentar", usando solo `textContent` y `createElement` (un título `<script>` se ve como texto)
    - `main.ts` ordena la carga, el botón "Reintentar" y la Visita; sin cookies ni `localStorage`/`sessionStorage`
    - _Requirements: 1.1, 1.2, 1.4, 1.5, 1.6, 1.7, 1.8, 11.3, 11.4, 14.9_
  - [x] 14.6 Tests del frontend público (con `happy-dom`)
    - Instalar `happy-dom` (aprobado en D15 "si hace falta"). Con `fetch`, `navigate` y `location` inyectados: Visita una sola vez tras éxito y tras "Reintentar", ninguna tras fallo; Clic con `keepalive`; botón central y modificadores sin `preventDefault`; `navigate` en el mismo tick aunque `fetch` no resuelva; título `<script>` como texto; sin cookies ni `Storage`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 3.1, 3.3, 3.4, 3.5, 3.6, 11.3, 14.9_
  - [x] 14.7 HTML y estilos accesibles de la página pública
    - `lang="es"`, título descriptivo, un único `h1`, `main` y `ul`; área táctil de 44 × 44 px, foco visible, `overflow-wrap: anywhere`
    - Función `contrastRatio` y test sobre las variables CSS de color (4,5:1 texto, 3:1 foco)
    - _Requirements: 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8, 15.3_
  - [x] 14.8 Presupuesto de tamaño del bundle público
    - Tras `vite build`, un script que falle si el bundle de `index.html` contiene `zod` o supera un tamaño objetivo (por ejemplo 30 KB gzip), como guarda del requisito de carga en 2 s
    - _Requirements: 13.1_

- [x] 15. Frontend: Panel (`frontend/src/dashboard/`)
  - [x] 15.1 Reductor del Panel (`store.ts`)
    - Funciones puras `applySnapshot(state, snapshot, localNowMs)` y `advanceClock(state, localNowMs)`, sin `Date.now()` dentro
    - Reglas que hacen cierta la Property 10: `clockOffsetMs` sale de la instantánea con mayor `serverTime` (no de la última aplicada); el final de la ventana de 60 Minutos solo avanza (`max`); el feed desempata los eventos de igual hora por `id`
    - Épocas, máximo por contador, ventana de 60 Minutos con `clockOffsetMs`, feed de 20 eventos sin duplicados, canales ordenados con `compareChannels`
    - _Requirements: 7.3, 7.6, 8.3, 8.4, 8.5, 8.6, 8.9, 8.10, 9.1, 9.2, 16.6_
  - [x] 15.2 Test de propiedad del reductor
    - **Property 10: Reductor del Panel (monotonía, idempotencia y conmutatividad)**
    - **Validates: Requirements 8.3, 8.5, 10.3**
  - [x] 15.3 Test de propiedad de épocas distintas
    - **Property 11: Épocas distintas**
    - **Validates: Requirements 8.6, 16.6**
  - [x] 15.4 Test de propiedad de la ventana de 60 Minutos
    - **Property 12: Ventana de 60 Minutos**
    - **Validates: Requirements 7.3, 8.4, 8.9, 8.10**
  - [x] 15.5 Test de propiedad del feed de actividad
    - **Property 13: Feed de actividad**
    - **Validates: Requirements 9.1, 9.2**
  - [x] 15.6 Sesión y cliente de la API del Panel (`auth.ts`, `api.ts`)
    - Token recortado, obligatorio, guardado solo en `sessionStorage`, enviado en `Authorization`; borrado al cerrar sesión o ante un 401
    - Mensajes "Token no válido" y de error de conexión distintos
    - _Requirements: 5.1, 5.8, 5.9, 5.10, 5.11, 5.12, 5.13_
  - [x] 15.7 Tests de la sesión del Panel
    - Con `fetch` y `sessionStorage` falsos: recorte, valor vacío sin petición, 401 borra el token, error de red muestra el otro mensaje, el token nunca aparece en la URL, un token con caracteres no Latin-1 (`fetch` lanza `TypeError` al armar la cabecera) se trata como "Token no válido"
    - _Requirements: 5.1, 5.8, 5.9, 5.10, 5.11, 5.12, 5.13_
  - [x] 15.8 Cliente WebSocket con reconexión (`frontend/src/lib/` y `dashboard/realtime.ts`)
    - `reconnectDelayMs(failedAttempts)` pura: 0→1000, 1→2000, 2→4000, 3→8000, 4→16000, 5 o más→30000
    - Ticket nuevo antes de cada intento, indicadores "Conectando…" y "Reconectando…", Métricas al abrir (reintento cada 5 s) y cada 30 s, `keepalive` cada 5 min, parada ante 401 y al cerrar sesión
    - _Requirements: 5.14, 8.12, 8.13, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8_
  - [x] 15.9 Tests del cliente WebSocket
    - **Property 15: Espera de reconexión** sobre `reconnectDelayMs`
    - Con `WebSocket` falso y `vi.useFakeTimers()`: reintentos, 401 detiene, cerrar sesión cancela, Métricas cada 5 s hasta éxito y cada 30 s, keepalive a los 5 min, un cierre inesperado a las 2 h reconecta
    - **Validates: Requirements 10.1, 10.4**
  - [x] 15.10 Vistas del Panel — acceso y lista de Enlaces (`views/`)
    - Formulario de acceso; lista con crear, editar, activar/desactivar, subir/bajar y eliminar (con `<dialog>`, `showModal()` y foco inicial en "Cancelar"); límite de 10 con el mensaje de 6.10
    - Accesibilidad: solo teclado (sin arrastrar), `aria-label` en cada botón de icono ("Subir «título»"), foco gestionado tras reordenar y tras cerrar un diálogo; solo `textContent` para los textos del Enlace
    - Volver a pedir Enlaces y Métricas ante un Enlace desconocido o un desajuste, como máximo una vez cada 5 s
    - _Requirements: 5.2, 6.10, 6.14, 6.15, 6.16, 8.11, 14.9, 15.1, 15.3_
  - [x] 15.11 Vistas del Panel — métricas, gráfica, feed y reinicio (`views/`, `announcer.ts`)
    - Métricas (totales, Clics por Enlace, canales), estado vacío y error con "Reintentar"
    - Gráfica SVG (`role="img"`, barras con atributos SVG, sin `style` en línea por la CSP) con una `<table>` equivalente (con `<caption>`, los 60 Minutos y su hora en la zona del navegador) oculta visualmente pero no con `display: none`
    - Feed con hora HH:MM:SS (`hourCycle: 'h23'`); `announcer.ts` con `aria-live="polite"` y un resumen cada 10 s como máximo ("12 eventos nuevos")
    - Reinicio de métricas con confirmación (diálogo de 16.1); `prefers-reduced-motion` desactiva animaciones
    - `<meta name="robots" content="noindex">` en `panel.html` además de la cabecera
    - _Requirements: 7.1, 7.2, 7.4, 7.5, 7.8, 7.9, 7.10, 9.4, 9.5, 9.6, 15.2, 15.4, 15.5, 15.6, 16.1, 16.2, 16.4_
  - [x] 15.12 Tests de las piezas puras del Panel
    - `announcer.ts` (un resumen cada 10 s como máximo), el formateo HH:MM:SS y el límite de una vez cada 5 s para volver a pedir datos
    - _Requirements: 8.11, 9.4, 9.5_

- [ ] 16. Script de prueba de carga (`infra/scripts/`)
  - Script Node que lanza 500 Clics en 10 s, comprueba la suma de los contadores y el p95 de las respuestas, y con un cliente WebSocket mide la latencia de cada 202 hasta el mensaje (p95 inferior a 3 s)
  - Emparejamiento de latencia definido: el n-ésimo 202 se empareja con el primer mensaje cuyo `totals.clicks` es al menos la base más n, en una función pura con test
  - Comprobación 8.8: tras el último 202, esperar 4 s y comprobar que el último mensaje coincide con `GET /api/admin/metrics`
  - Recibe la URL y el token por variables de entorno; no se ejecuta en `npm test`. Se ubica en `infra/scripts/` porque `scripts/` en la raíz no figura en `structure.md`
  - _Requirements: 8.1, 8.2, 8.7, 8.8, 12.1, 12.2, 12.4, 12.5_

- [ ] 17. Checkpoint final
  - Ejecutar `npm run build`, `npm run lint`, `npm test` y `npx cdk synth` (desde `infra/`) y comprobar que pasan; verificar que `frontend/dist` contiene `index.html`, `panel.html` y `assets/`. Preguntar al usuario si surgen dudas.

## Notes

- Los tests de propiedades usan `fast-check` (mínimo 100 ejecuciones, `FC_NUM_RUNS`) y llevan la etiqueta `Feature: link-in-bio, Property N`.
- Generadores comunes de `fast-check` en `shared/src/testing/arbitraries.ts` (excluido del export de producción): Enlace, evento, época, `MetricsSnapshot` y elemento de métricas, usados por los tres workspaces.
- Las tareas 8, 12 y 17 son checkpoints: no añaden código, solo verifican la definición de terminada antes de seguir.
- El frontend (tareas 14 y 15) solo depende de `shared/`, así que puede avanzar en paralelo con el backend.
- La tarea 16 puede escribirse en cuanto exista el contrato HTTP; ejecutarla necesita la infraestructura desplegada. El despliegue (`npx cdk deploy`) requiere confirmación explícita, `cdk bootstrap` y crear el parámetro SSM del token, todo fuera de este plan.
- Commits: un commit por tarea de primer nivel con Conventional Commits y ámbito (`feat(shared): ...`, `feat(backend): ...`, `feat(infra): ...`); un `test(...)` si el test va en un commit aparte.
- Implementación en la rama de la fase (convención `fase-N-<nombre>`).

## Verificaciones manuales (fuera del ciclo de código)

- Contraste real de texto (4,5:1) y de foco (3:1) en la página pública y el Panel (13.4, 15.4).
- Tiempo de carga de la página pública en 2 s con la emulación Fast 3G, excluyendo la primera petición tras un despliegue (13.1).
- Uso del Panel con lector de pantalla y solo teclado (15).
- Nota de producto pendiente: no hay forma de ver la interfaz antes de desplegar (los workspaces no incluyen un servidor local). Opciones: aceptarlo y verificar tras `cdk deploy`; un servidor de desarrollo que componga los casos de uso con los dobles en memoria; o un proxy de Vite hacia un despliegue real.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1"] },
    { "id": 1, "tasks": ["2.1", "2.3", "2.5", "2.6", "13.1", "14.1", "14.2"] },
    { "id": 2, "tasks": ["2.2", "2.4", "2.7", "3.1", "4", "13.2", "14.3", "14.4", "15.1"] },
    { "id": 3, "tasks": ["3.2", "5.1", "5.3", "6.1", "7.1", "7.2", "13.3", "13.4", "14.5", "14.7", "15.2", "15.3", "15.4", "15.5", "15.6", "15.8"] },
    { "id": 4, "tasks": ["3.3", "3.4", "5.2", "5.4", "5.5", "5.6", "6.2", "7.3", "13.5", "14.6", "14.8", "15.7", "15.9", "15.10", "15.11"] },
    { "id": 5, "tasks": ["6.3", "6.4", "7.4", "13.6", "15.12"] },
    { "id": 6, "tasks": ["8"] },
    { "id": 7, "tasks": ["9.1", "9.4", "10.1"] },
    { "id": 8, "tasks": ["9.2", "9.3", "10.2", "10.3", "10.4", "11.1", "11.2"] },
    { "id": 9, "tasks": ["10.5", "11.3"] },
    { "id": 10, "tasks": ["12"] },
    { "id": 11, "tasks": ["16"] },
    { "id": 12, "tasks": ["17"] }
  ]
}
```
