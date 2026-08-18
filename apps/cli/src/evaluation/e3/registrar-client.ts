import { X509Certificate, createHash, timingSafeEqual } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { checkServerIdentity, type PeerCertificate } from "node:tls";

import { z } from "zod";

import type { JsonValue } from "@chronorift/domain";
import { canonicalJson } from "@chronorift/json-artifacts";

import {
  assignmentIdV1,
  campaignRegistrationLeafBytesV1,
  campaignIdV1,
  canonicalContentHashV1,
  closurePublicationLeafBytesV1,
  ed25519KeyIdV1,
  eventIdV1,
  revisionIdV1,
  verifyConsistencyProofV1,
  verifyCanonicalJsonSignatureV1,
  verifyInclusionProofV1,
} from "./canonical.js";
import {
  E3_SCHEMA_IDS_V1,
  E3AppendReceiptV1Schema,
  E3CampaignManifestV1Schema,
  E3CampaignRegistrationProofV1Schema,
  E3ClosedEvidenceSnapshotV1Schema,
  E3JournalEntryV1Schema,
  E3JournalV1Schema,
  E3LateAppendRequestV1Schema,
  E3LateAppendResultV1Schema,
  E3PrimaryClosureV1Schema,
  E3PublicPendingStatusV1Schema,
  E3PublicationProofV1Schema,
  E3RegistrarTrustRootV1Schema,
  E3RevisionEnvelopeV1Schema,
  type E3RegistrarServiceBindingV1,
  type E3RegistrarTrustRootV1,
  type E3RevisionJournalCheckpointV1,
} from "./contracts.js";
import {
  E3RegistrarError,
  type E3CampaignRegistrationV1,
  type E3RegistrarErrorCodeV1,
  type E3RegistrarPortV1,
} from "./registrar-port.js";
import {
  eventHashV1,
  revisionHashV1,
  validatePrimaryAppendReceiptsV1,
} from "./projector.js";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_JSON_DEPTH = 40;
const MAX_JSON_VALUES = 100_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const PROXY_KEYS = new Set([
  "all_proxy",
  "http_proxy",
  "https_proxy",
  "npm_config_proxy",
  "npm_config_https_proxy",
]);

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const RegistrationSchema = z
  .object({
    campaignId: DigestSchema,
    assignmentId: DigestSchema,
    receipt: E3AppendReceiptV1Schema,
    registrationProof: E3CampaignRegistrationProofV1Schema,
  })
  .strict();
const ErrorResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    errorCode: z.enum([
      "closed",
      "conflict",
      "invalid",
      "unauthorized",
      "unavailable",
      "unsupported",
    ]),
    requestId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
  })
  .strict();

class E3IndeterminateRegistrarResponseError extends E3RegistrarError {}

interface E3UnresolvedMutationV1 {
  readonly latchKind: "registration" | "assignment";
  readonly campaignId: string;
  readonly assignmentId: string;
  readonly ordinal: number;
  readonly requestBytes: string;
  inFlight: boolean;
}

export interface E3StrictJsonTransportV1 {
  request(input: {
    readonly method: "GET" | "POST" | "PUT";
    readonly path: string;
    readonly body?: JsonValue;
    readonly actorCapability?: string;
  }): Promise<unknown>;
}

/**
 * Canonical representation of every field that determines the HTTPS request
 * emitted by the strict transport. It is intentionally in-memory only because
 * it includes the opaque actor capability.
 */
export const canonicalRegistrarTransportRequestBytesV1 = (
  request: Parameters<E3StrictJsonTransportV1["request"]>[0],
): Buffer =>
  Buffer.from(
    canonicalJson({
      actorCapability: request.actorCapability ?? null,
      body: request.body ?? null,
      method: request.method,
      path: request.path,
    }),
    "utf8",
  );

export interface E3PinnedHttpsTransportOptionsV1 {
  readonly service: E3RegistrarServiceBindingV1;
  readonly environment?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

const assertNoProxyEnvironment = (environment: NodeJS.ProcessEnv): void => {
  for (const [key, value] of Object.entries(environment)) {
    if (
      value !== undefined &&
      value !== "" &&
      PROXY_KEYS.has(key.toLowerCase())
    ) {
      throw new E3RegistrarError(
        "invalid",
        `proxy environment ${key} is forbidden for the pinned registrar client`,
      );
    }
  }
};

const spkiSha256 = (certificate: PeerCertificate): string => {
  if (certificate.raw === undefined) {
    throw new Error("TLS peer did not expose its certificate bytes");
  }
  const publicKey = new X509Certificate(certificate.raw).publicKey.export({
    type: "spki",
    format: "der",
  });
  return createHash("sha256").update(publicKey).digest("hex");
};

const equalDigest = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return (
    leftBytes.length === 32 &&
    rightBytes.length === 32 &&
    timingSafeEqual(leftBytes, rightBytes)
  );
};

const keyValidAt = (
  key: { readonly validFrom: string; readonly validUntil: string },
  timestamp: string,
): boolean => {
  const instant = Date.parse(timestamp);
  return (
    Number.isFinite(instant) &&
    instant >= Date.parse(key.validFrom) &&
    instant < Date.parse(key.validUntil)
  );
};

