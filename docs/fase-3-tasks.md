# Fase 3: Tareas

Rama: `fase-3-tasks`

## Qué es esta fase
Se convierte el diseño en un plan de tareas pequeñas y ordenadas que Kiro puede ejecutar una a una en la fase de implementación. El resultado es `.kiro/specs/link-in-bio/tasks.md`. Además se añaden los hooks de calidad que mantendrán el código limpio mientras se implementa.

Todavía no se escribe código de la aplicación: eso empieza en la fase 4 (implementación), ejecutando las tareas desde el spec.

## Archivos de esta fase

| Archivo | Contenido |
|---|---|
| `.kiro/specs/link-in-bio/tasks.md` | Nuevo. 17 tareas con subtareas, cada una con los requisitos que cubre y, cuando corresponde, la propiedad de corrección que prueba |
| `.kiro/hooks/lint-on-save.json` | Nuevo. Al guardar un archivo `.ts` ejecuta `npm run lint` |
| `.kiro/hooks/test-on-save.json` | Nuevo. Al guardar un archivo `.ts` ejecuta `npm test` (`vitest --run`) |
| `docs/fase-3-tasks.md` | Esta guía |

## Orden del plan
Las tareas van de dentro hacia fuera, igual que las capas del diseño. Así cada paso se apoya en código ya probado y los primeros tests no necesitan AWS.

| Bloque | Tareas | Qué se obtiene |
|---|---|---|
| Base | 1 | Monorepo con workspaces, TypeScript `strict`, ESLint, Prettier y Vitest |
| Contratos | 2 | `shared/`: canales, validación de Enlaces, esquemas Zod y mensajes de tiempo real |
| Dominio | 3 a 8 | Funciones puras, puertos, dobles en memoria y casos de uso, sin AWS |
| Backend | 9 a 12 | Adaptadores de DynamoDB, SSM y API Gateway, canalización HTTP y handlers |
| Infraestructura | 13 | Stack de CDK con `Storage`, `Api`, `Realtime` y `Frontend`, con tests de aserciones |
| Frontend | 14 y 15 | Página pública y Panel con su reductor puro y el cliente WebSocket |
| Carga | 16 | Script de 500 Clics en 10 s, que se ejecuta tras desplegar |
| Cierre | 17 | Build, lint, tests y `cdk synth` en verde |

Las tareas 8, 12 y 17 son puntos de control: se para, se comprueba que todo pasa y se resuelven dudas antes de seguir.

## Trazabilidad
- Cada tarea termina con `_Requirements: ..._`, los criterios de `requirements.md` que implementa.
- Las 18 propiedades de corrección del diseño tienen su propia subtarea de test, justo después del código que prueban, con `**Property N**` y `**Validates: Requirements ...**`.
- El despliegue y las comprobaciones manuales (contraste, Fast 3G, lector de pantalla) no son tareas de código: quedan para la fase de despliegue.

## Hooks de calidad
Dos hooks con el disparador `PostFileSave` y el filtro `\.ts$`:

| Hook | Comando | Límite |
|---|---|---|
| Lint al guardar TypeScript | `npm run lint` | 60 s |
| Tests unitarios al guardar TypeScript | `npm test` | 120 s |

Son dos hooks separados en lugar de uno con `npm run lint && npm test` para que funcionen igual en cualquier shell de Windows.

Hasta que la tarea 1 cree el `package.json` raíz con los scripts `lint` y `test`, los hooks fallarán sin bloquear nada. A partir de ahí, cada guardado de un `.ts` muestra los errores de lint y de tests al momento.

Los hooks se cargan al iniciar una sesión de Kiro. También se pueden ver y editar en la sección "Agent Hooks" del explorador.

## Cómo reproducir esta fase
1. Actualiza `main` y crea la rama: `git checkout main`, `git pull` y `git checkout -b fase-3-tasks`.
2. En el spec de Kiro, pide crear el plan de tareas a partir del diseño aprobado.
3. Revisa que el orden va de dentro hacia fuera, que cada tarea cita sus requisitos y que cada propiedad tiene su test.
4. Crea los hooks desde la sección "Agent Hooks" o pidiéndoselo a Kiro: al guardar un archivo TypeScript, ejecutar el linter y los tests unitarios.
5. Haz los commits: `docs(specs): add link-in-bio tasks` y `chore(steering): add lint and test hooks on save`.
