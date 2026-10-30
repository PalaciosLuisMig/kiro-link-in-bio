# Fase 0: Steering

Rama: `fase-0-steering`

## Qué es el steering
El steering es el contexto permanente que Kiro tiene en cuenta en todas las conversaciones y fases del proyecto. Vive en `.kiro/steering/` y responde a la pregunta "cómo trabajamos aquí": qué producto construimos, con qué tecnología y con qué convenciones.

El steering no describe funcionalidades concretas. Eso es trabajo del spec (requisitos, diseño y tareas). Mantener esa separación evita tener dos fuentes de verdad que se contradigan.

Regla práctica: si una frase se puede escribir como "CUANDO… EL SISTEMA DEBERÁ…", es un requisito y va al spec, no al steering.

## Archivos creados

| Archivo | Contenido |
|---|---|
| `.kiro/steering/product.md` | Visión, contexto de la demo, usuarios, acceso, privacidad, principios de producto y fuera de alcance |
| `.kiro/steering/tech.md` | Stack, servicios de AWS, reglas de persistencia, calidad, seguridad y comandos |
| `.kiro/steering/structure.md` | Estructura del monorepo, convenciones de código, idioma, commits y flujo por fases |

## Decisiones tomadas en esta fase
- Node.js 24 LTS (runtime `nodejs24.x` en Lambda).
- Tiempo real con API Gateway WebSocket.
- Sin país ni tipo de dispositivo; sin IPs, huellas de navegador ni visitantes únicos (privacidad y RGPD).
- Panel del propietario protegido con un token secreto guardado en SSM Parameter Store.
- Interfaz en español; código en inglés; documentación en español.
- Monorepo con workspaces `shared`, `frontend`, `backend` e `infra`.
- Lógica de dominio separada del acceso a DynamoDB (repositorios inyectados) para testear sin AWS.
- Sin observabilidad específica por ahora.

## Decisiones para la fase de spec
Estas decisiones se tomaron durante la revisión del steering, pero pertenecen al spec. Sirven como lista de comprobación al revisar los requisitos y el diseño que genere Kiro.

### Requisitos: página pública
- Muestra los enlaces activos en el orden definido por el propietario.
- Cada clic se registra y redirige al destino sin retrasos perceptibles.
- Se registra cada visita a la página.

### Requisitos: panel del propietario
1. Clics en el tiempo: gráfica de clics por minuto que se actualiza en vivo.
2. Visitas frente a clics: número de visitas y tasa de clic (CTR) de cada enlace.
3. Actividad en vivo: feed de clics recientes ("alguien pulsó *GitHub* hace 2 s") y número de personas viendo la página ahora.
4. Origen del tráfico: clics y visitas agrupados por un único parámetro `src` en la URL (por ejemplo `?src=qr`, `?src=linkedin`, `?src=github`, `?src=instagram`).
5. Ranking: enlaces ordenados por clics, con su porcentaje sobre el total.
6. Gestión de enlaces: crear, editar, activar/desactivar y reordenar.

### Requisitos: acceso y abuso
- Sin un token válido no se pueden ver las métricas ni crear, editar, activar/desactivar o reordenar enlaces.
- La página pública nunca recibe métricas.
- El parámetro `src` solo acepta valores de una lista permitida; cualquier otro valor se agrupa como `otro`.
- Los endpoints públicos tienen throttling para evitar el inflado de contadores.

### Diseño: tiempo real (WebSocket)
- Dos tipos de conexión:
  - Pública: la abre la página pública solo para contar "personas viendo la página ahora". Nunca recibe métricas.
  - Panel: se autentica con el token en `$connect`; sin token válido la conexión se rechaza.
- Las conexiones activas se guardan en DynamoDB con su tipo.
- Las actualizaciones de métricas se originan con DynamoDB Streams y se envían solo a las conexiones de panel con `PostToConnection`.
- Las conexiones cerradas o inválidas (`GoneException`) se eliminan al detectarse.
- Ante picos, las actualizaciones se agrupan (por ejemplo, ventana de lote en el stream).
- El cliente WebSocket se reconecta automáticamente.

### Diseño: persistencia
- Datos a modelar: enlaces, clics por enlace, visitas de página, clics por minuto, clics y visitas por `src`, actividad reciente y conexiones WebSocket.
- Los datos efímeros (actividad reciente, conexiones) se expiran con DynamoDB TTL.

### Pendiente de decidir en el diseño
- Esquema de DynamoDB: tabla única o varias, claves e índices.
- Librería de validación para `shared/` (candidata: Zod).
- Mecanismo para enviar el token en la conexión WebSocket.
- Valores de la lista permitida de `src` y dónde se configuran.
- Número de stacks de CDK.

## Cómo reproducir esta fase
1. Crea la rama: `git checkout -b fase-0-steering`.
2. Crea los tres archivos en `.kiro/steering/` (`product.md`, `tech.md`, `structure.md`). Puedes pedírselo a Kiro a partir de la descripción de la demo.
3. Revisa cada archivo con Kiro, uno a uno, y toma las decisiones de producto y tecnología.
4. Haz una revisión cruzada de los tres archivos buscando contradicciones.
5. Saca del steering todo lo que sea un requisito o una decisión de diseño concreta y guárdalo aquí, para la fase de spec.
