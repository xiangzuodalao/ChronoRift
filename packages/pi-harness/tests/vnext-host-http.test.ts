import { describe, expect, it, vi } from "vitest";

import {
  createVNextPiHostHttpTransportConfigurer,
  hasVNextPiHostHttpProxy,
} from "../src/index.js";

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
});
