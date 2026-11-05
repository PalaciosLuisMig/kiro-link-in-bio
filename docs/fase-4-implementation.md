# Fase 4: Implementación

Rama: `fase-4-implementacion`

## Qué es esta fase
Se ejecuta el plan de `.kiro/specs/link-in-bio/tasks.md`, tarea por tarea, hasta tener la app completa y probada en local: contratos compartidos, dominio y backend, infraestructura con CDK, página pública, Panel del propietario y script de prueba de carga. Todavía no se despliega nada: eso es la fase 5.

El resultado son las 17 tareas del plan marcadas como hechas, con un commit por tarea de primer nivel (Conventional Commits con ámbito), y `npm run build`, `npm run lint`, `npm test` y `npx cdk synth` en verde.

## Archivos de esta fase

| Carpeta | Contenido |
|---|---|
| `shared/` | Contratos que comparten frontend y backend: canales, reglas de Enlace, esquemas Zod, mensajes de tiempo real y constantes |
| `backend/src/lib/domain/` | Dominio sin AWS: funciones puras, puertos, entidades, errores, dobles en memoria y casos de uso |
| `backend/src/lib/adapters/` | Adaptadores de salida: DynamoDB, SSM, API Gateway Management, logger y servicios de Node |
| `backend/src/lib/http/` y `backend/src/handlers/` | Canalización HTTP y handlers de Lambda, delgados, para la API, el WebSocket y el Stream |
| `backend/src/dev/` | Servidor local de desarrollo: los handlers reales sobre dobles en memoria, con `ws` |
| `infra/` | Stack de CDK (`Storage`, `Api`, `Realtime`, `Frontend`) con tests de aserciones, y el script de prueba de carga |
| `frontend/src/public/` | Página pública: lista de Enlaces, selector de tema, registro de visitas y clics |
| `frontend/src/dashboard/` | Panel: reductor de métricas, cliente WebSocket, totales, gráfica, canales, actividad y gestión de Enlaces |
| `.kiro/specs/link-in-bio/tasks.md` | Cada tarea marcada con `[x]` al terminarla |
| `docs/fase-4-implementation.md` | Esta guía |

## Orden de ejecución
Las tareas van de dentro hacia fuera, como las capas del diseño, así que los primeros tests no necesitan AWS.

| Tarea | Qué se obtiene | Commit |
|---|---|---|
| 1 | Monorepo con workspaces, TypeScript `strict`, ESLint, Prettier y Vitest | `chore: set up npm workspaces monorepo and quality tooling` |
| 2 | `shared/`: contratos y validación | `feat(shared): add shared contracts ...` |
| 3 | Funciones puras de métricas: minutos, incrementos, lectura de elementos | `feat(backend): add pure metrics domain helpers ...` |
| 4 | Entidades, puertos, errores y dobles en memoria | `feat(backend): add domain entities, ports, errors and in-memory doubles` |
| 5 | Casos de uso de Enlaces | `feat(backend): add link management use cases ...` |
| 6 | Casos de uso de Clics, Visitas y Métricas | `feat(backend): add click/visit and metrics domain use cases` |
| 7 | Acceso del Propietario y tiempo real | `feat(backend): add owner access and realtime domain use cases` |
| 8 | Punto de control del dominio | `chore(specs): mark task 8 domain checkpoint as passed` |
| 9 | Adaptadores de DynamoDB, SSM, API Gateway y Node | `feat(backend): add output adapters ...` |
| 10 | Canalización HTTP y handlers de la API | `feat(backend): add HTTP pipeline and API handlers` |
| 11 | Handlers de WebSocket y de Streams | `feat(backend): add WebSocket and stream handlers` |
| 12 | Punto de control del backend | `chore(specs): mark task 12 backend checkpoint as passed` |
| 13 | Stack de CDK en `us-east-1` | `feat(infra): add CDK stack with storage, API, realtime and frontend` |
| 14 | Página pública | `feat(frontend): add public links page with theme button` |
| 15 | Panel del propietario | `feat(frontend): add owner Panel with real-time metrics` |
| 16 | Script de prueba de carga | `feat(infra): add load test script for clicks and visits` |
| 17 | Punto de control final | `docs(spec): mark task 17 final checkpoint as done` |

