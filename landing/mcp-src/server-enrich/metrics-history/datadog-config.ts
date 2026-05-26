/**
 * Datadog credentials / endpoint config for the metrics-history adapter · feat-064 (L2a · §6).
 *
 * Credentials are read from the environment (secrets manager / .env.local · test-infra §12.F) ·
 * NEVER hardcoded, NEVER logged. Two keys are required for the read path: DD-API-KEY (the reporting
 * key) + DD-APPLICATION-KEY (required for the query API).
 *
 * Env vars:
 *   DD_API_KEY   · Datadog API key
 *   DD_APP_KEY   · Datadog Application key (read path)
 *   DD_SITE      · Datadog site (full host · Datadog convention) · default 'us5.datadoghq.com'
 *                  · accepted values include 'datadoghq.com' / 'us3.datadoghq.com' /
 *                  'us5.datadoghq.com' / 'datadoghq.eu' / 'ap1.datadoghq.com' / 'ddog-gov.com'.
 */

export type DatadogConfig = {
  apiKey: string;
  appKey: string;
  /** API base URL · e.g. https://api.us5.datadoghq.com */
  baseUrl: string;
};

const DEFAULT_SITE = 'us5.datadoghq.com';

/**
 * Read Datadog config from the environment.
 *
 * @returns the config, or null when either key is missing (the adapter then returns an `auth` error
 *   rather than throwing · the seam stays fail-closed without a hard crash).
 */
export function readDatadogConfig(): DatadogConfig | null {
  const apiKey = process.env.DD_API_KEY;
  const appKey = process.env.DD_APP_KEY;
  if (!apiKey || !appKey) return null;
  const site = process.env.DD_SITE || DEFAULT_SITE;
  return {
    apiKey,
    appKey,
    baseUrl: `https://api.${site}`,
  };
}
