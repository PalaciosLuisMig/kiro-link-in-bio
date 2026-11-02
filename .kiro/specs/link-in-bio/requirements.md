# Requirements Document

## Introduction

Link in Bio es una aplicación web con una página pública que muestra la lista de enlaces de una persona y registra cuántos clics recibe cada enlace. El propietario dispone de un panel, protegido por un token secreto, desde el que gestiona sus enlaces y consulta métricas en tiempo real: contadores de clics que suben en directo, una gráfica de clics por minuto, un feed de actividad y el desglose por canal de origen. Antes de la demo, el propietario puede reiniciar las métricas para que el público vea solo su propia actividad.

La aplicación es la pieza central de una demo en vivo de desarrollo dirigido por especificaciones. El momento clave es que el público escanea un QR, abre la página pública en su móvil, pulsa un enlace y ve en pantalla cómo el contador sube, cómo aparece el pico en la gráfica y cómo se mueve el feed. Por eso los requisitos priorizan la fiabilidad ante picos de cientos de clics simultáneos, la carga rápida en móvil y la privacidad (solo agregados, sin datos que identifiquen a una persona).

Estos requisitos describen comportamiento. Las decisiones de arquitectura (API HTTP y WebSocket serverless, contadores atómicos, almacenamiento del token, CORS) se concretan en la fase de diseño siguiendo el steering del proyecto.

## Glossary

- **Página_Pública**: página web accesible sin token que muestra la lista de Enlaces activos al Visitante.
- **Panel**: aplicación web del Propietario para gestionar Enlaces y consultar Métricas. Requiere una Sesión_Panel abierta.
- **API_Pública**: conjunto de endpoints HTTP sin autenticación que sirven la lista de Enlaces activos y registran Visitas y Clics.
- **API_Gestión**: conjunto de endpoints HTTP que requieren el Token_Propietario y permiten gestionar Enlaces, consultar y reiniciar Métricas y obtener Tickets_Conexión.
- **Servicio_Tiempo_Real**: componente que mantiene las Conexiones del Panel y les envía Mensajes_Tiempo_Real.
- **Contratos_Compartidos**: módulo que define los tipos y esquemas de validación de las peticiones de la API y de los Mensajes_Tiempo_Real, usado tanto por el frontend como por el backend.
- **Visitante**: persona anónima que abre la Página_Pública, normalmente desde un móvil tras escanear un QR.
- **Propietario**: persona que conoce el Token_Propietario y gestiona los Enlaces.
- **Token_Propietario**: secreto único, de al menos 128 bits generados aleatoriamente, que autoriza el acceso al Panel y a la API_Gestión, y que permite obtener Tickets_Conexión para abrir Conexiones con el Servicio_Tiempo_Real.
- **Token_Guardado**: valor que el Panel conserva en el navegador después de que el Propietario lo introduce en el formulario de acceso.
- **Sesión_Panel**: periodo que empieza cuando la API_Gestión valida el Token_Guardado y termina cuando el Propietario cierra sesión, la API_Gestión rechaza el Token_Guardado o se cierra la pestaña del navegador. Recargar la pestaña no termina la Sesión_Panel.
- **Ticket_Conexión**: valor temporal de un solo uso, de al menos 128 bits generados aleatoriamente, emitido por la API_Gestión a petición del Panel autenticada con el Token_Propietario, que autoriza una única solicitud de Conexión durante un máximo de 60 segundos desde su emisión.
- **Enlace**: elemento de la lista con un identificador, un título, una URL de destino, una posición y un estado (activo o inactivo). Pueden existir como máximo 10 Enlaces, sumando activos e inactivos.
- **Visita**: evento que se produce cuando la Página_Pública termina de cargar con éxito la lista de Enlaces en una carga de página.
- **Clic**: evento que se produce cuando un Visitante activa un Enlace activo en la Página_Pública según el Requirement 2. Abrir el destino desde el menú contextual del navegador no produce un Clic.
- **Valor_Canal**: valor de la primera aparición del parámetro `src` de la URL de la Página_Pública, tal como lo decodifica el navegador, que la Página_Pública envía con cada Visita y cada Clic.
- **Canal_Origen**: canal con el que se registra una Visita o un Clic: un Canal_Predefinido, `directo` (sin Valor_Canal o con un Valor_Canal vacío) u `otro` (con un Valor_Canal que no corresponde a ningún Canal_Predefinido).
- **Canal_Predefinido**: uno de los canales fijos de la aplicación: `qr`, `instagram`, `tiktok`, `x`, `facebook`, `linkedin`, `youtube`, `whatsapp`, `telegram` y `github`.
- **Minuto**: intervalo de 60 segundos alineado con el inicio de un minuto en UTC.
- **Época_Métricas**: número que identifica el periodo de Métricas en curso. Vale 0 hasta el primer reinicio y aumenta con cada reinicio de Métricas.
- **Métricas**: contadores agregados de la Época_Métricas en curso: Clics por Enlace, contador total de Clics, Clics por Minuto, Clics por Canal_Origen, contador total de Visitas y Visitas por Canal_Origen. Los contadores por Minuto y por Canal_Origen son globales (suman todos los Enlaces) y el contador total de Clics incluye los Clics de Enlaces ya eliminados.
- **Gráfica_Por_Minuto**: representación en el Panel del número de Clics de cada uno de los últimos 60 Minutos.
- **Feed_Actividad**: lista en el Panel con los últimos 20 Eventos_Actividad, del más reciente al más antiguo.
- **Evento_Actividad**: entrada del Feed_Actividad que contiene un identificador técnico aleatorio que no identifica a la persona, el tipo de evento (Clic o Visita), el título que tenía el Enlace en el momento del Clic en el caso de un Clic, el Canal_Origen y la hora del evento.
- **Conexión**: canal de comunicación persistente entre una instancia del Panel y el Servicio_Tiempo_Real, identificado por un identificador técnico que no identifica a la persona.
- **Mensaje_Tiempo_Real**: mensaje que el Servicio_Tiempo_Real envía a las Conexiones con una instantánea completa de las Métricas y los últimos Eventos_Actividad. Cada Mensaje_Tiempo_Real indica la Época_Métricas a la que pertenece, de modo que un reinicio de Métricas llega como una instantánea de una Época_Métricas nueva con todos los contadores a 0.
- **Mensaje_Mantenimiento**: mensaje que el Panel envía por la Conexión con el único fin de mantenerla abierta.
- **Red_Móvil_Referencia**: perfil de red de 1,6 Mbps de bajada, 750 Kbps de subida y 150 ms de latencia (perfil "Fast 3G" de las herramientas de desarrollo del navegador).

## Requirements

### Requirement 1: Mostrar la página pública de enlaces

