# Fase 5: Despliegue

Rama: `fase-5-deployment`

## Qué es esta fase
Se publica la app en AWS con CDK, en `us-east-1`, y se comprueba que funciona de verdad: páginas, cabeceras de seguridad, API, tiempo real y la prueba de carga de 500 clics. El código de la aplicación ya estaba terminado en la fase 4. Aquí solo se despliega, se mide y se corrige lo que solo aparece en AWS.

El despliegue crea recursos en la cuenta y genera coste, aunque pequeño. Por eso `npx cdk deploy` se ejecuta siempre con confirmación explícita (`tech.md`).

## Archivos de esta fase

| Archivo | Contenido |
|---|---|
| `infra/lib/api.ts` | Cambio. El Stage de la HTTP API espera a que existan todas las rutas (ver "Lo que se aprendió") |
| `infra/lib/link-in-bio-stack.test.ts` | Cambio. Test que comprueba esa espera, y falla si se quita la corrección |
| `infra/scripts/smoke.ts` | Nuevo. Prueba de humo de solo lectura: `npm run smoke` |
| `infra/scripts/warm-up.ts` | Nuevo. Calienta las Lambdas antes de una demo o de la prueba de carga: `npm run warm-up` |
| `infra/scripts/deploy-core.ts` y `.test.ts` | Nuevo. Lógica pura de los dos scripts anteriores, con tests |
| `infra/scripts/load-test-core.ts` y `.test.ts` | Cambio. Los resultados indican con qué estado HTTP falló cada petición |
| `package.json` e `infra/package.json` | Cambio. Scripts `smoke` y `warm-up` |
| `.gitattributes` | Nuevo. Fija los finales de línea en LF en cualquier máquina |
| `docs/fase-5-deployment.md` | Esta guía |

## Requisitos previos
- AWS CLI v2 con sesión iniciada (`aws login`) y la Región `us-east-1`.
- Node 24 y `npm install` hecho en la raíz.
- `npm run build` ejecutado: el stack sube `frontend/dist` a S3.

Los comandos de `aws ssm` de esta guía están escritos para PowerShell.

## Pasos

| Paso | Comando (desde `infra/`, salvo que se indique) | Para qué sirve |
|---|---|---|
| 1. Comprobar la sesión | `aws sts get-caller-identity` | Confirma la cuenta a la que apunta la CLI |
| 2. Bootstrap | `npx cdk bootstrap aws://<ACCOUNT_ID>/us-east-1` | Crea el stack `CDKToolkit`: bucket de artefactos y roles de despliegue. Una vez por cuenta y Región |
| 3. Token del propietario | Ver abajo | Crea el `SecureString` `/link-in-bio/owner-token`. CloudFormation no puede crearlo, así que va antes del despliegue |
| 4. Construir y revisar | `npm run build` (raíz) y `npx cdk diff` | Muestra los recursos y permisos que se van a crear, sin crear nada |
| 5. Desplegar | `npx cdk deploy` | Crea el stack. Pide confirmar los permisos. Tarda unos 5 a 10 minutos |
| 6. Prueba de humo | `npm run smoke` (raíz) | Comprueba páginas, cabeceras del requisito 17 y que la API rechaza peticiones sin token |
| 7. Prueba a mano | Navegador | Entrar al Panel, crear enlaces `https://`, pulsar uno desde `/?src=qr` y ver subir los contadores |
| 8. Calentar y cargar | `npm run warm-up` y `npm run load-test` (raíz) | Ver "Prueba de carga" |
| 9. Limpiar | `npx cdk destroy` | Borra el stack entero |

Los pasos 6 y 8 leen la URL de la variable `LOAD_TEST_API_URL` (la `SiteUrl` que imprime el despliegue). El token es opcional en `smoke` y `warm-up`, y obligatorio en `load-test`, en `LOAD_TEST_TOKEN`.

### Paso 3: crear el token
Genera 24 bytes aleatorios (32 caracteres, el mínimo que exige la app), guárdalos cifrados y cópialos a un gestor de contraseñas. No los escribas en ningún archivo ni los pegues en un chat.

```powershell
$env:LIB_TOKEN = node -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))"
aws ssm put-parameter --name /link-in-bio/owner-token --type SecureString --value $env:LIB_TOKEN --region us-east-1
$env:LIB_TOKEN
```

La variable solo vive en esa ventana de PowerShell. Para rotar el token, repite el `put-parameter` con `--overwrite`.

## Qué se crea
Un único stack, `LinkInBioStack`, con 74 recursos. Sus salidas son `SiteUrl` (la URL pública en CloudFront) y `WebSocketUrl`.

