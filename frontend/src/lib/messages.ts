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