**User Story:** Como Visitante, quiero ver la lista de enlaces del propietario en mi móvil, para poder abrir el que me interese.

#### Acceptance Criteria

1. WHEN la API_Pública entrega a la Página_Pública una lista con entre 1 y 10 Enlaces activos, THE Página_Pública SHALL mostrar todos esos Enlaces activos, sin omitir ni duplicar ninguno, ordenados por posición ascendente.
2. THE Página_Pública SHALL mostrar el título de cada Enlace activo como un elemento de enlace HTML cuyo destino es la URL de destino de ese Enlace y que el Visitante puede activar con un toque, un clic o la tecla Intro.
3. THE API_Pública SHALL entregar a la Página_Pública una lista que contenga todos los Enlaces activos y ningún Enlace inactivo.
4. WHEN la API_Pública entrega a la Página_Pública una lista sin Enlaces activos, THE Página_Pública SHALL mostrar el mensaje "Todavía no hay enlaces disponibles" y ningún elemento de Enlace.
5. IF la API_Pública no responde en un máximo de 5 segundos desde que la Página_Pública solicita la lista de Enlaces, o responde con un error, THEN THE Página_Pública SHALL mostrar el mensaje "No se han podido cargar los enlaces" y un botón "Reintentar", sin mostrar ningún elemento de Enlace.
6. THE Página_Pública SHALL mostrar la lista de Enlaces activos sin solicitar, requerir ni enviar un Token_Propietario.
7. WHILE la Página_Pública espera la respuesta de la API_Pública con la lista de Enlaces, THE Página_Pública SHALL mostrar un indicador de carga con el texto "Cargando enlaces…" anunciado a las tecnologías de asistencia.
8. WHEN el Visitante activa el botón "Reintentar", THE Página_Pública SHALL ocultar el mensaje de error, mostrar el indicador de carga y volver a solicitar la lista de Enlaces a la API_Pública con el mismo límite de 5 segundos, sin recargar la página.

### Requirement 2: Registrar clics y redirigir al destino

**User Story:** Como Propietario, quiero que cada clic en un enlace quede contado, para saber qué enlaces funcionan mejor. Como Visitante, quiero llegar al destino sin esperas, para no notar que el clic se está registrando.

#### Acceptance Criteria

1. WHEN un Visitante activa un Enlace activo con un toque, con el botón principal del puntero o con la tecla Intro, THE Página_Pública SHALL enviar a la API_Pública exactamente una petición de registro del Clic con el identificador del Enlace y el Valor_Canal de esa carga de página según el Requirement 4, mediante un envío en segundo plano que continúa aunque el Visitante abandone la página, sin reintentarla si falla.
2. WHEN un Visitante activa un Enlace activo según el criterio 1, THE Página_Pública SHALL llevar al Visitante a la URL de destino del Enlace en la misma pestaña en un máximo de 300 milisegundos desde la activación, sin esperar la respuesta de la API_Pública.
3. WHEN un Visitante abre un Enlace activo en una pestaña nueva con el botón central del puntero o con un clic con la tecla Ctrl o Cmd pulsada, THE Página_Pública SHALL enviar la petición de registro del Clic según el criterio 1 y dejar que el navegador abra la URL de destino en la pestaña nueva.
4. IF la petición de registro del Clic falla por un error de red, la API_Pública responde con un error o la API_Pública no responde, THEN THE Página_Pública SHALL llevar igualmente al Visitante a la URL de destino según los criterios 2 y 3, sin mostrarle ningún mensaje de error.
5. WHEN la API_Pública recibe un Clic para un Enlace activo, THE API_Pública SHALL guardar el Clic de forma duradera, responder con una confirmación de registro e incrementar en 1, en un máximo de 1 segundo desde la confirmación, el contador de Clics de ese Enlace, el contador total de Clics, el contador de Clics del Minuto UTC en que la API_Pública recibe el Clic y el contador de Clics del Canal_Origen del Clic.
6. IF la API_Pública recibe un Clic para un identificador de Enlace inexistente (incluidos los Enlaces eliminados) o para un Enlace inactivo, THEN THE API_Pública SHALL responder con un error de recurso no encontrado y mantener sin cambios todos los contadores de Clics.
7. IF la API_Pública responde con un error a una petición de registro de Clic, THEN THE API_Pública SHALL NOT incrementar ninguno de los contadores de Clics por ese Clic.
8. FOR ALL secuencia de N Clics que la API_Pública confirma sobre un Enlace activo dentro de una misma Época_Métricas, THE API_Pública SHALL dejar, transcurrido 1 segundo desde la última confirmación, exactamente N más en el contador de Clics de ese Enlace y en el contador total de Clics, y la suma de los incrementos de los contadores por Minuto y de los contadores por Canal_Origen SHALL ser también exactamente N.

### Requirement 3: Registrar visitas a la página pública

**User Story:** Como Propietario, quiero saber cuántas veces se abre mi página y desde qué canal, para comparar visitas con clics.

#### Acceptance Criteria

1. WHEN la Página_Pública termina de cargar con éxito la lista de Enlaces, incluida una lista sin Enlaces activos y aunque esa carga haya requerido pulsar "Reintentar", THE Página_Pública SHALL enviar a la API_Pública una única petición de registro de Visita por carga de página con el Valor_Canal de esa carga de página según el Requirement 4.
2. WHEN la API_Pública recibe una petición de registro de Visita, THE API_Pública SHALL guardar la Visita de forma duradera, responder con una confirmación de registro e incrementar en 1, en un máximo de 1 segundo desde la confirmación, el contador total de Visitas y el contador de Visitas del Canal_Origen de la Visita.
3. IF el registro de la Visita falla o no recibe respuesta en 5 segundos, THEN THE Página_Pública SHALL seguir mostrando los Enlaces activos y permitiendo pulsarlos, sin mostrar ningún mensaje de error al Visitante y sin reintentar el registro de esa Visita.
4. IF la carga de la lista de Enlaces falla o no recibe respuesta en 5 segundos, THEN THE Página_Pública SHALL NOT enviar ninguna petición de registro de Visita hasta que una carga posterior de la lista termine con éxito.
5. THE Página_Pública SHALL mostrar los Enlaces activos sin esperar a la respuesta del registro de la Visita.
6. WHEN el navegador restaura la Página_Pública desde su caché de navegación (por ejemplo, al volver con el botón Atrás) sin volver a cargarla, THE Página_Pública SHALL NOT enviar una nueva petición de registro de Visita.
7. FOR ALL secuencia de N Visitas que la API_Pública confirma dentro de una misma Época_Métricas, THE API_Pública SHALL dejar, transcurrido 1 segundo desde la última confirmación, el contador total de Visitas incrementado exactamente en N y la suma de los contadores de Visitas de todos los Canal_Origen incrementada exactamente en N.

