# Estructura del repositorio

```
.
├── .kiro/
│   ├── steering/          # Contexto permanente para Kiro (producto, tech, estructura)
│   ├── specs/             # Requisitos (EARS), diseño y tareas de cada feature
│   └── hooks/             # Hooks de calidad (lint, tests, etc.)
├── docs/                  # Guía de la demo: un archivo por fase (fase-N-<nombre>.md)
├── shared/                # Contratos compartidos entre frontend y backend
│   └── src/               # Tipos de la API y de los mensajes WebSocket, esquemas de validación
├── frontend/              # App web multipágina (Vite + TypeScript)
│   └── src/
│       ├── public/        # Página pública de enlaces (visitante)
│       ├── dashboard/     # Panel del propietario (requiere token)
│       └── lib/           # Código compartido del frontend (cliente WebSocket con reconexión, cliente de la API)
├── backend/               # Lambdas
│   └── src/
│       ├── handlers/
│       │   ├── http/      # Endpoints REST (clics, visitas, enlaces, métricas)
│       │   ├── websocket/ # Rutas $connect (incluye autenticación del panel) y $disconnect
│       │   └── streams/   # Difusión de actualizaciones desde DynamoDB Streams
│       └── lib/
│           ├── domain/        # Lógica de dominio pura (sin AWS)
│           └── adapters/      # Adaptadores de salida: DynamoDB, SSM y API Gateway (único lugar que usa el SDK de AWS)
├── infra/                 # App y stacks de AWS CDK
│   ├── bin/
│   └── lib/
├── package.json           # Raíz con npm workspaces (shared, frontend, backend, infra)
├── tsconfig.base.json     # Configuración TypeScript común (strict: true)
├── eslint.config.js       # Configuración de ESLint común
├── .prettierrc            # Configuración de Prettier común
└── .nvmrc                 # Versión de Node.js (24)
```

## Convenciones
- Archivos y carpetas en `kebab-case`; tipos y clases en `PascalCase`; variables y funciones en `camelCase`.
- Los handlers de Lambda son finos: parsean la entrada, llaman a la lógica de `lib/domain/` y devuelven la respuesta.
- La lógica de dominio no importa el SDK de AWS. Define puertos (interfaces) que implementan los adaptadores de `lib/adapters/`, y los recibe como dependencias inyectadas, de modo que sus tests usan dobles en memoria y no necesitan AWS.
- Los tipos de la API y de los mensajes WebSocket se definen solo en `shared/`. El frontend y el backend los importan; no se duplican.
- `shared/` solo contiene TypeScript puro y la librería de validación (se elige en la fase de diseño). Sin dependencias de Node, del DOM ni de AWS, porque lo importan tanto el navegador como las Lambdas.
- Cada `tsconfig.json` de los workspaces extiende `tsconfig.base.json`.
- Tests junto al código con sufijo `.test.ts`.

## Idioma
- Código, nombres y comentarios en inglés.
- Textos de la interfaz (página pública y panel) en español.
- Documentación de la demo (`docs/`, specs) en español.

## Commits
- Conventional Commits con ámbito: `tipo(ámbito): descripción`.
- Tipos: `feat`, `fix`, `chore`, `docs`, `test`, `refactor`.
- Ámbitos: `shared`, `frontend`, `backend`, `infra`, `steering`, `specs`, `docs`.
- Ejemplos: `feat(backend): register link clicks`, `docs(steering): add product context`.

## Flujo por fases
- Cada fase de la demo se trabaja en su propia rama `fase-N-<nombre>` (por ejemplo `fase-0-steering`).
- Cada fase se documenta en `docs/fase-N-<nombre>.md`, con el mismo nombre que su rama, explicando qué se hizo y cómo reproducirlo.
