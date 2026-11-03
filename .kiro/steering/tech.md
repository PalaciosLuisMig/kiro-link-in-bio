# Stack técnico

## Lenguaje y runtime
- TypeScript en todo el proyecto (frontend, backend e infraestructura), con `strict: true`.
- Node.js 24 LTS para las Lambdas (runtime `nodejs24.x`) y las herramientas locales.
- Gestor de paquetes: npm con workspaces.
- AWS SDK for JavaScript v3 (`@aws-sdk/client-*`, `@aws-sdk/lib-dynamodb`). No usar el SDK v2.

## Arquitectura (AWS serverless)
- Infraestructura como código con AWS CDK v2 en TypeScript. Nada se crea a mano en la consola.
- Frontend estático servido desde S3 detrás de CloudFront.
- API HTTP con Amazon API Gateway + AWS Lambda.
- Tiempo real con API Gateway WebSocket API.
- Persistencia en Amazon DynamoDB en modo on-demand.
- Lambdas definidas con `NodejsFunction` de CDK (bundling con esbuild).
- Región: `us-east-1` (N. Virginia), elegida por el propietario del proyecto.

## Persistencia (DynamoDB)
- Los contadores se incrementan con `UpdateItem` y `ADD` atómico, nunca con lectura + escritura.

## Frontend
- Vite + TypeScript, sin framework pesado salvo que el diseño lo justifique.
- CSS plano o variables CSS; mobile first.
- CloudFront cachea los recursos estáticos; las respuestas de la API no se cachean.

## Calidad
- Tests: Vitest para unidad e integración. Ejecutar siempre en modo no interactivo (`vitest --run`).
- Tests de infraestructura con aserciones de CDK (`aws-cdk-lib/assertions`).
- Lint: ESLint. Formato: Prettier.
- Cada tarea se considera terminada solo cuando compila, pasa lint y pasa tests.

## Seguridad
- Principio de mínimo privilegio en IAM: usar los métodos `grant*` de CDK, nunca `*` en acciones o recursos.
- Validar y sanear toda entrada en las Lambdas (HTTP y WebSocket).
- Sin secretos en el repositorio. Configuración por variables de entorno o SSM Parameter Store.
- El token del panel del propietario se guarda en SSM Parameter Store como `SecureString` y nunca se expone en el frontend público.
- CORS restringido al dominio de CloudFront.

## Comandos habituales
- Instalar: `npm install`
- Build: `npm run build`
- Tests: `npm test`
- Lint: `npm run lint`
- Síntesis de infraestructura: `npx cdk synth` (desde `infra/`)
- Despliegue: `npx cdk deploy` (desde `infra/`). Requiere confirmación explícita antes de ejecutarse.
