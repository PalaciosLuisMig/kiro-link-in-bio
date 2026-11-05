# Fase 1: Requisitos

Rama: `fase-1-requirements`

## Qué es esta fase
Se convierte la idea en una frase en requisitos verificables, escritos en notación EARS. El resultado es `.kiro/specs/link-in-bio/requirements.md`. Este documento describe solo comportamiento. La arquitectura se decide en la fase 2 (diseño), siguiendo el steering.

Idea de partida: una página pública de enlaces ("Link in Bio") que cuenta los clics de cada enlace, y un panel protegido por token con métricas en tiempo real.

## Archivos creados

| Archivo | Contenido |
|---|---|
| `.kiro/specs/link-in-bio/requirements.md` | Introducción, glosario y 17 requisitos con historia de usuario y criterios de aceptación en EARS |
| `.kiro/specs/link-in-bio/.config.kiro` | Configuración del spec que genera Kiro |

## Estructura de los requisitos

| Requisito | Tema |
|---|---|
| 1 | Mostrar la página pública de enlaces |
| 2 | Registrar clics y redirigir al destino |
| 3 | Registrar visitas |
| 4 | Determinar el canal de origen (`src`) |
| 5 | Acceso al panel con token |
| 6 | Gestionar enlaces (máximo 10) |
| 7 | Consultar métricas en el panel |
| 8 | Actualizar métricas en tiempo real |
| 9 | Feed de actividad |
| 10 | Reconexión del panel |
| 11 | Privacidad |
| 12 | Robustez ante picos de clics |
| 13 | Rendimiento y accesibilidad de la página pública |
| 14 | Validación de entradas y contratos compartidos |
| 15 | Accesibilidad e idioma del panel |
| 16 | Reiniciar métricas |
| 17 | Seguridad del transporte y de las respuestas |

## Notación EARS
Las palabras clave van en inglés y el resto del texto en español.

| Patrón | Plantilla | Uso |
|---|---|---|
| Evento | `WHEN <evento>, THE <sistema> SHALL <respuesta>` | Algo ocurre y el sistema reacciona |
| Estado | `WHILE <estado>, THE <sistema> SHALL <respuesta>` | Mientras dura una situación |
| Error | `IF <condición>, THEN THE <sistema> SHALL <respuesta>` | Caso no deseado |
| Siempre | `THE <sistema> SHALL <respuesta>` | Comportamiento sin condición |
| Propiedad | `FOR ALL <entrada>, THE <sistema> SHALL <propiedad>` | Invariante comprobable con tests basados en propiedades. No es EARS estricto |

## Decisiones tomadas en esta fase
- **Máximo de 10 Enlaces en total**, sumando activos e inactivos.
- **Al eliminar un Enlace se conservan sus clics** en el total, la gráfica por minuto y los totales por canal.
- **Redirección inmediata:** el clic se envía en segundo plano y el Visitante llega al destino en un máximo de 300 ms, sin esperar la respuesta.
- **Reiniciar métricas:** el Propietario pone todo a cero antes de la demo. Se implementa con una época de métricas que aumenta con cada reinicio.
- **Token para el WebSocket:** el navegador no permite cabeceras propias en un WebSocket. El Panel pide a la API un ticket de un solo uso (máximo 60 s) y lo usa para abrir la conexión. El token nunca va en una URL.
- **Canal de origen libre:** el parámetro `src` acepta cualquier cadena de 1 a 32 caracteres con letras minúsculas, dígitos y guiones. Si falta o no es válido, el canal es `directo`.
- **Token guardado en el almacenamiento de sesión**, así que recargar el Panel no obliga a volver a escribirlo.
- **Límite global de peticiones** en la API pública (200 por segundo, con ráfagas de 400) y no por IP, porque el público de la charla comparte la Wi-Fi.
- **Plazos de borrado** formulados como caducidad y borrado automático, sin prometer tiempos que AWS no garantiza (el TTL de DynamoDB puede tardar días).
- **Mantener viva la Conexión:** API Gateway cierra un WebSocket a los 10 minutos sin tráfico, así que el Panel envía un mensaje cada 5 minutos.

## Diferencias con la lista de comprobación de la fase 0
La fase 0 dejó una lista de decisiones para el spec. Estas son las que el spec resuelve de otra forma o no recoge:

| Fase 0 | Estado en los requisitos |
|---|---|
| `src` con lista permitida y valor `otro` | Cambiado: `src` libre con formato validado y valor `directo` (ver arriba) |
| Número de personas viendo la página ahora | No incluido. Exigiría una conexión WebSocket pública y es un dato nuevo que tratar |
| Tasa de clic (CTR) de cada enlace | No incluida como criterio. Se puede calcular con las Visitas y los Clics ya definidos |
| Ranking con porcentaje sobre el total | No incluido como criterio |
| Throttling de los endpoints públicos | Incluido (requisito 12) |
| Mecanismo para enviar el token en el WebSocket | Resuelto con el ticket de un solo uso (requisito 5) |

Si se quiere recuperar alguna de las funciones no incluidas, hay que añadir sus requisitos antes de pasar al diseño.

## Pendiente para la fase 2 (diseño)
- Esquema de DynamoDB: tabla única o varias, claves e índices, y cómo se implementa la época de métricas.
- Librería de validación para `shared/` (candidata: Zod).
- Cómo se garantiza que un clic confirmado acaba reflejado en los tres contadores sin transacciones.
- Tamaño real del límite global de peticiones y cómo se configura en API Gateway.
- Número de stacks de CDK y cabeceras de seguridad en CloudFront.
- Arquitectura de capas y reglas de dependencias (se parte de lo definido en `structure.md`).

## Cómo reproducir esta fase
1. Crea la rama a partir de la fase 0 completada: `git fetch` y `git switch -c fase-1-requirements origin/fase-0-steering`. No partas de `main`: ya tiene fusionadas todas las fases.
2. En Kiro, crea un spec nuevo y escribe la idea en una frase (por ejemplo: "una página de enlaces que cuenta clics y un panel con métricas en tiempo real").
3. Elige empezar por los requisitos. Kiro genera `requirements.md` en notación EARS.
4. Revisa los requisitos con Kiro en varias rondas: ambigüedades, contradicciones entre criterios, seguridad, accesibilidad y límites reales de los servicios de AWS.
5. Contrasta el resultado con la lista de la fase 0 y anota las diferencias.
6. Aprueba los requisitos. Solo entonces se pasa a la fase 2 (diseño).
7. Haz el commit: `docs(specs): add link-in-bio requirements in EARS notation`.