### Requirement 4: Determinar el canal de origen

**User Story:** Como Propietario, quiero saber desde qué red social llegan las visitas y los clics, para saber qué canal funciona mejor sin que nadie pueda llenar el panel de canales inventados.

#### Acceptance Criteria

1. WHEN la Página_Pública registra una Visita o un Clic, THE Página_Pública SHALL enviar a la API_Pública el Valor_Canal, limitado a sus primeros 256 caracteres, o ningún valor si la URL no contiene el parámetro `src`, de modo que la Visita y todos los Clics de una misma carga de página envíen el mismo Valor_Canal.
2. WHEN la API_Pública recibe una Visita o un Clic con un Valor_Canal que, tras convertir solo las letras A-Z a minúsculas, coincide con un Canal_Predefinido, con `directo` o con `otro`, THE API_Pública SHALL registrar ese valor en minúsculas como Canal_Origen.
3. IF la API_Pública recibe una Visita o un Clic sin Valor_Canal o con un Valor_Canal vacío, THEN THE API_Pública SHALL registrar `directo` como Canal_Origen.
4. IF la API_Pública recibe una Visita o un Clic con un Valor_Canal no vacío que, tras convertir solo las letras A-Z a minúsculas, no coincide con ningún Canal_Predefinido, con `directo` ni con `otro` (por ejemplo, un canal inventado, un valor con espacios o caracteres no ASCII o un valor de más de 32 caracteres), THEN THE API_Pública SHALL registrar `otro` como Canal_Origen e incrementar los contadores correspondientes como en cualquier otra Visita o Clic aceptado.
5. THE API_Pública SHALL convertir a minúsculas solo las letras A-Z del Valor_Canal, sin aplicar ninguna otra transformación (por ejemplo, sin eliminar espacios, sin sustituir caracteres y sin convertir caracteres no ASCII).
6. THE Página_Pública SHALL determinar el Valor_Canal únicamente a partir del parámetro `src`, de modo que añadir, quitar o modificar cualquier otro parámetro de la URL no cambie el Canal_Origen resultante.
7. FOR ALL Valor_Canal, la normalización que aplica la API_Pública SHALL producir un Canal_Predefinido, `directo` u `otro`, y aplicarla dos veces SHALL producir el mismo resultado que aplicarla una vez (idempotencia).
8. IF la URL de la Página_Pública contiene el parámetro `src` más de una vez, THEN THE Página_Pública SHALL usar como Valor_Canal solo la primera aparición del parámetro e ignorar las demás.
9. IF el valor del parámetro `src` tiene una codificación de URL no válida (por ejemplo `%E0%A4%A`), THEN THE Página_Pública SHALL continuar la carga de la página sin errores y enviar el valor tal como lo decodifica el navegador, de modo que se registre según los criterios 2 a 4.

### Requirement 5: Acceso al panel con token

**User Story:** Como Propietario, quiero que solo quien conoce el token pueda ver métricas y gestionar enlaces, para proteger mi panel sin necesidad de cuentas de usuario.

#### Acceptance Criteria

1. WHEN el Propietario envía el formulario de acceso del Panel, THE Panel SHALL eliminar los espacios y saltos de línea iniciales y finales del valor introducido, guardarlo como Token_Guardado y enviarlo a la API_Gestión en la cabecera de autorización de la petición, nunca en la URL ni en el cuerpo.
2. WHEN la API_Gestión recibe una petición con un token que coincide exactamente con el Token_Propietario, distinguiendo mayúsculas y minúsculas, THE API_Gestión SHALL procesar la petición, y THE Panel SHALL mostrar las Métricas y las opciones de gestión de Enlaces tras la primera respuesta correcta.
3. IF una petición a la API_Gestión no incluye un token, incluye un token vacío o incluye un token que no coincide exactamente con el Token_Propietario, THEN THE API_Gestión SHALL responder con un error de no autorizado que no contenga ningún dato de Enlaces ni de Métricas y mantener todos los Enlaces y Métricas sin cambios.
4. THE API_Gestión SHALL comparar el token recibido con el Token_Propietario en un tiempo que no dependa de cuántos caracteres iniciales coinciden.
5. IF el Token_Propietario configurado tiene menos de 32 caracteres, THEN THE API_Gestión SHALL responder a todas las peticiones con un error de servidor sin procesarlas.
6. WHEN la API_Gestión recibe una petición, THE API_Gestión SHALL comprobar primero el tamaño del cuerpo según el Requirement 14, después el token y solo después el esquema de la petición, de modo que una petición sin token válido nunca reciba un error de validación de esquema.
7. IF una solicitud de Conexión al Servicio_Tiempo_Real no incluye un Ticket_Conexión o incluye uno inexistente, caducado o ya usado, THEN THE Servicio_Tiempo_Real SHALL rechazar la Conexión sin enviarle ningún Mensaje_Tiempo_Real.
8. IF la API_Gestión responde con un error de no autorizado, THEN THE Panel SHALL borrar el Token_Guardado, mostrar el mensaje "Token no válido" y mostrar de nuevo el formulario de acceso sin mostrar Métricas ni Enlaces.
9. THE Página_Pública y THE Panel SHALL entregarse al navegador sin contener el Token_Propietario en su código, en sus recursos estáticos ni en sus URL.
10. WHILE el Panel tiene una Sesión_Panel abierta, THE Panel SHALL conservar el Token_Guardado solo en el almacenamiento de sesión de la pestaña del navegador, sin escribirlo en cookies, en el almacenamiento local, en la URL del Panel ni en la URL de la Conexión, de modo que recargar la pestaña mantenga la Sesión_Panel.
11. WHEN el Propietario pulsa "Cerrar sesión", THE Panel SHALL borrar el Token_Guardado de la memoria y del almacenamiento de sesión del navegador, cerrar la Conexión activa y mostrar el formulario de acceso.
12. IF el Propietario envía el formulario de acceso con un valor vacío o formado solo por espacios, THEN THE Panel SHALL mostrar un mensaje que indique que el token es obligatorio sin enviar ninguna petición a la API_Gestión.
13. IF la API_Gestión no responde en 5 segundos o devuelve un error distinto de no autorizado al validar el Token_Guardado, THEN THE Panel SHALL mostrar un mensaje que indique que no se ha podido conectar con el servidor, distinto de "Token no válido", y mantener visible el formulario de acceso.
14. WHEN el Panel va a abrir una Conexión, incluida cada reconexión, THE Panel SHALL solicitar a la API_Gestión un Ticket_Conexión nuevo enviando el Token_Guardado en la cabecera de autorización, con un límite de 5 segundos, e incluir en la solicitud de Conexión solo ese Ticket_Conexión.
15. WHEN la API_Gestión recibe una solicitud de Ticket_Conexión con un token que coincide exactamente con el Token_Propietario, THE API_Gestión SHALL emitir un Ticket_Conexión nuevo, distinto de cualquier Ticket_Conexión emitido antes, que no contenga ni permita deducir el Token_Propietario.
16. WHEN el Servicio_Tiempo_Real acepta una solicitud de Conexión con un Ticket_Conexión, THE Servicio_Tiempo_Real SHALL marcar ese Ticket_Conexión como usado, de modo que se acepte como máximo una Conexión por Ticket_Conexión aunque varias solicitudes con el mismo Ticket_Conexión lleguen a la vez.
17. THE API_Gestión SHALL guardar de cada Ticket_Conexión solo un resumen criptográfico (hash) y su hora de caducidad, sin guardar el valor del Ticket_Conexión.
18. THE API_Gestión y THE Servicio_Tiempo_Real SHALL NOT escribir el token recibido, el Token_Propietario ni el Ticket_Conexión en los registros de ejecución ni en las respuestas de error.