const assertNoDuplicateObjectKeys = (text: string): void => {
  let index = 0;
  let valueCount = 0;
  const fail = (message: string): never => {
    throw new E3RegistrarError("invalid", `registrar JSON ${message}`);
  };
  const whitespace = () => {
    while (/\s/u.test(text[index] ?? "")) index += 1;
  };
  const stringToken = (): string => {
    const start = index++;
    while (index < text.length) {
      if (text[index] === "\\") {
        index += 2;
        continue;
      }
      if (text[index++] === '"') {
        try {
          return JSON.parse(text.slice(start, index)) as string;
        } catch {
          fail("contains an invalid string");
        }
      }
    }
    return fail("contains an unterminated string");
  };
  const primitive = () => {
    const start = index;
    while (index < text.length && !/[\s,\]}]/u.test(text[index] ?? "")) {
      index += 1;
    }
    if (start === index) fail("contains an invalid value");
  };
  const value = (depth = 0): void => {
    valueCount += 1;
    if (depth > MAX_JSON_DEPTH || valueCount > MAX_JSON_VALUES) {
      fail("exceeds the v1 structural bounds");
    }
    whitespace();
    if (text[index] === "{") {
      index += 1;
      whitespace();
      const keys = new Set<string>();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      while (index < text.length) {
        if (text[index] !== '"') fail("contains an invalid object key");
        const key = stringToken();
        if (keys.has(key)) fail(`contains duplicate key ${key}`);
        keys.add(key);
        whitespace();
        if (text[index++] !== ":") fail("contains an invalid object separator");
        value(depth + 1);
        whitespace();
        if (text[index] === "}") {
          index += 1;
          return;
        }
        if (text[index++] !== ",") fail("contains an invalid object delimiter");
        whitespace();
      }
      fail("contains an unterminated object");
    }
    if (text[index] === "[") {
      index += 1;
      whitespace();
      if (text[index] === "]") {
        index += 1;
        return;
      }
      while (index < text.length) {
        value(depth + 1);
        whitespace();
        if (text[index] === "]") {
          index += 1;
          return;
        }
        if (text[index++] !== ",") fail("contains an invalid array delimiter");
        whitespace();
      }
      fail("contains an unterminated array");
    }
    if (text[index] === '"') {
      stringToken();
      return;
    }
    primitive();
  };
  value();
  whitespace();
  if (index !== text.length) fail("contains trailing data");
};

export const parseStrictRegistrarJsonV1 = (bytes: Buffer): unknown => {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    throw new E3RegistrarError("invalid", "registrar response contains a BOM");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new E3RegistrarError("invalid", "registrar response is not UTF-8", {
      cause: error,
    });
  }
  if (text.startsWith("\uFEFF")) {
    throw new E3RegistrarError("invalid", "registrar response contains a BOM");
  }
  assertNoDuplicateObjectKeys(text);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new E3RegistrarError("invalid", "registrar response is not JSON", {
      cause: error,
    });
  }
};

const errorCodeForStatus = (status: number): E3RegistrarErrorCodeV1 => {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 409) return "conflict";
  if (status === 410) return "closed";
  if (status === 422) return "invalid";
  if (status === 426) return "unsupported";
  return "unavailable";
};

export const createPinnedHttpsTransportV1 = (
  options: E3PinnedHttpsTransportOptionsV1,
): E3StrictJsonTransportV1 => {
  const environment = options.environment ?? process.env;
  assertNoProxyEnvironment(environment);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new E3RegistrarError("invalid", "HTTPS timeout is outside v1 bounds");
  }
  const basePath = options.service.basePath.replace(/\/$/u, "");
  return {
    request: async (input) => {
      const body =
        input.body === undefined
          ? undefined
          : Buffer.from(canonicalJson(input.body), "utf8");
      return await new Promise<unknown>((resolve, reject) => {
        const request = httpsRequest(
          {
            protocol: "https:",
            hostname: options.service.hostname,
            servername: options.service.hostname,
            port: options.service.port,
            method: input.method,
            path: `${basePath}${input.path}`,
            ca: options.service.caCertificatePem,
            rejectUnauthorized: true,
            agent: false,
            headers: {
              accept: "application/json",
              "accept-encoding": "identity",
              ...(body === undefined
                ? {}
                : {
                    "content-type": "application/json",
                    "content-length": String(body.byteLength),
                  }),
              ...(input.actorCapability === undefined
                ? {}
                : { authorization: `E3-Capability ${input.actorCapability}` }),
            },
            checkServerIdentity: (hostname, certificate) => {
              const hostnameError = checkServerIdentity(hostname, certificate);
              if (hostnameError !== undefined) return hostnameError;
              try {
                const actual = spkiSha256(certificate);
                return equalDigest(actual, options.service.tlsSpkiSha256)
                  ? undefined
                  : new Error("E3.1 registrar TLS SPKI pin mismatch");
              } catch (error) {
                return error instanceof Error
                  ? error
                  : new Error(
                      "E3.1 registrar TLS certificate inspection failed",
                    );
              }
            },
          },
          (response) => {
            const status = response.statusCode ?? 0;
            const contentType = response.headers["content-type"];
            const contentEncoding = response.headers["content-encoding"];
            if (
              typeof contentType !== "string" ||
              !/^application\/json(?:; charset=utf-8)?$/iu.test(contentType) ||
              (contentEncoding !== undefined && contentEncoding !== "identity")
            ) {
              response.resume();
              reject(
                new E3IndeterminateRegistrarResponseError(
                  "invalid",
                  "registrar response has an unsupported representation",
                ),
              );
              return;
            }
            const chunks: Buffer[] = [];
            let byteLength = 0;
            response.on("data", (chunk: Buffer) => {
              byteLength += chunk.byteLength;
              if (byteLength > MAX_RESPONSE_BYTES) {
                response.destroy(
                  new E3IndeterminateRegistrarResponseError(
                    "invalid",
                    "registrar response exceeds the v1 byte bound",
                  ),
                );
                return;
              }
              chunks.push(chunk);
            });
            response.once("error", reject);
            response.once("end", () => {
              let value: unknown;
              try {
                value = parseStrictRegistrarJsonV1(Buffer.concat(chunks));
              } catch (error) {
                reject(
                  new E3IndeterminateRegistrarResponseError(
                    "invalid",
                    "registrar response validation failed",
                    error instanceof Error ? { cause: error } : undefined,
                  ),
                );
                return;
              }
              if (status < 200 || status >= 300) {
                const parsed = ErrorResponseSchema.safeParse(value);
                if (!parsed.success) {
                  reject(
                    new E3IndeterminateRegistrarResponseError(
                      errorCodeForStatus(status),
                      `HTTP ${String(status)} did not contain a valid rejection envelope`,
                    ),
                  );
                  return;
                }
                reject(
                  new E3RegistrarError(
                    parsed.data.errorCode,
                    `request ${parsed.data.requestId} was rejected`,
                  ),
                );
                return;
              }
              resolve(value);
            });
          },
        );
        request.setTimeout(timeoutMs, () => {
          request.destroy(
            new E3RegistrarError("unavailable", "registrar request timed out"),
          );
        });
        request.once("error", (error) => {
          reject(
            error instanceof E3RegistrarError
              ? error
              : new E3RegistrarError(
                  "unavailable",
                  "registrar request failed",
                  {
                    cause: error,
                  },
                ),
          );
        });
        if (body !== undefined) request.write(body);
        request.end();
      });
    },
  };
};

