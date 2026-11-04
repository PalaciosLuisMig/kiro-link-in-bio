// User-facing texts, in Spanish. The requirements fix these literals, so they
// live in one place: the views and the tests import them instead of repeating
// strings (code is in English, interface texts in Spanish).

export const MESSAGES = {
  /** Heading of the public page (the page's single `h1`). */
  publicTitle: 'Mis enlaces',
  /** Announced to assistive technology while the list loads (Requirement 1.7). */
  loading: 'Cargando enlaces…',
  /** Shown when there are no active links (Requirement 1.4). */
  empty: 'Todavía no hay enlaces disponibles',
  /** Shown when the list does not load in 5 s or fails (Requirement 1.5). */
  loadError: 'No se han podido cargar los enlaces',
  /** Label of the button that loads the list again (Requirement 1.8). */
  retry: 'Reintentar',
  /** Accessible names of the theme button: they say what a click does. */
  themeToDark: 'Cambiar a tema oscuro',
  themeToLight: 'Cambiar a tema claro',
} as const;

/** Texts of the owner's Panel, in Spanish (Requirement 15.3). */
export const PANEL = {
  pageTitle: 'Panel de control',

  // Sign in (Requirement 5)
  tokenLabel: 'Token del propietario',
  tokenHint: 'Introduce tu token para ver las métricas y gestionar tus enlaces.',
  signIn: 'Entrar',
  signingIn: 'Comprobando…',
  tokenRequired: 'El token es obligatorio',
  tokenInvalid: 'Token no válido',
  serverUnreachable: 'No se ha podido conectar con el servidor',
  signOut: 'Cerrar sesión',

  // Connection indicator (Requirement 10.2)
  connecting: 'Conectando…',
  reconnecting: 'Reconectando…',

  // Metrics (Requirement 7)
  metricsLoading: 'Cargando métricas…',
  metricsLoadError: 'No se han podido cargar las métricas',
  totalsHeading: 'Totales',
  clicks: 'Clics',
  visits: 'Visitas',
  chartHeading: 'Clics por minuto',
  chartCaption: 'Clics en cada uno de los últimos 60 minutos',
  chartMinute: 'Hora de inicio',
  channelsHeading: 'Canales de origen',
  channelName: 'Canal',
  noChannels: 'Todavía no hay canales con actividad',

  // Activity feed (Requirement 9)
  feedHeading: 'Actividad',
  noActivity: 'Todavía no hay actividad',
  eventClick: 'Clic',
  eventVisit: 'Visita',

  // Links (Requirement 6)
  linksHeading: 'Enlaces',
  noLinks: 'Todavía no has creado ningún enlace',
  linkLimit: 'Has alcanzado el máximo de 10 enlaces',
  addHeading: 'Añadir enlace',
  addLink: 'Añadir enlace',
  titleLabel: 'Título',
  urlLabel: 'URL de destino',
  edit: 'Editar',
  save: 'Guardar',
  cancel: 'Cancelar',
  moveUp: 'Subir',
  moveDown: 'Bajar',
  activate: 'Activar',
  deactivate: 'Desactivar',
  remove: 'Eliminar',
  stateActive: 'Activo',
  stateInactive: 'Inactivo',
  listChanged: 'La lista de enlaces ha cambiado. La hemos vuelto a cargar.',
  urlNeedsHttps: 'La URL debe empezar por https://',
  linkInvalid: 'Revisa el título y la URL: no son válidos.',
  linkFailed: 'No se ha podido completar la acción. Inténtalo de nuevo.',

  // Confirmations (Requirements 6.16, 16.1)
  removeTitle: 'Eliminar enlace',
  confirmRemove: 'Eliminar',
  resetMetrics: 'Reiniciar métricas',
  resetTitle: 'Reiniciar métricas',
  resetMessage:
    'Todos los contadores y el feed de actividad se pondrán a cero. Esta acción no se puede deshacer.',
  confirmReset: 'Reiniciar',
  resetError: 'No se han podido reiniciar las métricas',
} as const;

/** Texts that need a value, so each button says exactly what it acts on (15.1). */
export const panelLabel = {
  removeMessage: (title: string): string =>
    `Vas a eliminar «${title}». Se perderá su contador de clics.`,
  moveUp: (title: string): string => `${PANEL.moveUp} «${title}»`,
  moveDown: (title: string): string => `${PANEL.moveDown} «${title}»`,
  edit: (title: string): string => `${PANEL.edit} «${title}»`,
  remove: (title: string): string => `${PANEL.remove} «${title}»`,
  toggle: (title: string, active: boolean): string =>
    `${active ? PANEL.deactivate : PANEL.activate} «${title}»`,
  chartSummary: (total: number, peak: number, peakTime: string): string =>
    total === 0
      ? 'Gráfica de clics por minuto en la última hora: todavía no hay clics'
      : `Gráfica de clics por minuto en la última hora: ${total} en total, con un máximo de ${peak} a las ${peakTime}`,
} as const;