### Requirement 6: Gestionar enlaces

**User Story:** Como Propietario, quiero crear, editar, reordenar, desactivar y eliminar mis enlaces, para mantener actualizada mi página pública sin borrar por error un enlace que todavía necesito.

#### Acceptance Criteria

1. WHEN el Propietario crea un Enlace con un título y una URL de destino válidos y existen menos de 10 Enlaces, THE API_Gestión SHALL guardar el Enlace con estado activo, con el título sin espacios iniciales ni finales, con un identificador nuevo distinto del de cualquier Enlace existente o eliminado y en la posición siguiente a la última de la lista, y SHALL devolver el Enlace creado.
2. WHEN el Propietario edita el título o la URL de destino de un Enlace existente con valores válidos, THE API_Gestión SHALL guardar los nuevos valores y conservar sin cambios el identificador, la posición, el estado y el contador de Clics del Enlace.
3. WHEN el Propietario cambia el estado de un Enlace existente entre activo e inactivo, THE API_Gestión SHALL guardar el nuevo estado y conservar sin cambios el título, la URL de destino, la posición y el contador de Clics del Enlace.
4. WHEN el Propietario envía un nuevo orden que contiene una sola vez el identificador de cada Enlace existente, THE API_Gestión SHALL guardar las posiciones en ese orden de forma que la Página_Pública muestre los Enlaces activos en el mismo orden relativo.
5. WHEN el Propietario elimina un Enlace existente, THE API_Gestión SHALL retirar el Enlace de la lista de Enlaces, conservar el orden relativo de los Enlaces restantes, dejar de incluir el Enlace eliminado en los Clics por Enlace y conservar sin cambios el contador total de Clics, los Clics por Minuto y los Clics por Canal_Origen.
6. THE API_Gestión SHALL aceptar como título válido una cadena que tenga de 1 a 80 puntos de código Unicode después de eliminar los espacios iniciales y finales y que no contenga caracteres de control (categoría Unicode Cc, incluidos los saltos de línea) ni caracteres de control bidireccional (U+202A a U+202E y U+2066 a U+2069).
7. THE API_Gestión SHALL aceptar como URL de destino válida una URL absoluta con esquema `http` o `https`, con nombre de host no vacío, sin usuario ni contraseña, sin espacios ni caracteres de control y con una longitud de 1 a 2048 caracteres.
8. IF el Propietario envía al crear o editar un Enlace un título o una URL de destino no válidos, THEN THE API_Gestión SHALL rechazar la operación con un error de validación que indique cada campo no válido, sin crear ningún Enlace y sin modificar ningún Enlace existente.
9. IF el Propietario intenta crear un Enlace cuando ya existen 10 Enlaces, sumando activos e inactivos, THEN THE API_Gestión SHALL rechazar la operación con un error que indique que se ha alcanzado el máximo de 10 Enlaces y mantener la lista de Enlaces sin cambios.
10. WHILE existen 10 Enlaces, THE Panel SHALL deshabilitar la opción de crear un Enlace y mostrar el mensaje "Has alcanzado el máximo de 10 enlaces".
11. WHEN la API_Gestión responde con éxito a una operación de gestión de Enlaces, THE Página_Pública SHALL mostrar la lista actualizada en cualquier carga de página que comience después de esa respuesta.
12. IF el Propietario intenta editar, cambiar el estado o eliminar un Enlace con un identificador que no existe, THEN THE API_Gestión SHALL responder con un error de recurso no encontrado y mantener todos los Enlaces y contadores sin cambios.
13. IF el Propietario envía un nuevo orden que omite el identificador de algún Enlace existente, lo repite o incluye un identificador inexistente, THEN THE API_Gestión SHALL rechazar la operación con un error de validación y mantener las posiciones de todos los Enlaces sin cambios.
14. WHEN la API_Gestión responde con éxito a una operación de gestión de Enlaces, THE Panel SHALL mostrar la lista de Enlaces actualizada sin recargar la página.
15. IF la API_Gestión rechaza una operación de gestión de Enlaces según los criterios 12 o 13, THEN THE Panel SHALL mostrar un aviso que indique que la lista ha cambiado y volver a solicitar la lista de Enlaces sin recargar la página.
16. WHEN el Propietario solicita eliminar un Enlace, THE Panel SHALL mostrar un diálogo de confirmación con el título del Enlace y el aviso de que se perderá su contador de Clics, y SHALL enviar la eliminación a la API_Gestión solo si el Propietario confirma.

### Requirement 7: Consultar métricas en el panel

**User Story:** Como Propietario, quiero ver las métricas agregadas al abrir el panel, para entender qué enlaces funcionan, cuándo y desde qué canal.

#### Acceptance Criteria