| Servicio | Papel |
|---|---|
| CloudFront | Única entrada pública. Fuerza HTTPS, añade las cabeceras de seguridad y reparte el tráfico |
| S3 privado | `index.html`, `panel.html` y `assets/`. Solo CloudFront puede leerlo (OAC) |
| API Gateway HTTP | Rutas `/api/*`, con límite por ruta en clics y visitas |
| API Gateway WebSocket | Canal en tiempo real hacia el Panel |
| Lambdas `public-api`, `admin-api`, `ws`, `notify-panel` | Una por área, cada una con permisos mínimos |
| DynamoDB | Una sola tabla, con TTL y Stream |
| Parameter Store | El token del propietario, que solo lee `admin-api` |

## Lo que se aprendió
Estas tres cosas no se veían en local ni en los tests.

**1. El Stage de la HTTP API se creaba antes que las rutas.** El primer `cdk deploy` falló con `Unable to find Route by key POST /api/clicks`. Los límites por ruta están en el Stage (`routeSettings`), y CloudFormation no tenía ninguna dependencia que lo obligara a esperar a las rutas. CloudFormation deshizo todo, sin dejar recursos ni coste. La corrección, en `infra/lib/api.ts`, hace que el Stage dependa de todas las rutas. Un test lo protege: se comprobó que falla si se quita la corrección.

**2. La cuenta tenía 10 ejecuciones de Lambda concurrentes.** Una cuenta nueva empieza con un tope muy bajo (normalmente 1000), compartido por las cuatro Lambdas. La primera prueba de carga, con las funciones frías, dio 475 de 500 confirmaciones: Lambda rechazó 22 por superar el límite durante el arranque en frío, sin errores en el código. Con las funciones calientes, la misma prueba dio 500 de 500. Los 25 clics rechazados no se contaron: no hay contadores inflados ni perdidos en silencio.

**3. Finales de línea en Windows.** Con `core.autocrlf` activo, la copia de trabajo queda en CRLF y `prettier --check` falla en todos los archivos, porque el proyecto exige LF. `npx prettier --write .` lo normaliza sin cambiar el contenido. La solución permanente es el `.gitattributes` del repositorio, con `* text=auto eol=lf`: Git guarda y deja los archivos en LF aunque `core.autocrlf` esté activo. En una simulación de clonado en Windows, sin la regla los 181 archivos quedaban en CRLF y con la regla ninguno.

## Prueba de carga
`npm run load-test` envía 500 clics y 500 visitas, repartidos en 10 s cada fase, y mide lo mismo que pide el spec.

| Requisito | Resultado en AWS (funciones calientes) |
|---|---|
| 12.1 y 12.2: 500 clics y sumas exactas | 500 de 500, todas las sumas en +500 |
| 12.4: p95 de la respuesta menor de 1 s | p95 = 221 ms, máximo 421 ms |
| 8.1 y 8.2: del 202 al Panel, p95 menor de 3 s | p95 = 762 ms, máximo 1026 ms |
| 8.8: el último mensaje coincide con la API | Contadores iguales |
| 12.5: 500 visitas | 500 de 500 |

Antes de una carga o de una demo, `npm run warm-up` manda unas peticiones a la vez para que ya existan las instancias de las Lambdas. Se enfrían tras unos minutos sin uso, así que conviene ejecutarlo justo antes. Nunca supera el límite de la cuenta (`WARM_CONCURRENCY` admite de 1 a 9).

La prueba suma clics y visitas a los contadores reales. Después hay que usar "Reiniciar métricas" en el Panel.

## Riesgos conocidos
- **Cuota de Lambda.** Con el límite de 10, una audiencia que pulse a la vez con las Lambdas frías puede recibir rechazos. Se mitiga con `warm-up`. La solución definitiva es pedir más cuota en Service Quotas (`Concurrent executions`), y AWS puede tardar o rechazarla en una cuenta nueva.
- **Visitas y límite.** 500 visitas en 10 s son 50 req/s, justo el límite de la ruta `POST /api/visits`. Puede aparecer algún 429.
- **Arranque en frío.** El requisito 13.1 (2 s con Fast 3G) se mide con la función caliente.

## Costes y limpieza
Todo es de pago por uso y no hay servidores encendidos. Con un stack así, el gasto de una demo es mínimo, pero conviene destruirlo al terminar:

```bash
npx cdk destroy
```

Se borra todo el stack: la tabla y el bucket tienen política `DESTROY`. Quedan fuera el bootstrap (`CDKToolkit`) y el parámetro del token, que cuestan casi nada. Se pueden borrar a mano si ya no hacen falta.