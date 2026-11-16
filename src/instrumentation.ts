import type { Instrumentation } from "next";

/** Server errors go to `app_error` for the daily health check (docs/operations/MONITORING.md). */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { recordAppError } = await import("./server/app-errors");
  // The route file, not the URL: no ids or search text are stored.
  await recordAppError({ source: context.routeType, route: context.routePath, method: request.method, error });
};