1. WHEN el Propietario abre el Panel con una Sesión_Panel abierta, THE Panel SHALL mostrar el título y el contador de Clics de cada Enlace existente, tanto activo como inactivo, mostrando el valor 0 para los Enlaces sin Clics.
2. WHEN el Propietario abre el Panel con una Sesión_Panel abierta, THE Panel SHALL mostrar el contador total de Clics y el contador total de Visitas, mostrando el valor 0 si no se ha registrado ningún Clic o ninguna Visita.
3. WHEN el Propietario abre el Panel con una Sesión_Panel abierta, THE Panel SHALL mostrar la Gráfica_Por_Minuto con exactamente 60 Minutos consecutivos que terminan en el Minuto actual según la hora del servidor, con valor 0 en los Minutos sin Clics y con las etiquetas de hora en la zona horaria del navegador del Propietario.
4. WHEN el Propietario abre el Panel con una Sesión_Panel abierta, THE Panel SHALL mostrar los contadores de Clics y de Visitas de cada Canal_Origen que tenga al menos una Visita o un Clic, ordenados por número de Clics descendente y, en caso de empate, por nombre del Canal_Origen en orden alfabético ascendente.
5. WHEN el Propietario abre el Panel con una Sesión_Panel abierta, THE Panel SHALL mostrar el Feed_Actividad con hasta 20 Eventos_Actividad almacenados, ordenados del más reciente al más antiguo, o el mensaje "Todavía no hay actividad" si no existe ningún Evento_Actividad.
6. THE API_Gestión SHALL incluir en cada respuesta de Métricas la Época_Métricas en curso y la hora del servidor, y THE Panel SHALL usar la diferencia entre esa hora y su propio reloj para calcular el Minuto actual.
7. WHEN la API_Gestión devuelve las Métricas y no ha confirmado ningún Clic ni Visita en el segundo anterior, THE API_Gestión SHALL devolver valores en los que la suma de los Clics por Canal_Origen coincida con el contador total de Clics, la suma de las Visitas por Canal_Origen coincida con el contador total de Visitas y la suma de los Clics de los Enlaces existentes no supere el contador total de Clics.
8. IF la API_Gestión no responde en 5 segundos o devuelve un error distinto de no autorizado al solicitar las Métricas, THEN THE Panel SHALL mostrar el mensaje "No se han podido cargar las métricas" y un botón "Reintentar", sin mostrar valores de contadores inventados ni parciales.
9. WHEN el Propietario pulsa el botón "Reintentar" de las Métricas, THE Panel SHALL volver a solicitar las Métricas a la API_Gestión y, si la respuesta es correcta, sustituir el mensaje de error por las Métricas recibidas.
10. WHILE no exista ningún Enlace, THE Panel SHALL mostrar el mensaje "Todavía no has creado ningún enlace" en lugar de la lista de contadores de Clics por Enlace.

### Requirement 8: Actualizar métricas en tiempo real

**User Story:** Como Propietario, quiero ver cómo suben los contadores en el momento en que alguien pulsa un enlace, para seguir la actividad en directo durante la demo.

#### Acceptance Criteria

1. WHILE exista al menos una Conexión abierta, WHEN la API_Pública confirma un Clic, THE Servicio_Tiempo_Real SHALL enviar a cada Conexión abierta, en un máximo de 3 segundos desde la confirmación, un Mensaje_Tiempo_Real con el valor actualizado del contador de Clics del Enlace pulsado, del contador total de Clics, del contador de Clics del Minuto del Clic y del contador de Clics del Canal_Origen del Clic, junto con el Evento_Actividad del Clic. Ese Mensaje_Tiempo_Real puede agrupar otros Clics y Visitas según el criterio 7.
2. WHILE exista al menos una Conexión abierta, WHEN la API_Pública confirma una Visita, THE Servicio_Tiempo_Real SHALL enviar a cada Conexión abierta, en un máximo de 3 segundos desde la confirmación, un Mensaje_Tiempo_Real con el valor actualizado del contador total de Visitas y del contador de Visitas del Canal_Origen de la Visita, junto con el Evento_Actividad de la Visita. Ese Mensaje_Tiempo_Real puede agrupar otros Clics y Visitas según el criterio 7.
3. WHEN el Panel recibe un Mensaje_Tiempo_Real con contadores actualizados de la Época_Métricas que muestra, THE Panel SHALL mostrar, sin recargar la página, los nuevos valores de cada contador incluido en el mensaje, manteniendo los contadores por Canal_Origen en el orden definido en el criterio 4 del Requirement 7.
4. WHEN comienza un nuevo Minuto según el reloj del navegador corregido con la hora del servidor (criterio 6 del Requirement 7), THE Panel SHALL añadir a la Gráfica_Por_Minuto una barra para el nuevo Minuto con valor 0 y retirar la barra del Minuto más antiguo, de forma que la Gráfica_Por_Minuto muestre exactamente los últimos 60 Minutos con el Minuto actual en el extremo final.
5. IF el Panel recibe, para la misma Época_Métricas, un valor de contador menor que el que ya muestra para el mismo Enlace, Minuto, Canal_Origen o contador total, THEN THE Panel SHALL conservar el valor mayor ya mostrado para ese elemento y aplicar el resto de valores recibidos.
6. IF el Panel recibe un Mensaje_Tiempo_Real que no cumple los Contratos_Compartidos o que pertenece a una Época_Métricas anterior a la que muestra, THEN THE Panel SHALL descartar el mensaje completo, conservar todos los valores mostrados y mantener la Conexión abierta.
7. THE Servicio_Tiempo_Real SHALL enviar a cada Conexión como máximo un Mensaje_Tiempo_Real de contadores por segundo, agrupando en ese mensaje todos los Clics y Visitas confirmados desde el mensaje anterior, y SHALL cumplir el plazo de 3 segundos de los criterios 1 y 2 con al menos 3000 Clics y Visitas por minuto.
8. WHILE el Panel tiene una Conexión abierta, WHEN transcurren 4 segundos desde el último Clic o Visita confirmado por la API_Pública, THE Panel SHALL mostrar los mismos valores de Clics por Enlace, contador total de Clics, Clics por Minuto, Visitas y Clics y Visitas por Canal_Origen que devuelve la API_Gestión en ese momento.
9. IF un Mensaje_Tiempo_Real incluye un Minuto anterior a los últimos 60 Minutos mostrados en la Gráfica_Por_Minuto, THEN THE Panel SHALL ignorar el valor de ese Minuto y aplicar el resto de valores del mensaje.
10. IF un Mensaje_Tiempo_Real incluye un Minuto posterior al Minuto actual del Panel, THEN THE Panel SHALL avanzar la Gráfica_Por_Minuto hasta ese Minuto según el criterio 4 y aplicar su valor.
11. IF un Mensaje_Tiempo_Real incluye un Enlace que el Panel no muestra, THEN THE Panel SHALL volver a solicitar las Métricas y la lista de Enlaces a la API_Gestión sin recargar la página.
12. WHILE el Panel tiene una Conexión abierta, THE Panel SHALL volver a solicitar las Métricas a la API_Gestión cada 30 segundos y aplicar los valores recibidos según el criterio 5.
13. WHILE el Panel tiene una Conexión abierta, THE Panel SHALL enviar un Mensaje_Mantenimiento por la Conexión cada 5 minutos.
14. IF el Servicio_Tiempo_Real recibe por una Conexión un mensaje que no es un Mensaje_Mantenimiento válido o que supera 128 bytes, THEN THE Servicio_Tiempo_Real SHALL descartarlo sin reenviarlo a ninguna Conexión y sin modificar ningún dato.

### Requirement 9: Feed de actividad