Los commits van con la descripción empezando por `Task N:`. Fuera del plan hubo tres commits de configuración: las reglas de AWS en el steering (`docs(steering): add AWS rules ...`), la Región `us-east-1` en el steering y en el diseño, y el servidor local de desarrollo (`feat(dev): add local dev server with token from .env`).

## Decisiones que salieron al implementar
- **Región.** `us-east-1`, fijada en el steering, en el diseño y en la app de CDK.
- **Formato de los errores.** El cuerpo es `{ error, fields?: [{ path, message }], reason? }`, con `ERROR_CODES` y `ERROR_REASONS` compartidos en `shared/`. Por ejemplo, un orden que no es una permutación devuelve `reason: ids_not_permutation`.
- **Token del Panel.** Solo en `sessionStorage` y solo en la cabecera `Authorization` (requisito 5.10). La página pública no usa cookies ni ningún almacenamiento (11.3).
- **Presupuesto de la página pública.** Un plugin de Vite falla el build si la página pública pasa de 30 KB comprimida o si arrastra Zod. Para eso `shared/` declara `"sideEffects": false`. Hoy pesa 5,2 KB.
- **CSP sin estilos ni scripts en línea.** Los dos HTML solo cargan archivos propios.
- **Servidor local.** `npm run dev` levanta la API en memoria y Vite con un proxy de `/api` y `/ws`. El token del Panel sale de `LOCAL_OWNER_TOKEN` en un `.env` (no se sube; `.env.example` va sin valor), así que no hay ningún token escrito en el código.
- **URLs `https://` en el Panel.** Los formularios de añadir y editar exigen título y una URL que empiece por `https://`. Es más estricto que la API, que también acepta `http://`.

## Calidad
- **Tests.** 812 tests en 50 archivos al cerrar la fase, entre ellos los de propiedades con `fast-check` (mínimo 100 ejecuciones, `FC_NUM_RUNS`), `happy-dom` para el DOM y temporizadores simulados para el tiempo real.
- **Mutación manual.** Para comprobar que los tests protegen de verdad, se rompió a propósito el código en puntos clave y se vio que algún test fallaba. Así aparecieron y se arreglaron tests débiles: la idempotencia de las visitas, la comprobación de privacidad del almacenamiento y el límite de relecturas del Panel.
- **Hooks de Kiro.** Al guardar un `.ts` se ejecutan `npm run lint` y `npm test`.
- **Servidor local de extremo a extremo.** Se probó en un navegador real: clic público, API local y subida del contador en el Panel por WebSocket.

## Qué no incluye
- El despliegue en AWS, la prueba de carga contra AWS y las comprobaciones manuales (Fast 3G, lector de pantalla, móvil real): son de la fase 5.

## Cómo reproducir esta fase

### Fase anterior necesaria
Esta fase parte de la fase 3 completada, es decir, de la rama `fase-3-tasks`. Sin ella no hay nada que ejecutar:
- `.kiro/specs/link-in-bio/tasks.md`, con las 17 tareas.
- `.kiro/specs/link-in-bio/requirements.md` y `design.md`, que las tareas citan.
- El steering (`product.md`, `tech.md`, `structure.md`) y los hooks de lint y tests al guardar.

La rama se crea a partir de `fase-3-tasks`, no de `main`: `main` ya tiene fusionadas todas las fases y mezclaría el resultado de esta con lo que se quiere reproducir. Comprueba que `fase-3-tasks` contiene todo lo anterior antes de crear la rama.

### Pasos
1. Colócate en la rama de la fase anterior y crea la nueva a partir de ella: `git checkout fase-3-tasks`, `git pull` y `git checkout -b fase-4-implementacion`.
2. Abre el spec en Kiro y ejecuta las tareas de `tasks.md` en orden, una por una. Revisa el resultado de cada una antes de pasar a la siguiente.
3. En los puntos de control (8, 12 y 17) para y comprueba que `npm run build`, `npm run lint`, `npm test` y, en el último, `npx cdk synth` pasan.
4. Haz un commit por tarea de primer nivel, con la descripción empezando por `Task N:`.
5. Para probar la app en local: copia `.env.example` como `.env`, pon en él `LOCAL_OWNER_TOKEN` (32 caracteres o más) y ejecuta `npm run dev`.

La fase siguiente es la 5 (despliegue), que parte de esta fase 4 completada.
