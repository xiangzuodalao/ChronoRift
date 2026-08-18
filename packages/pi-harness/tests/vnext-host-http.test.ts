import { describe, expect, it, vi } from "vitest";

import type { Dispatcher } from "undici";

import {
  createVNextPiHostHttpTransportConfigurer,
  hasVNextPiHostHttpProxy,
  parseVNextPiHostHttpTransportObservationV1,
} from "../src/index.js";
import {
  createVNextPiHostHttpTransportObservationScopeV1,
  observeVNextPiHostHttpDispatchV1,
} from "../src/internal/vnext-host-http-observation.js";

describe("vNext Pi Host HTTP transport", () => {
  it("recognizes explicit HTTP(S) proxy variables without exposing values", () => {
    expect(hasVNextPiHostHttpProxy({})).toBe(false);
    expect(hasVNextPiHostHttpProxy({ HTTPS_PROXY: "   " })).toBe(false);
    expect(
      hasVNextPiHostHttpProxy({ HTTPS_PROXY: "http://proxy.invalid:8080" }),
    ).toBe(true);
    expect(
      hasVNextPiHostHttpProxy({ http_proxy: "http://proxy.invalid:8080" }),
    ).toBe(true);
  });

  it("installs the proxy dispatcher once and leaves direct Host networking unchanged", () => {
    const installProxyDispatcher = vi.fn();
    const configure = createVNextPiHostHttpTransportConfigurer({
      installProxyDispatcher,
    });

    expect(configure({})).toBe(false);
    expect(configure({ HTTPS_PROXY: "http://proxy.invalid:8080" })).toBe(true);
    expect(configure({ HTTP_PROXY: "http://another.invalid:8080" })).toBe(true);
    expect(installProxyDispatcher).toHaveBeenCalledTimes(1);
  });

  it("can retry installation after a failed attempt", () => {
    const installProxyDispatcher = vi
      .fn<() => void>()
      .mockImplementationOnce(() => {
        throw new Error("dispatcher setup failed");
      })
      .mockImplementationOnce(() => undefined);
    const configure = createVNextPiHostHttpTransportConfigurer({
      installProxyDispatcher,
    });
    const environment = { HTTPS_PROXY: "http://proxy.invalid:8080" };

    expect(() => configure(environment)).toThrow("dispatcher setup failed");
    expect(configure(environment)).toBe(true);
    expect(installProxyDispatcher).toHaveBeenCalledTimes(2);
  });

  it("counts only dispatch lifecycle boundaries and never retains request material", async () => {
    const forwarded: string[] = [];
    const secret =
      "https://provider.invalid/private?token=DO_NOT_RETAIN Authorization body-secret";
    const dispatch: Dispatcher.Dispatch = (_options, handler) => {
      const controller = {} as Dispatcher.DispatchController;
      handler.onRequestStart?.(controller, null);
      handler.onResponseStart?.(controller, 200, {
        authorization: "DO_NOT_RETAIN",
      });
      handler.onResponseEnd?.(controller, {});
      return true;
    };
    const observed = observeVNextPiHostHttpDispatchV1(dispatch);
    const scope = createVNextPiHostHttpTransportObservationScopeV1();

    await scope.run(async () => {
      observed(
        {
          origin: "https://provider.invalid",
          path: `/private?token=${secret}`,
          method: "POST",
          headers: { authorization: secret },
          body: secret,
        },
        {
          onRequestStart: () => forwarded.push("started"),
          onResponseStart: () => forwarded.push("headers"),
          onResponseEnd: () => forwarded.push("complete"),
          onResponseError: () => forwarded.push("error"),
        },
      );
    });

    const observation = scope.snapshot();
    expect(forwarded).toEqual(["started", "headers", "complete"]);
    expect(observation).toEqual({
      schemaVersion: 1,
      recordKind: "vnext-pi-host-http-transport-observation",
      requestStartedCount: 1,
      responseHeadersCount: 1,
      responseCompleteCount: 1,
      requestErrorCount: 0,
      recordContentSha256: observation.recordContentSha256,
    });
    expect(observation.recordContentSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(observation)).not.toContain(secret);
  });

  it("isolates concurrent scopes and counts response errors exactly once", async () => {
    const dispatch: Dispatcher.Dispatch = (_options, handler) => {
      const controller = {} as Dispatcher.DispatchController;
      handler.onRequestStart?.(controller, null);
      handler.onResponseError?.(controller, new Error("secret provider URL"));
      return true;
    };
    const observed = observeVNextPiHostHttpDispatchV1(dispatch);
    const first = createVNextPiHostHttpTransportObservationScopeV1();
    const second = createVNextPiHostHttpTransportObservationScopeV1();

    await Promise.all([
      first.run(async () => {
        observed({ path: "/one", method: "GET" }, {});
        observed({ path: "/two", method: "GET" }, {});
      }),
      second.run(async () => {
        observed({ path: "/three", method: "GET" }, {});
      }),
    ]);

    expect(first.snapshot()).toMatchObject({
      requestStartedCount: 2,
      responseHeadersCount: 0,
      responseCompleteCount: 0,
      requestErrorCount: 2,
    });
    expect(second.snapshot()).toMatchObject({
      requestStartedCount: 1,
      responseHeadersCount: 0,
      responseCompleteCount: 0,
      requestErrorCount: 1,
    });
  });

  it("strictly validates observation shape and its content hash", () => {
    const observation =
      createVNextPiHostHttpTransportObservationScopeV1().snapshot();

    const parsed = parseVNextPiHostHttpTransportObservationV1({
      ...observation,
    });
    expect(parsed).toEqual(observation);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(() =>
      parseVNextPiHostHttpTransportObservationV1({
        ...observation,
        unexpected: "not allowed",
      }),
    ).toThrow("observation is invalid");
    expect(() =>
      parseVNextPiHostHttpTransportObservationV1({
        ...observation,
        requestStartedCount: 1,
      }),
    ).toThrow("observation hash is invalid");
  });
});