const encoded = (value: string): string => encodeURIComponent(value);

export class E3RegistrarClientV1 implements E3RegistrarPortV1 {
  #unresolvedRegistration: E3UnresolvedMutationV1 | undefined;
  readonly #unresolvedMutations = new Map<string, E3UnresolvedMutationV1>();

  public constructor(
    private readonly namespace: string,
    private readonly transport: E3StrictJsonTransportV1,
    private readonly service: E3RegistrarServiceBindingV1,
  ) {}

  readonly #campaignPath = (campaignId: string): string =>
    `/namespaces/${encoded(this.namespace)}/campaigns/${encoded(campaignId)}`;

  async #requestWithIdenticalRetry(
    input: Parameters<E3StrictJsonTransportV1["request"]>[0],
  ): Promise<unknown> {
    const fixedInput =
      input.body === undefined
        ? input
        : {
            ...input,
            body: JSON.parse(canonicalJson(input.body)) as JsonValue,
          };
    try {
      return await this.transport.request(fixedInput);
    } catch (error) {
      if (
        !(error instanceof E3RegistrarError) ||
        error.code !== "unavailable"
      ) {
        throw error;
      }
      return await this.transport.request(fixedInput);
    }
  }

  #mutationKey(campaignId: string, assignmentId: string): string {
    return `${campaignId}:${assignmentId}`;
  }

  #canonicalRequestBytes(
    request: Parameters<E3StrictJsonTransportV1["request"]>[0],
  ): string {
    return canonicalRegistrarTransportRequestBytesV1(request).toString(
      "base64",
    );
  }

  #acquireRegistration(input: {
    readonly campaignId: string;
    readonly assignmentId: string;
    readonly request: Parameters<E3StrictJsonTransportV1["request"]>[0];
  }): E3UnresolvedMutationV1 {
    const requestBytes = this.#canonicalRequestBytes(input.request);
    const unresolved = this.#unresolvedRegistration;
    if (unresolved !== undefined) {
      if (unresolved.requestBytes !== requestBytes) {
        throw new E3RegistrarError(
          "conflict",
          "campaign registration remains unresolved; a changed manifest is forbidden until the byte-identical request receives a receipt or definitive rejection",
        );
      }
      if (unresolved.inFlight) {
        throw new E3RegistrarError(
          "unavailable",
          "the byte-identical unresolved campaign registration is already in flight",
        );
      }
      unresolved.inFlight = true;
      return unresolved;
    }
    if (this.#unresolvedMutations.size > 0) {
      throw new E3RegistrarError(
        "conflict",
        "an append remains unresolved; campaign registration cannot advance",
      );
    }
    const acquired: E3UnresolvedMutationV1 = {
      latchKind: "registration",
      campaignId: input.campaignId,
      assignmentId: input.assignmentId,
      ordinal: 1,
      requestBytes,
      inFlight: true,
    };
    this.#unresolvedRegistration = acquired;
    return acquired;
  }

  #acquireMutation(input: {
    readonly campaignId: string;
    readonly assignmentId: string;
    readonly ordinal: number;
    readonly request: Parameters<E3StrictJsonTransportV1["request"]>[0];
  }): E3UnresolvedMutationV1 {
    if (this.#unresolvedRegistration !== undefined) {
      throw new E3RegistrarError(
        "conflict",
        "campaign registration remains unresolved; append is forbidden until the byte-identical registration request receives a receipt or definitive rejection",
      );
    }
    const key = this.#mutationKey(input.campaignId, input.assignmentId);
    const requestBytes = this.#canonicalRequestBytes(input.request);
    const unresolved = this.#unresolvedMutations.get(key);
    if (unresolved !== undefined) {
      if (unresolved.requestBytes !== requestBytes) {
        const requestClass =
          input.ordinal > unresolved.ordinal
            ? "a higher-ordinal request"
            : "a different request";
        throw new E3RegistrarError(
          "conflict",
          `an append remains unresolved for this campaign assignment; ${requestClass} is forbidden until the byte-identical request receives a receipt or definitive rejection`,
        );
      }
      if (unresolved.inFlight) {
        throw new E3RegistrarError(
          "unavailable",
          "the byte-identical unresolved append is already in flight",
        );
      }
      unresolved.inFlight = true;
      return unresolved;
    }
    const acquired: E3UnresolvedMutationV1 = {
      latchKind: "assignment",
      campaignId: input.campaignId,
      assignmentId: input.assignmentId,
      ordinal: input.ordinal,
      requestBytes,
      inFlight: true,
    };
    this.#unresolvedMutations.set(key, acquired);
    return acquired;
  }

  #releaseMutationForRetry(mutation: E3UnresolvedMutationV1): void {
    if (mutation.latchKind === "registration") {
      if (this.#unresolvedRegistration === mutation) {
        mutation.inFlight = false;
      }
      return;
    }
    const key = this.#mutationKey(mutation.campaignId, mutation.assignmentId);
    if (this.#unresolvedMutations.get(key) === mutation) {
      mutation.inFlight = false;
    }
  }

  #resolveMutation(mutation: E3UnresolvedMutationV1): void {
    if (mutation.latchKind === "registration") {
      if (this.#unresolvedRegistration === mutation) {
        this.#unresolvedRegistration = undefined;
      }
      return;
    }
    const key = this.#mutationKey(mutation.campaignId, mutation.assignmentId);
    if (this.#unresolvedMutations.get(key) === mutation) {
      this.#unresolvedMutations.delete(key);
    }
  }

  async #requestMutation(
    mutation: E3UnresolvedMutationV1,
    request: Parameters<E3StrictJsonTransportV1["request"]>[0],
  ): Promise<unknown> {
    try {
      return await this.#requestWithIdenticalRetry(request);
    } catch (error) {
      if (
        error instanceof E3RegistrarError &&
        error.code !== "unavailable" &&
        !(error instanceof E3IndeterminateRegistrarResponseError)
      ) {
        this.#resolveMutation(mutation);
      } else {
        this.#releaseMutationForRetry(mutation);
      }
      throw error;
    }
  }

  public async registerCampaign(
    input: Parameters<E3RegistrarPortV1["registerCampaign"]>[0],
  ): Promise<E3CampaignRegistrationV1> {
    const manifest = E3CampaignManifestV1Schema.parse(input.manifest);
    const campaignId = campaignIdV1(manifest);
    const assignment = manifest.assignments[0];
    const assignmentId = assignmentIdV1({
      campaignId,
      slotOrdinal: assignment.slotOrdinal,
      assignmentCommitment: assignment.assignmentCommitment,
    });
    const request = {
      method: "PUT" as const,
      path: this.#campaignPath(campaignId),
      body: manifest as JsonValue,
      actorCapability: input.actorCapability,
    };
    const mutation = this.#acquireRegistration({
      campaignId,
      assignmentId,
      request,
    });
    const response = await this.#requestMutation(mutation, request);
    try {
      const registration = RegistrationSchema.parse(response);
      if (
        registration.campaignId !== campaignId ||
        registration.assignmentId !== assignmentId ||
        registration.receipt.campaignId !== campaignId ||
        registration.receipt.assignmentId !== assignmentId ||
        registration.registrationProof.campaignId !== campaignId
      ) {
        throw new E3RegistrarError(
          "invalid",
          "campaign registration response does not bind the canonical manifest",
        );
      }
      this.#verifyAppendReceipt(registration.receipt);
      this.#verifyCheckpoint(registration.registrationProof.checkpoint);
      if (
        registration.receipt.ordinal !== 1 ||
        registration.receipt.eventHash !== registration.receipt.journalHead ||
        Date.parse(registration.receipt.committedAt) >
          Date.parse(registration.registrationProof.checkpoint.issuedAt) ||
        Date.parse(registration.registrationProof.checkpoint.issuedAt) >=
          Date.parse(manifest.deadline) ||
        !verifyInclusionProofV1({
          leafBytes: campaignRegistrationLeafBytesV1({
            campaignId,
            deadline: manifest.deadline,
          }),
          leafIndex: registration.registrationProof.inclusionProof.leafIndex,
          treeSize: registration.registrationProof.inclusionProof.treeSize,
          auditPath: registration.registrationProof.inclusionProof.auditPath,
          expectedRoot: registration.registrationProof.checkpoint.rootHash,
        })
      ) {
        throw new E3RegistrarError(
          "invalid",
          "campaign registration receipt or transparency inclusion is invalid",
        );
      }
      this.#resolveMutation(mutation);
      return registration;
    } catch (error) {
      this.#releaseMutationForRetry(mutation);
      throw error;
    }
  }

  public async appendEvent(
    input: Parameters<E3RegistrarPortV1["appendEvent"]>[0],
  ) {
    const entry = E3JournalEntryV1Schema.parse(input.entry);
    const payloadHash = canonicalContentHashV1(entry.payload as JsonValue);
    const derivedEventId = eventIdV1({
      campaignId: entry.event.campaignId,
      assignmentId: entry.event.assignmentId,
      ordinal: entry.event.ordinal,
      previousHash: entry.event.previousHash ?? "",
      eventKind: entry.event.eventKind,
      payloadHash,
    });
    if (
      entry.event.campaignId !== input.campaignId ||
      entry.event.payloadHash !== payloadHash ||
      entry.event.eventId !== derivedEventId
    ) {
      throw new E3RegistrarError(
        "invalid",
        "submitted event identity or payload binding is not canonical",
      );
    }
    const request = {
      method: "POST" as const,
      path: `${this.#campaignPath(input.campaignId)}/events:compare-and-append`,
      body: entry as unknown as JsonValue,
      actorCapability: input.actorCapability,
    };
    const mutation = this.#acquireMutation({
      campaignId: input.campaignId,
      assignmentId: entry.event.assignmentId,
      ordinal: entry.event.ordinal,
      request,
    });
    const response = await this.#requestMutation(mutation, request);
    try {
      const receipt = E3AppendReceiptV1Schema.parse(response);
      const eventHash = eventHashV1(entry);
      if (
        receipt.campaignId !== input.campaignId ||
        receipt.assignmentId !== entry.event.assignmentId ||
        receipt.eventId !== entry.event.eventId ||
        receipt.eventHash !== eventHash ||
        receipt.journalHead !== eventHash ||
        receipt.ordinal !== entry.event.ordinal
      ) {
        throw new E3RegistrarError(
          "invalid",
          "append receipt does not bind the submitted event",
        );
      }
      this.#verifyAppendReceipt(receipt);
      this.#resolveMutation(mutation);
      return receipt;
    } catch (error) {
      this.#releaseMutationForRetry(mutation);
      throw error;
    }
  }

  public async readJournal(
    input: Parameters<E3RegistrarPortV1["readJournal"]>[0],
  ) {
    if (!Number.isSafeInteger(input.afterOrdinal) || input.afterOrdinal < 0) {
      throw new E3RegistrarError(
        "invalid",
        "afterOrdinal is outside v1 bounds",
      );
    }
    const journal = E3JournalV1Schema.parse(
      await this.#requestWithIdenticalRetry({
        method: "GET",
        path: `${this.#campaignPath(input.campaignId)}/journal?afterOrdinal=${String(input.afterOrdinal)}`,
      }),
    );
    if (journal.campaignId !== input.campaignId) {
      throw new E3RegistrarError(
        "invalid",
        "journal belongs to another campaign",
      );
    }
    return journal;
  }

  public async readPrimaryClosure(
    input: Parameters<E3RegistrarPortV1["readPrimaryClosure"]>[0],
  ) {
    const value = await this.transport.request({
      method: "GET",
      path: `${this.#campaignPath(input.campaignId)}/primary-closure`,
    });
    if (value === null) return null;
    const closure = E3PrimaryClosureV1Schema.parse(value);
    if (closure.campaignId !== input.campaignId) {
      throw new E3RegistrarError(
        "invalid",
        "closure belongs to another campaign",
      );
    }
    this.#verifyPrimaryClosure(closure);
    return closure;
  }

  /**
   * Reads signed registrar status for public liveness observation only. A
   * pending-status response does not satisfy the publication-proof gate.
   */
  public async readPendingStatus(
    input: Parameters<E3RegistrarPortV1["readPendingStatus"]>[0],
  ) {
    const status = E3PublicPendingStatusV1Schema.parse(
      await this.transport.request({
        method: "GET",
        path: `${this.#campaignPath(input.campaignId)}/pending-status`,
      }),
    );
    if (status.campaignId !== input.campaignId) {
      throw new E3RegistrarError(
        "invalid",
        "public pending status belongs to another campaign",
      );
    }
    this.#verifyPendingStatus(status);
    return status;
  }

  public async appendRevision(
    input: Parameters<E3RegistrarPortV1["appendRevision"]>[0],
  ) {
    const lateEntry = E3JournalEntryV1Schema.parse(input.lateEntry);
    const latePayloadHash = canonicalContentHashV1(
      lateEntry.payload as JsonValue,
    );
    const derivedLateEventId = eventIdV1({
      campaignId: lateEntry.event.campaignId,
      assignmentId: lateEntry.event.assignmentId,
      ordinal: lateEntry.event.ordinal,
      previousHash: lateEntry.event.previousHash ?? "",
      eventKind: lateEntry.event.eventKind,
      payloadHash: latePayloadHash,
    });
    if (
      lateEntry.event.campaignId !== input.campaignId ||
      lateEntry.event.payloadHash !== latePayloadHash ||
      lateEntry.event.eventId !== derivedLateEventId
    ) {
      throw new E3RegistrarError(
        "invalid",
        "submitted late-event identity or payload binding is not canonical",
      );
    }
    const request = E3LateAppendRequestV1Schema.parse({
      schemaId: E3_SCHEMA_IDS_V1.lateAppendRequest,
      schemaVersion: 1,
      campaignId: input.campaignId,
      lateEntry,
    });
    const transportRequest = {
      method: "POST" as const,
      path: `${this.#campaignPath(input.campaignId)}/late-events:compare-and-append`,
      body: request as unknown as JsonValue,
      actorCapability: input.actorCapability,
    };
    const mutation = this.#acquireMutation({
      campaignId: input.campaignId,
      assignmentId: lateEntry.event.assignmentId,
      ordinal: lateEntry.event.ordinal,
      request: transportRequest,
    });
    const response = await this.#requestMutation(mutation, transportRequest);
    let result: z.infer<typeof E3LateAppendResultV1Schema>;
    try {
      result = E3LateAppendResultV1Schema.parse(response);
      const revision = E3RevisionEnvelopeV1Schema.parse(result.revision);
      const derivedRevisionId = revisionIdV1({
        campaignId: revision.campaignId,
        primaryClosureHash: revision.primaryClosureHash,
        revisionOrdinal: revision.revisionOrdinal,
        previousRevisionHash: revision.previousRevisionHash,
        lateEventId: derivedLateEventId,
      });
      if (
        result.campaignId !== input.campaignId ||
        canonicalJson(revision.lateEntry as unknown as JsonValue) !==
          canonicalJson(lateEntry as unknown as JsonValue) ||
        revision.revisionId !== derivedRevisionId
      ) {
        throw new E3RegistrarError(
          "invalid",
          "returned revision does not preserve and bind the submitted late event",
        );
      }
      this.#verifyRevisionEnvelope(revision);
      const receipt = result.receipt;
      const revisionHash = revisionHashV1(revision);
      if (
        receipt.campaignId !== input.campaignId ||
        receipt.assignmentId !== revision.lateEntry.event.assignmentId ||
        receipt.eventId !== revision.revisionId ||
        receipt.eventHash !== revisionHash ||
        receipt.journalHead !== revisionHash ||
        receipt.ordinal !== revision.revisionOrdinal ||
        Date.parse(receipt.committedAt) < Date.parse(revision.receivedAt)
      ) {
        throw new E3RegistrarError(
          "invalid",
          "revision receipt does not bind the registrar-created revision",
        );
      }
      this.#verifyAppendReceipt(receipt);
      const primaryClosure = await this.readPrimaryClosure({
        campaignId: input.campaignId,
      });
      if (
        primaryClosure === null ||
        primaryClosure.closureHash !== revision.primaryClosureHash ||
        Date.parse(receipt.committedAt) < Date.parse(primaryClosure.closedAt)
      ) {
        throw new E3RegistrarError(
          "invalid",
          "late append receipt does not occur after its signed primary closure",
        );
      }
      this.#resolveMutation(mutation);
      return result;
    } catch (error) {
      this.#releaseMutationForRetry(mutation);
      throw error;
    }
  }

  public async readPublicationProof(
    input: Parameters<E3RegistrarPortV1["readPublicationProof"]>[0],
  ) {
    const proof = E3PublicationProofV1Schema.parse(
      await this.transport.request({
        method: "GET",
        path: `${this.#campaignPath(input.campaignId)}/publication-proof?closureHash=${encoded(input.closureHash)}`,
      }),
    );
    if (
      proof.campaignId !== input.campaignId ||
      proof.closureHash !== input.closureHash
    ) {
      throw new E3RegistrarError(
        "invalid",
        "publication proof does not bind the requested closure",
      );
    }
    this.#verifyPublicationProof(proof);
    return proof;
  }

  public async readClosedEvidence(
    input: Parameters<E3RegistrarPortV1["readClosedEvidence"]>[0],
  ) {
    const value = await this.transport.request({
      method: "GET",
      path: `${this.#campaignPath(input.campaignId)}/closed-evidence`,
    });
    if (value === null) return null;
    const snapshot = E3ClosedEvidenceSnapshotV1Schema.parse(value);
    if (
      snapshot.campaignId !== input.campaignId ||
      snapshot.journal.campaignId !== input.campaignId ||
      snapshot.primaryClosure.campaignId !== input.campaignId ||
      snapshot.publicationProof.campaignId !== input.campaignId ||
      snapshot.publicationProof.closureHash !==
        snapshot.primaryClosure.closureHash ||
      snapshot.journal.assignmentId !== snapshot.assignmentId
    ) {
      throw new E3RegistrarError(
        "invalid",
        "closed evidence snapshot does not bind the requested campaign",
      );
    }
    this.#verifyPrimaryClosure(snapshot.primaryClosure);
    this.#verifyPublicationProof(snapshot.publicationProof);
    this.#verifyRevisionJournalCheckpoint(snapshot.revisionJournalCheckpoint);
    let primaryReceiptProjection: ReturnType<
      typeof validatePrimaryAppendReceiptsV1
    >;
    try {
      primaryReceiptProjection = validatePrimaryAppendReceiptsV1({
        journal: snapshot.journal,
        appendReceipts: snapshot.appendReceipts,
        closure: snapshot.primaryClosure,
      });
    } catch (error) {
      throw new E3RegistrarError(
        "invalid",
        "closed evidence violates the primary receipt or time boundary",
        { cause: error },
      );
    }
    if (
      (primaryReceiptProjection.firstActorCommittedAt !== null &&
        Date.parse(snapshot.publicationProof.registrationCheckpoint.issuedAt) >
          Date.parse(primaryReceiptProjection.firstActorCommittedAt)) ||
      Date.parse(snapshot.publicationProof.closureCheckpoint.issuedAt) <
        Date.parse(snapshot.primaryClosure.closedAt) ||
      Date.parse(snapshot.publicationProof.closureCheckpoint.issuedAt) <
        Date.parse(primaryReceiptProjection.closureCommittedAt)
    ) {
      throw new E3RegistrarError(
        "invalid",
        "closed evidence transparency checkpoints do not bracket execution and closure",
      );
    }
    let commitSequence = 0;
    let committedAt = -Infinity;
    for (const [index, entry] of snapshot.journal.events.entries()) {
      const receipt = snapshot.appendReceipts[index]!;
      const eventHash = eventHashV1(entry);
      if (
        receipt.campaignId !== snapshot.campaignId ||
        receipt.assignmentId !== snapshot.assignmentId ||
        receipt.eventId !== entry.event.eventId ||
        receipt.eventHash !== eventHash ||
        receipt.journalHead !== eventHash ||
        receipt.ordinal !== entry.event.ordinal ||
        receipt.commitSequence <= commitSequence ||
        Date.parse(receipt.committedAt) < committedAt
      ) {
        throw new E3RegistrarError(
          "invalid",
          "closed evidence contains an invalid primary append receipt chain",
        );
      }
      this.#verifyAppendReceipt(receipt);
      commitSequence = receipt.commitSequence;
      committedAt = Date.parse(receipt.committedAt);
    }
    for (const [index, revision] of snapshot.revisions.entries()) {
      const receipt = snapshot.revisionReceipts[index]!;
      const revisionHash = revisionHashV1(revision);
      this.#verifyRevisionEnvelope(revision);
      if (
        receipt.campaignId !== snapshot.campaignId ||
        receipt.assignmentId !== snapshot.assignmentId ||
        receipt.eventId !== revision.revisionId ||
        receipt.eventHash !== revisionHash ||
        receipt.journalHead !== revisionHash ||
        receipt.ordinal !== revision.revisionOrdinal ||
        receipt.commitSequence <= commitSequence ||
        Date.parse(receipt.committedAt) < committedAt ||
        Date.parse(receipt.committedAt) <
          Date.parse(snapshot.primaryClosure.closedAt) ||
        Date.parse(receipt.committedAt) < Date.parse(revision.receivedAt)
      ) {
        throw new E3RegistrarError(
          "invalid",
          "closed evidence contains an invalid revision receipt chain",
        );
      }
      this.#verifyAppendReceipt(receipt);
      commitSequence = receipt.commitSequence;
      committedAt = Date.parse(receipt.committedAt);
    }
    const expectedRevisionHead =
      snapshot.revisions.length === 0
        ? null
        : revisionHashV1(snapshot.revisions.at(-1)!);
    if (
      snapshot.revisionJournalCheckpoint.campaignId !== snapshot.campaignId ||
      snapshot.revisionJournalCheckpoint.primaryClosureHash !==
        snapshot.primaryClosure.closureHash ||
      snapshot.revisionJournalCheckpoint.revisionHead !==
        expectedRevisionHead ||
      snapshot.revisionJournalCheckpoint.revisionCount !==
        snapshot.revisions.length ||
      snapshot.revisionJournalCheckpoint.latestKnownEventCount !==
        snapshot.journal.eventCount + snapshot.revisions.length ||
      snapshot.revisionJournalCheckpoint.commitSequence !== commitSequence ||
      Date.parse(snapshot.revisionJournalCheckpoint.asOf) < committedAt ||
      Date.parse(snapshot.revisionJournalCheckpoint.asOf) <
        Date.parse(snapshot.primaryClosure.closedAt)
    ) {
      throw new E3RegistrarError(
        "invalid",
        "closed evidence revision checkpoint does not bind the retained chains",
      );
    }
    return snapshot;
  }

  #verifyAppendReceipt(receipt: z.infer<typeof E3AppendReceiptV1Schema>): void {
    if (
      receipt.registrarServiceId !== this.service.serviceId ||
      receipt.receiptKeyId !== this.service.receiptKey.keyId ||
      !keyValidAt(this.service.receiptKey, receipt.committedAt)
    ) {
      throw new E3RegistrarError(
        "unauthorized",
        "append receipt is not bound to the pinned registrar role key",
      );
    }
    const { signature, ...basis } = receipt;
    if (
      !verifyCanonicalJsonSignatureV1({
        publicKey: this.service.receiptKey.publicKeyPem,
        domain: "chronorift-e3-append-receipt-v1",
        schemaId: receipt.schemaId,
        version: receipt.schemaVersion,
        value: basis,
        signature,
      })
    ) {
      throw new E3RegistrarError(
        "unauthorized",
        "append receipt signature is invalid",
      );
    }
  }

  #verifyRevisionEnvelope(
    revision: z.infer<typeof E3RevisionEnvelopeV1Schema>,
  ): void {
    if (
      revision.registrarKeyId !== this.service.receiptKey.keyId ||
      !keyValidAt(this.service.receiptKey, revision.receivedAt)
    ) {
      throw new E3RegistrarError(
        "unauthorized",
        "revision envelope does not use the current pinned receipt key",
      );
    }
    const { signature, ...basis } = revision;
    if (
      !verifyCanonicalJsonSignatureV1({
        publicKey: this.service.receiptKey.publicKeyPem,
        domain: "chronorift-e3-revision-envelope-v1",
        schemaId: revision.schemaId,
        version: revision.schemaVersion,
        value: basis as unknown as JsonValue,
        signature,
      })
    ) {
      throw new E3RegistrarError(
        "unauthorized",
        "revision envelope signature is invalid",
      );
    }
  }

  #verifyRevisionJournalCheckpoint(
    checkpoint: E3RevisionJournalCheckpointV1,
  ): void {
    if (
      checkpoint.registrarServiceId !== this.service.serviceId ||
      checkpoint.closureKeyId !== this.service.closureKey.keyId ||
      !keyValidAt(this.service.closureKey, checkpoint.asOf)
    ) {
      throw new E3RegistrarError(
        "unauthorized",
        "revision checkpoint does not use the pinned registrar closure key",
      );
    }
    const { signature, ...basis } = checkpoint;
    if (
      !verifyCanonicalJsonSignatureV1({
        publicKey: this.service.closureKey.publicKeyPem,
        domain: "chronorift-e3-revision-journal-checkpoint-v1",
        schemaId: checkpoint.schemaId,
        version: checkpoint.schemaVersion,
        value: basis,
        signature,
      })
    ) {
      throw new E3RegistrarError(
        "unauthorized",
        "revision checkpoint signature is invalid",
      );
    }
  }

  #verifyPublicationProof(
    proof: z.infer<typeof E3PublicationProofV1Schema>,
  ): void {
    this.#verifyCheckpoint(proof.registrationCheckpoint);
    this.#verifyCheckpoint(proof.closureCheckpoint);
    if (
      Date.parse(proof.registrationCheckpoint.issuedAt) >
        Date.parse(proof.closureCheckpoint.issuedAt) ||
      proof.closureCheckpoint.treeSize <=
        proof.registrationCheckpoint.treeSize ||
      !verifyInclusionProofV1({
        leafBytes: closurePublicationLeafBytesV1({
          campaignId: proof.campaignId,
          closureHash: proof.closureHash,
        }),
        leafIndex: proof.closureInclusionProof.leafIndex,
        treeSize: proof.closureInclusionProof.treeSize,
        auditPath: proof.closureInclusionProof.auditPath,
        expectedRoot: proof.closureCheckpoint.rootHash,
      }) ||
      !verifyConsistencyProofV1({
        oldTreeSize: proof.registrationCheckpoint.treeSize,
        newTreeSize: proof.closureCheckpoint.treeSize,
        oldRoot: proof.registrationCheckpoint.rootHash,
        newRoot: proof.closureCheckpoint.rootHash,
        proof: proof.registrationToClosureConsistencyProof.auditPath,
      })
    ) {
      throw new E3RegistrarError(
        "invalid",
        "publication inclusion or consistency proof is invalid",
      );
    }
  }

  #verifyCheckpoint(
    checkpoint: z.infer<typeof E3PublicationProofV1Schema>["closureCheckpoint"],
  ): void {
    if (
      checkpoint.logKeyId !== this.service.logKey.keyId ||
      !keyValidAt(this.service.logKey, checkpoint.issuedAt)
    ) {
      throw new E3RegistrarError(
        "unauthorized",
        "transparency checkpoint does not use the pinned log key",
      );
    }
    const { signature, ...basis } = checkpoint;
    if (
      !verifyCanonicalJsonSignatureV1({
        publicKey: this.service.logKey.publicKeyPem,
        domain: "chronorift-e3-transparency-checkpoint-v1",
        schemaId: "chronorift.e3.transparency-checkpoint",
        version: 1,
        value: basis,
        signature,
      })
    ) {
      throw new E3RegistrarError(
        "unauthorized",
        "transparency checkpoint signature is invalid",
      );
    }
  }

  #verifyPrimaryClosure(
    closure: z.infer<typeof E3PrimaryClosureV1Schema>,
  ): void {
    if (
      closure.clockKeyId !== this.service.clockKey.keyId ||
      closure.closureKeyId !== this.service.closureKey.keyId ||
      !keyValidAt(this.service.clockKey, closure.closedAt) ||
      !keyValidAt(this.service.closureKey, closure.closedAt)
    ) {
      throw new E3RegistrarError(
        "unauthorized",
        "primary closure does not use the pinned clock and closure keys",
      );
    }
    const { closureHash, signature, ...closureHashBasis } = closure;
    if (closureHash !== canonicalContentHashV1(closureHashBasis)) {
      throw new E3RegistrarError(
        "invalid",
        "primary closure hash does not match its canonical basis",
      );
    }
    const clockBasis = {
      campaignId: closure.campaignId,
      journalHead: closure.journalHead,
      deadline: closure.deadline,
      closedAt: closure.closedAt,
      primaryOutcome: closure.primaryOutcome,
    };
    const closureBasis = { ...closureHashBasis, closureHash };
    if (
      !verifyCanonicalJsonSignatureV1({
        publicKey: this.service.clockKey.publicKeyPem,
        domain: "chronorift-e3-clock-v1",
        schemaId: closure.schemaId,
        version: closure.schemaVersion,
        value: clockBasis,
        signature: closure.clockSignature,
      }) ||
      !verifyCanonicalJsonSignatureV1({
        publicKey: this.service.closureKey.publicKeyPem,
        domain: "chronorift-e3-primary-closure-v1",
        schemaId: closure.schemaId,
        version: closure.schemaVersion,
        value: closureBasis,
        signature,
      })
    ) {
      throw new E3RegistrarError(
        "unauthorized",
        "primary closure signature is invalid",
      );
    }
  }

  #verifyPendingStatus(
    status: z.infer<typeof E3PublicPendingStatusV1Schema>,
  ): void {
    if (
      status.registrarServiceId !== this.service.serviceId ||
      status.clockKeyId !== this.service.clockKey.keyId ||
      status.closureKeyId !== this.service.closureKey.keyId ||
      !keyValidAt(this.service.clockKey, status.observedAt) ||
      !keyValidAt(this.service.closureKey, status.observedAt)
    ) {
      throw new E3RegistrarError(
        "unauthorized",
        "public pending status does not use the pinned registrar keys",
      );
    }
    const clockBasis = {
      campaignId: status.campaignId,
      deadline: status.deadline,
      observedAt: status.observedAt,
    };
    const { signature, ...statusBasis } = status;
    if (
      !verifyCanonicalJsonSignatureV1({
        publicKey: this.service.clockKey.publicKeyPem,
        domain: "chronorift-e3-pending-status-clock-v1",
        schemaId: status.schemaId,
        version: status.schemaVersion,
        value: clockBasis,
        signature: status.clockSignature,
      }) ||
      !verifyCanonicalJsonSignatureV1({
        publicKey: this.service.closureKey.publicKeyPem,
        domain: "chronorift-e3-pending-status-v1",
        schemaId: status.schemaId,
        version: status.schemaVersion,
        value: statusBasis,
        signature,
      })
    ) {
      throw new E3RegistrarError(
        "unauthorized",
        "public pending status signature is invalid",
      );
    }
  }
}

