import appInsights from "applicationinsights";
import type { TelemetryClient } from "applicationinsights";

let initialized = false;

/**
 * Initializes Application Insights / Azure Monitor telemetry.
 *
 * Safe no-op when no connection string is provided (local dev, mock mode,
 * tests). Only initializes once even if called multiple times.
 */
export function initTelemetry(connectionString?: string): void {
  if (initialized) {
    return;
  }

  const trimmed = connectionString?.trim();
  if (!trimmed) {
    console.log("Telemetry disabled: no APPLICATIONINSIGHTS_CONNECTION_STRING configured.");
    return;
  }

  appInsights
    .setup(trimmed)
    .setAutoDependencyCorrelation(true)
    .setAutoCollectRequests(true)
    .setAutoCollectPerformance(true, true)
    .setAutoCollectExceptions(true)
    .setAutoCollectDependencies(true)
    .setAutoCollectConsole(false)
    .setSendLiveMetrics(false)
    .start();

  initialized = true;
  console.log("Telemetry enabled: Application Insights initialized.");
}

function getClient(): TelemetryClient | undefined {
  return initialized ? appInsights.defaultClient : undefined;
}

/**
 * Records a custom event keyed by agent action type. Safe no-op if telemetry
 * was not initialized.
 */
export function trackActionMetric(actionType: string): void {
  const client = getClient();
  if (!client) {
    return;
  }

  client.trackEvent({ name: "AgentAction", properties: { actionType } });
}

/**
 * Records a custom event with optional string properties. Safe no-op if
 * telemetry was not initialized.
 */
export function trackEvent(name: string, properties?: Record<string, string>): void {
  const client = getClient();
  if (!client) {
    return;
  }

  client.trackEvent({ name, properties });
}

/**
 * Records an exception. Safe no-op if telemetry was not initialized.
 */
export function trackException(error: unknown): void {
  const client = getClient();
  if (!client) {
    return;
  }

  const exception = error instanceof Error ? error : new Error(String(error));
  client.trackException({ exception });
}