**User Story:** Como Propietario, quiero ver un feed con la actividad reciente, para percibir en directo qué está pasando en mi página.

#### Acceptance Criteria

1. WHEN el Panel recibe uno o varios Eventos_Actividad en un Mensaje_Tiempo_Real o en una respuesta de Métricas, THE Panel SHALL insertarlos en el Feed_Actividad de forma que todo el Feed_Actividad quede ordenado por hora del evento, del más reciente al más antiguo, sin mostrar dos veces un Evento_Actividad con el mismo identificador.
2. WHEN el Panel inserta Eventos_Actividad y el Feed_Actividad superaría los 20 Eventos_Actividad, THE Panel SHALL retirar los Eventos_Actividad más antiguos necesarios para que el Feed_Actividad no supere en ningún momento los 20 Eventos_Actividad.
3. THE API_Pública SHALL construir cada Evento_Actividad solo con un identificador técnico aleatorio, el tipo de evento (Clic o Visita), el Canal_Origen y la hora del evento, y añadir el título que tiene el Enlace en el momento del Clic solo cuando el tipo de evento es Clic.
4. WHILE se añaden Eventos_Actividad al Feed_Actividad, THE Panel SHALL anunciar a las tecnologías de asistencia, mediante una región viva con prioridad educada (`aria-live="polite"`), como máximo un resumen cada 10 segundos con el número de Eventos_Actividad nuevos (por ejemplo, "12 eventos nuevos").
5. THE Panel SHALL mostrar en cada entrada del Feed_Actividad el tipo de evento en español ("Clic" o "Visita"), el título del Enlace si el evento es un Clic, el Canal_Origen y la hora del evento en formato HH:MM:SS en la zona horaria del navegador del Propietario.
6. WHILE el Feed_Actividad no contiene ningún Evento_Actividad, THE Panel SHALL mostrar en el lugar del Feed_Actividad el mensaje "Todavía no hay actividad".

### Requirement 10: Reconexión del panel

**User Story:** Como Propietario, quiero que el panel se recupere solo si se corta la conexión, para no perder el directo durante la demo.

#### Acceptance Criteria

1. IF la Conexión del Panel se cierra sin que el Propietario haya cerrado sesión, THEN THE Panel SHALL reintentar la Conexión con espera exponencial: el primer intento 1 segundo después del cierre, la espera duplicada tras cada intento fallido (1, 2, 4, 8, 16 segundos) y un máximo de 30 segundos entre intentos, sin límite de intentos mientras la Sesión_Panel siga abierta.
2. WHILE el Panel tiene una Sesión_Panel abierta y no tiene una Conexión abierta, THE Panel SHALL mostrar el indicador "Conectando…" durante la primera Conexión de la carga de página y "Reconectando…" en las siguientes, en un máximo de 1 segundo desde el inicio de la espera o desde el cierre de la Conexión, y anunciarlo a las tecnologías de asistencia mediante una región viva con prioridad educada (`aria-live="polite"`).
3. WHEN el Panel restablece la Conexión, THE Panel SHALL volver a solicitar las Métricas a la API_Gestión y actualizar con los valores recibidos los contadores de Clics de cada Enlace, los contadores totales, la Gráfica_Por_Minuto, los contadores por Canal_Origen y el Feed_Actividad, sin recargar la página.
4. WHEN el Panel restablece la Conexión, THE Panel SHALL ocultar el indicador "Conectando…" o "Reconectando…" y reiniciar a 1 segundo la espera del siguiente ciclo de reintentos.
5. IF la API_Gestión responde con un error de no autorizado a la solicitud de un Ticket_Conexión, THEN THE Panel SHALL detener los reintentos, borrar el Token_Guardado, mostrar el mensaje "Token no válido" y mostrar el formulario de acceso.
6. IF la solicitud de Métricas tras restablecer la Conexión falla o no recibe respuesta en 5 segundos, THEN THE Panel SHALL conservar los valores mostrados y repetir la solicitud cada 5 segundos mientras la Conexión siga abierta, hasta recibir una respuesta válida.
7. WHEN el Propietario pulsa "Cerrar sesión" mientras hay reintentos de Conexión pendientes, THE Panel SHALL cancelar todos los reintentos pendientes y ocultar el indicador "Conectando…" o "Reconectando…".
8. IF el Servicio_Tiempo_Real rechaza un intento de Conexión por un Ticket_Conexión caducado o ya usado, o la solicitud del Ticket_Conexión falla o no recibe respuesta en 5 segundos por un motivo distinto de no autorizado, THEN THE Panel SHALL tratarlo como un intento fallido y continuar los reintentos según el criterio 1, solicitando un Ticket_Conexión nuevo en cada intento.

### Requirement 11: Privacidad

**User Story:** Como Visitante, quiero que la página no me identifique ni me rastree, para poder usarla con tranquilidad.

#### Acceptance Criteria

1. THE API_Pública SHALL guardar como resultado de cada Visita y cada Clic únicamente los datos necesarios para incrementar las Métricas (identificador del Enlace en el caso de un Clic, Canal_Origen, hora y Época_Métricas) y un Evento_Actividad con el contenido definido en el criterio 3 del Requirement 9.
2. THE API_Pública SHALL procesar Visitas y Clics sin almacenar direcciones IP, cabeceras User-Agent, cabeceras Referer, huellas del navegador ni identificadores persistentes del Visitante, ni en los datos persistidos ni en ningún registro de ejecución o de acceso de la aplicación, incluidos los de la red de distribución de contenido y de la capa de API.
3. THE Página_Pública SHALL funcionar sin crear cookies ni escribir en el almacenamiento local o de sesión del navegador del Visitante.
4. THE Página_Pública SHALL cargarse y registrar Visitas y Clics sin realizar peticiones a dominios distintos del dominio en el que se sirve la Página_Pública y del dominio de la API_Pública.
5. THE Servicio_Tiempo_Real SHALL guardar para cada Conexión únicamente su identificador técnico y su hora de creación, sin direcciones IP, cabeceras User-Agent, el Token_Propietario ni el Ticket_Conexión.
6. THE Servicio_Tiempo_Real SHALL asignar a los datos de cada Conexión una caducidad de 24 horas desde su creación, programar su eliminación automática a partir de ese momento y no usar los datos de una Conexión caducada para enviar Mensajes_Tiempo_Real.
7. WHEN el Servicio_Tiempo_Real recibe el aviso de cierre de una Conexión, THE Servicio_Tiempo_Real SHALL eliminar los datos de esa Conexión en un máximo de 60 segundos desde el aviso. Las Conexiones cerradas sin aviso se eliminan según el criterio 6 de este requisito y el criterio 7 del Requirement 12.
8. THE API_Pública SHALL asignar a cada Evento_Actividad una caducidad de 24 horas desde la hora del evento, programar su eliminación automática a partir de ese momento y no devolver ni enviar Eventos_Actividad caducados, conservando los contadores agregados de las Métricas.

