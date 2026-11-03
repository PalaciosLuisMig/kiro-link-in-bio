// Environment access for the composition roots.

/** An environment map, e.g. `process.env`. */
export type Env = Readonly<Record<string, string | undefined>>;

/**
 * Reads a required environment variable. Fails fast, with the variable NAME in
 * the message (never a value), so a misconfigured deployment shows up at cold
 * start instead of as a confusing error on the first request.
 */
export function requireEnv(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}