export const verifyTrustRootV1 = (input: {
  readonly trustRoot: unknown;
  readonly now: Date;
}): E3RegistrarTrustRootV1 => {
  const root = E3RegistrarTrustRootV1Schema.parse(input.trustRoot);
  const { signatures, ...basis } = root;
  if (
    input.now.getTime() < Date.parse(root.validFrom) ||
    input.now.getTime() >= Date.parse(root.validUntil)
  ) {
    throw new E3RegistrarError(
      "invalid",
      "registrar trust root is not current",
    );
  }
  const keys = new Map(root.rootKeys.map((key) => [key.keyId, key]));
  if (
    root.rootKeys.some(
      ({ keyId, publicKeyPem }) => ed25519KeyIdV1(publicKeyPem) !== keyId,
    ) ||
    root.services.some((service) =>
      [
        service.receiptKey,
        service.clockKey,
        service.closureKey,
        service.logKey,
      ].some(
        ({ keyId, publicKeyPem }) => ed25519KeyIdV1(publicKeyPem) !== keyId,
      ),
    )
  ) {
    throw new E3RegistrarError(
      "unauthorized",
      "registrar trust root contains a key with a mismatched identity",
    );
  }
  let valid = 0;
  for (const signature of signatures) {
    const key = keys.get(signature.keyId);
    if (
      key !== undefined &&
      ed25519KeyIdV1(key.publicKeyPem) === key.keyId &&
      verifyCanonicalJsonSignatureV1({
        publicKey: key.publicKeyPem,
        domain: "chronorift-e3-trust-root-v1",
        schemaId: root.schemaId,
        version: root.schemaVersion,
        value: basis,
        signature: signature.signature,
      })
    ) {
      valid += 1;
    }
  }
  if (valid < root.signatureThreshold) {
    throw new E3RegistrarError(
      "unauthorized",
      "registrar trust-root threshold is not satisfied",
    );
  }
  return root;
};

export const serviceFromTrustRootV1 = (input: {
  readonly trustRoot: E3RegistrarTrustRootV1;
  readonly serviceId: string;
  readonly namespace: string;
  readonly now: Date;
}): E3RegistrarServiceBindingV1 => {
  const service = input.trustRoot.services.find(
    ({ serviceId }) => serviceId === input.serviceId,
  );
  if (service === undefined || !service.namespaces.includes(input.namespace)) {
    throw new E3RegistrarError(
      "unauthorized",
      "service or namespace is not authorized by the trust root",
    );
  }
  for (const key of [
    service.receiptKey,
    service.clockKey,
    service.closureKey,
    service.logKey,
  ]) {
    if (
      ed25519KeyIdV1(key.publicKeyPem) !== key.keyId ||
      input.now.getTime() < Date.parse(key.validFrom) ||
      input.now.getTime() >= Date.parse(key.validUntil)
    ) {
      throw new E3RegistrarError(
        "unauthorized",
        "service role key is invalid or outside its validity interval",
      );
    }
  }
  return service;
};