### Requirement 12: Robustez ante picos de clics

**User Story:** Como Propietario, quiero que la app aguante a todo el público pulsando a la vez y que nadie pueda inflar las métricas de forma masiva, para que la demo funcione delante de la audiencia.

#### Acceptance Criteria

1. WHEN la API_Pública recibe 500 peticiones de Clic sobre Enlaces activos, enviadas de forma concurrente en un intervalo de 10 segundos y repartidas entre cualquier número de Enlaces activos, THE API_Pública SHALL confirmar los 500 Clics y dejar, transcurrido 1 segundo desde la última confirmación, la suma de los incrementos de los contadores de Clics por Enlace y el incremento del contador total de Clics exactamente en 500.
2. WHEN la API_Pública confirma los 500 Clics concurrentes del criterio 1, THE API_Pública SHALL dejar, transcurrido 1 segundo desde la última confirmación, la suma de los incrementos de los contadores de Clics por Minuto exactamente en 500 y la suma de los incrementos de los contadores de Clics por Canal_Origen exactamente en 500.
3. FOR ALL conjunto de N Clics confirmados de forma concurrente sobre un mismo Enlace con un contador de Clics de valor inicial V dentro de una misma Época_Métricas, THE API_Pública SHALL dejar el contador en el valor final V + N con independencia del orden en que se procesen los Clics (confluencia).
4. WHILE la API_Pública recibe las 500 peticiones de Clic concurrentes del criterio 1, THE API_Pública SHALL responder a cada petición de Clic en un máximo de 1 segundo en el percentil 95, medido desde que la petición llega a la API_Pública hasta que se envía la respuesta.
5. WHEN la API_Pública recibe 500 peticiones de Visita enviadas de forma concurrente en un intervalo de 10 segundos, THE API_Pública SHALL dejar, transcurrido 1 segundo desde la última confirmación, el contador total de Visitas incrementado exactamente en 500.
6. IF el envío de un Mensaje_Tiempo_Real a una Conexión falla, THEN THE Servicio_Tiempo_Real SHALL continuar el envío del mismo Mensaje_Tiempo_Real al resto de Conexiones abiertas dentro del plazo de 3 segundos del Requirement 8 y mantener sin cambios los contadores ya registrados.
7. IF el envío de un Mensaje_Tiempo_Real falla porque la Conexión ya no existe, THEN THE Servicio_Tiempo_Real SHALL eliminar los datos de esa Conexión y excluirla de los envíos posteriores.
8. IF la API_Pública recibe en total más de 200 peticiones de Clic y de Visita por segundo, con ráfagas de hasta 400 peticiones, THEN THE API_Pública SHALL rechazar las peticiones que superen ese límite con un error de demasiadas peticiones, sin incrementar ningún contador por ellas.
9. THE API_Pública SHALL aplicar el límite del criterio 8 de forma global, sin límites por dirección de origen, de modo que muchos Visitantes que comparten la misma red no se bloqueen entre sí.

### Requirement 13: Rendimiento y accesibilidad de la página pública

**User Story:** Como Visitante, quiero que la página cargue rápido en mi móvil y se pueda usar con cualquier dispositivo de entrada, para no abandonarla antes de pulsar un enlace.

#### Acceptance Criteria

1. WHEN un Visitante abre la Página_Pública sin caché del navegador en una Red_Móvil_Referencia, THE Página_Pública SHALL mostrar la lista completa de Enlaces activos, con hasta 10 Enlaces, en un máximo de 2 segundos desde el inicio de la navegación hasta que el último Enlace es visible, medido con la emulación de red de las herramientas de desarrollo del navegador y excluyendo la primera petición tras un despliegue.
2. THE Página_Pública SHALL mostrar todo su contenido sin desplazamiento horizontal en anchos de ventana de 320 a 1920 píxeles CSS, incluso con un título de Enlace de 80 caracteres sin espacios.
3. THE Página_Pública SHALL mostrar cada Enlace con un área táctil mínima de 44 por 44 píxeles CSS en anchos de ventana de 320 a 1920 píxeles CSS.
4. THE Página_Pública SHALL mostrar todo el texto, incluidos los títulos de los Enlaces, los mensajes de estado y el botón "Reintentar", con una relación de contraste mínima de 4,5:1 respecto a su fondo.
5. THE Página_Pública SHALL permitir recorrer con la tecla Tabulador todos los Enlaces activos en el mismo orden en que se muestran y activar el Enlace enfocado con la tecla Intro.
6. WHEN un Enlace o el botón "Reintentar" de la Página_Pública recibe el foco del teclado, THE Página_Pública SHALL mostrar un indicador de foco alrededor del elemento con una relación de contraste mínima de 3:1 respecto al fondo adyacente.
7. WHEN el Visitante amplía el zoom del navegador al 200 % en una ventana de 640 píxeles de ancho (equivalente a 320 píxeles CSS), THE Página_Pública SHALL mostrar todos los títulos de los Enlaces completos y sin solapamientos.
8. THE Página_Pública SHALL declarar el idioma español en el documento (`lang="es"`), tener un título de documento descriptivo y un único encabezado principal (`h1`).

### Requirement 14: Validación de entradas y contratos compartidos

**User Story:** Como Propietario, quiero que el sistema rechace datos mal formados, para que las métricas sean fiables y el servicio sea seguro.

#### Acceptance Criteria

