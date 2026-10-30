# Producto: Link in Bio

## Visión
Una app web tipo "Link in Bio": una página web pública que muestra una lista de enlaces de una persona y registra cuántos clics recibe cada uno. El propietario dispone de un panel con métricas en tiempo real para entender qué enlaces funcionan, cuándo y desde qué canal.

## Contexto
Este repositorio es una demo en vivo de desarrollo dirigido por especificaciones (spec-driven development) con Kiro. El objetivo es mostrar un flujo reproducible para usar la IA con disciplina:

0. Steering: contexto de producto, tecnología y estructura.
1. Idea en una frase.
2. Requisitos en notación EARS.
3. Diseño de arquitectura.
4. Plan de tareas.
5. Implementación guiada por tareas, con hooks y steering para mantener la calidad.
6. Despliegue en AWS (serverless, CDK).

Cada fase vive en su propia rama (`fase-0-steering`, `fase-1-...`, etc.) para que el público pueda replicarla paso a paso.

## Usuarios
- Visitante: abre la página pública (normalmente escaneando un QR desde el móvil) y hace clic en los enlaces.
- Propietario: gestiona sus enlaces y consulta un panel de métricas.

## Acceso
- Sin sistema de usuarios: el panel del propietario se protege con un token secreto que solo conoce el propietario.
- Las métricas y la gestión de enlaces solo están disponibles con un token válido.
- La página pública no requiere token.

## Privacidad
- Las métricas son solo agregados (contadores). No se guarda ningún dato que identifique a una persona.
- No se guardan IPs, huellas de navegador ni identificadores persistentes del visitante.
- La página pública no usa cookies ni almacenamiento local con fines de seguimiento.
- Los identificadores técnicos que necesite el tiempo real (por ejemplo, de conexión) no identifican a la persona y expiran automáticamente.

## Momento clave de la demo
El público escanea un QR, abre la página en su móvil, pulsa un enlace y ve en pantalla cómo el contador de clics sube en tiempo real, cómo aparece el pico en la gráfica por minuto y cómo se mueve el feed de actividad.

## Principios de producto
- Mínimo viable: solo lo necesario para que la demo funcione de forma fiable delante de público.
- Mobile first: la mayoría de visitas vendrán del móvil.
- Rápido: la página pública debe cargar en menos de 2 segundos en una red móvil.
- Accesible: HTML semántico, contraste suficiente y navegable con teclado.
- Robusto ante picos: decenas o cientos de personas pueden hacer clic a la vez.

## Fuera de alcance
- Registro de usuarios, multi-tenant o autenticación compleja.
- Visitantes únicos, huella del navegador y almacenamiento de IPs.
- Geolocalización (incluido el país) y tipo de dispositivo.
- Embudos, cohortes u otra analítica avanzada.
- Más de un parámetro de origen (UTM completos).
- Exportación de datos o informes.
- Editor visual de temas.
