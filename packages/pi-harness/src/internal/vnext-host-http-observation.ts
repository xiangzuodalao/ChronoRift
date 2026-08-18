import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

import type { Dispatcher } from "undici";

const RECORD_KIND = "vnext-pi-host-http-transport-observation" as const;

interface MutableTransportCounts {
  requestStartedCount: number;
  responseHeadersCount: number;
  responseCompleteCount: number;
  requestErrorCount: number;
}

export interface VNextPiHostHttpTransportObservationV1 {
  readonly schemaVersion: 1;
  readonly recordKind: typeof RECORD_KIND;
  readonly requestStartedCount: number;
  readonly responseHeadersCount: number;
  readonly responseCompleteCount: number;
  readonly requestErrorCount: number;
  readonly recordContentSha256: string;
}

export interface VNextPiHostHttpTransportObservationScopeV1 {
  readonly run: <T>(operation: () => T) => T;
  readonly snapshot: () => VNextPiHostHttpTransportObservationV1;
}

const observationStorage = new AsyncLocalStorage<MutableTransportCounts>();

const hasExactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean => {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
};

const isNonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const observationContent = (counts: MutableTransportCounts): string =>
  JSON.stringify({
    schemaVersion: 1,
    recordKind: RECORD_KIND,
    requestStartedCount: counts.requestStartedCount,
    responseHeadersCount: counts.responseHeadersCount,
    responseCompleteCount: counts.responseCompleteCount,
    requestErrorCount: counts.requestErrorCount,
  });

const observationDigest = (counts: MutableTransportCounts): string =>
  createHash("sha256").update(observationContent(counts), "utf8").digest("hex");

const freezeObservation = (
  counts: MutableTransportCounts,
): VNextPiHostHttpTransportObservationV1 =>
  Object.freeze({
    schemaVersion: 1,
    recordKind: RECORD_KIND,
    requestStartedCount: counts.requestStartedCount,
    responseHeadersCount: counts.responseHeadersCount,
    responseCompleteCount: counts.responseCompleteCount,
    requestErrorCount: counts.requestErrorCount,
    recordContentSha256: observationDigest(counts),
  });

export const parseVNextPiHostHttpTransportObservationV1 = (
  value: unknown,
): VNextPiHostHttpTransportObservationV1 => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("vNext Pi Host HTTP transport observation is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    !hasExactKeys(record, [
      "schemaVersion",
      "recordKind",
      "requestStartedCount",
      "responseHeadersCount",
      "responseCompleteCount",
      "requestErrorCount",
      "recordContentSha256",
    ]) ||
    record.schemaVersion !== 1 ||
    record.recordKind !== RECORD_KIND ||
    !isNonNegativeSafeInteger(record.requestStartedCount) ||
    !isNonNegativeSafeInteger(record.responseHeadersCount) ||
    !isNonNegativeSafeInteger(record.responseCompleteCount) ||
    !isNonNegativeSafeInteger(record.requestErrorCount)
  ) {
    throw new TypeError("vNext Pi Host HTTP transport observation is invalid");
  }
  const counts: MutableTransportCounts = {
    requestStartedCount: record.requestStartedCount,
    responseHeadersCount: record.responseHeadersCount,
    responseCompleteCount: record.responseCompleteCount,
    requestErrorCount: record.requestErrorCount,
  };
  if (record.recordContentSha256 !== observationDigest(counts)) {
    throw new TypeError(
      "vNext Pi Host HTTP transport observation hash is invalid",
    );
  }
  return freezeObservation(counts);
};

export const createVNextPiHostHttpTransportObservationScopeV1 =
  (): VNextPiHostHttpTransportObservationScopeV1 => {
    const counts: MutableTransportCounts = {
      requestStartedCount: 0,
      responseHeadersCount: 0,
      responseCompleteCount: 0,
      requestErrorCount: 0,
    };
    return Object.freeze({
      run: <T>(operation: () => T): T =>
        observationStorage.run(counts, operation),
      snapshot: (): VNextPiHostHttpTransportObservationV1 =>
        freezeObservation(counts),
    });
  };

/**
 * Wraps Undici's dispatch callback boundary without reading request options or
 * response data. The active Host turn receives counts only.
 */
export const observeVNextPiHostHttpDispatchV1 =
  (dispatch: Dispatcher.Dispatch): Dispatcher.Dispatch =>
  (options, handler): boolean => {
    const counts = observationStorage.getStore();
    if (counts === undefined) return dispatch(options, handler);

    const observedHandler: Dispatcher.DispatchHandler = {
      onRequestStart: (controller, context) => {
        counts.requestStartedCount += 1;
        handler.onRequestStart?.call(handler, controller, context);
      },
      onRequestUpgrade: (controller, statusCode, headers, socket) => {
        handler.onRequestUpgrade?.call(
          handler,
          controller,
          statusCode,
          headers,
          socket,
        );
      },
      onResponseStart: (controller, statusCode, headers, statusMessage) => {
        counts.responseHeadersCount += 1;
        handler.onResponseStart?.call(
          handler,
          controller,
          statusCode,
          headers,
          statusMessage,
        );
      },
      onResponseData: (controller, chunk) => {
        handler.onResponseData?.call(handler, controller, chunk);
      },
      onResponseEnd: (controller, trailers) => {
        counts.responseCompleteCount += 1;
        handler.onResponseEnd?.call(handler, controller, trailers);
      },
      onResponseError: (controller, error) => {
        counts.requestErrorCount += 1;
        handler.onResponseError?.call(handler, controller, error);
      },
      onResponseStarted: () => {
        handler.onResponseStarted?.call(handler);
      },
      onBodySent: (chunk) => {
        handler.onBodySent?.call(handler, chunk);
      },
      onRequestSent: () => {
        handler.onRequestSent?.call(handler);
      },
    };
    return dispatch(options, observedHandler);
  };