1. WHEN la API_Pública o la API_Gestión reciben una petición, THE API correspondiente SHALL validar el cuerpo, los parámetros de ruta y los parámetros de consulta contra los esquemas de los Contratos_Compartidos antes de leer o modificar cualquier contador, Enlace o Evento_Actividad.
2. IF una petición no cumple el esquema de los Contratos_Compartidos o su cuerpo no es un texto JSON sintácticamente válido, THEN THE API correspondiente SHALL responder con un error de validación que indique el campo o parámetro no válido y mantener sin cambios todos los contadores, Enlaces y Eventos_Actividad.
3. THE Contratos_Compartidos SHALL definir el Valor_Canal de las peticiones de Visita y de Clic como una cadena opcional de hasta 256 caracteres, de modo que un valor que no corresponde a ningún Canal_Predefinido cumpla el esquema y se registre como `otro` según el criterio 4 del Requirement 4.
4. IF una petición tiene un cuerpo mayor de 10 KB (10 240 bytes), THEN THE API correspondiente SHALL rechazarla con un error de validación sin procesar su contenido y mantener sin cambios todos los contadores, Enlaces y Eventos_Actividad.
5. IF una petición de navegador a la API_Pública o a la API_Gestión procede de un origen distinto del dominio en el que se sirven la Página_Pública y el Panel, THEN THE API correspondiente SHALL responder sin autorizar a ese origen a leer la respuesta, de modo que el navegador bloquee el acceso a su contenido.
6. THE Contratos_Compartidos SHALL serializar cada Mensaje_Tiempo_Real válido a un texto JSON.
7. WHEN los Contratos_Compartidos reciben un texto JSON que cumple el esquema de Mensaje_Tiempo_Real, THE Contratos_Compartidos SHALL convertirlo en el Mensaje_Tiempo_Real correspondiente.
8. FOR ALL Mensaje_Tiempo_Real válido, serializarlo a JSON y después convertirlo de nuevo SHALL producir un Mensaje_Tiempo_Real equivalente al original (propiedad de ida y vuelta).
9. THE Página_Pública y THE Panel SHALL mostrar los títulos de los Enlaces como texto literal, de modo que un título que contenga etiquetas HTML (por ejemplo `<script>` o `<b>`) se muestre con esos caracteres visibles y sin crear elementos HTML ni ejecutar código.
10. IF los Contratos_Compartidos reciben un texto que no es JSON sintácticamente válido o que no cumple el esquema de Mensaje_Tiempo_Real, THEN THE Contratos_Compartidos SHALL devolver un error descriptivo que indique el motivo del rechazo, sin producir ningún Mensaje_Tiempo_Real.

### Requirement 15: Accesibilidad e idioma del panel

**User Story:** Como Propietario, quiero poder usar el panel con teclado y con tecnologías de asistencia, para gestionar mis enlaces y seguir la demo sin depender del ratón.

#### Acceptance Criteria

1. THE Panel SHALL permitir crear, editar, activar, desactivar, reordenar y eliminar Enlaces, confirmar diálogos y reiniciar Métricas usando solo el teclado, sin requerir arrastrar con el puntero.
2. THE Panel SHALL ofrecer a las tecnologías de asistencia, como texto, el número de Clics de cada uno de los 60 Minutos mostrados en la Gráfica_Por_Minuto junto con la hora de inicio de cada Minuto en la zona horaria del navegador del Propietario.
3. THE Página_Pública y THE Panel SHALL mostrar en español todos los textos de la interfaz, excepto los títulos y URLs de destino de los Enlaces introducidos por el Propietario.
4. THE Panel SHALL mostrar todo el texto con una relación de contraste mínima de 4,5:1 respecto a su fondo y un indicador de foco con una relación de contraste mínima de 3:1 respecto al fondo adyacente en cada elemento que recibe el foco del teclado.
5. THE Panel SHALL declarar el idioma español en el documento (`lang="es"`), tener un título de documento descriptivo y un único encabezado principal (`h1`).
6. WHILE el navegador del Propietario indica preferencia por movimiento reducido (`prefers-reduced-motion: reduce`), THE Panel SHALL actualizar la Gráfica_Por_Minuto, los contadores y el Feed_Actividad sin animaciones.

### Requirement 16: Reiniciar métricas

**User Story:** Como Propietario, quiero poner las métricas a cero justo antes de la demo, para que el público vea solo sus propios clics y no los de los ensayos.

#### Acceptance Criteria

1. WHEN el Propietario pulsa "Reiniciar métricas" en el Panel, THE Panel SHALL mostrar un diálogo de confirmación que indique que todos los contadores y el Feed_Actividad se pondrán a cero y que la acción no se puede deshacer, con los botones "Reiniciar" y "Cancelar" y con el foco inicial en "Cancelar".
2. WHEN el Propietario pulsa "Cancelar" o cierra el diálogo de confirmación, THE Panel SHALL cerrar el diálogo sin enviar ninguna petición a la API_Gestión.
3. WHEN la API_Gestión recibe una petición de reinicio de Métricas con un token válido, THE API_Gestión SHALL iniciar una nueva Época_Métricas con un número mayor que el de la anterior, de modo que todos los contadores de Métricas de la nueva Época_Métricas valgan 0, dejar de devolver los Eventos_Actividad de Épocas_Métricas anteriores y conservar todos los Enlaces sin cambios.
4. IF el reinicio de Métricas falla, THEN THE API_Gestión SHALL mantener la Época_Métricas en curso y todos sus contadores sin cambios y responder con un error, y THE Panel SHALL mostrar el mensaje "No se han podido reiniciar las métricas" y conservar los valores mostrados.
5. WHEN la API_Gestión completa un reinicio de Métricas, THE Servicio_Tiempo_Real SHALL enviar a cada Conexión abierta, en un máximo de 3 segundos, un Mensaje_Tiempo_Real con la nueva Época_Métricas y todos los contadores a 0.
6. WHEN el Panel recibe un Mensaje_Tiempo_Real o una respuesta de Métricas con una Época_Métricas mayor que la que muestra, THE Panel SHALL mostrar a 0 todos los contadores y las barras de la Gráfica_Por_Minuto, vaciar el Feed_Actividad, aplicar los valores recibidos de la nueva Época_Métricas y descartar desde entonces los valores de Épocas_Métricas anteriores.
7. THE API_Pública SHALL contabilizar cada Clic y cada Visita confirmados en una única Época_Métricas, y todo Clic o Visita confirmado después de la respuesta de un reinicio en la nueva Época_Métricas.
8. THE API_Gestión SHALL incluir en los Clics por Enlace, por Minuto y por Canal_Origen y en los contadores totales solo los Clics y Visitas de la Época_Métricas en curso.

### Requirement 17: Seguridad del transporte y de las respuestas

**User Story:** Como Propietario, quiero que el tráfico y las respuestas estén protegidos, para que nadie pueda leer el token, inyectar código en el panel ni recuperar métricas desde una caché.

#### Acceptance Criteria

1. THE Página_Pública, THE Panel, THE API_Pública, THE API_Gestión y THE Servicio_Tiempo_Real SHALL aceptar tráfico solo por HTTPS o WSS, y las peticiones HTTP a la Página_Pública y al Panel SHALL redirigirse a HTTPS.
2. THE Página_Pública y THE Panel SHALL entregarse con las cabeceras `Content-Security-Policy` (que solo permita scripts del propio dominio, conexiones al dominio de la API y del Servicio_Tiempo_Real e impida incrustar la página en marcos de otros sitios), `Strict-Transport-Security`, `X-Content-Type-Options: nosniff` y `Referrer-Policy: strict-origin-when-cross-origin`.
3. THE API_Pública y THE API_Gestión SHALL incluir la cabecera `Cache-Control: no-store` en todas sus respuestas.
4. THE Panel SHALL entregarse con la indicación de no indexación para buscadores (`noindex`).
