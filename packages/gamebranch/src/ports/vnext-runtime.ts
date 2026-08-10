import type {
  EventId,
  JsonValue,
  Sha256DigestV1,
  VNextCapturedStateDomainV1,
  VNextCheckpointManifestV1,
  VNextResetStateDomainV1,
  VNextRestoreValidationV1,
  VNextTraceEventV1,
  VNextTraceRealizationV1,
} from "@chronorift/domain";

export interface VNextRuntimeEventIdPort {
  nextEventId(): EventId;
}

export type VNextDomainRestoreAttempt =
  | {
      readonly status: "restored" | "reset";
      readonly beforeHash: Sha256DigestV1 | null;
      readonly afterHash: Sha256DigestV1;
      readonly message: string | null;
    }
  | {
      readonly status: "rejected";
      readonly beforeHash: Sha256DigestV1 | null;
      readonly afterHash: null;
      readonly message: string;
    };

export interface VNextCheckpointRestorePort {
  restoreCapturedDomain(
    domain: VNextCapturedStateDomainV1,
  ): VNextDomainRestoreAttempt;
  resetDomain(domain: VNextResetStateDomainV1): VNextDomainRestoreAttempt;
  validateRestore(
    manifest: VNextCheckpointManifestV1,
  ): readonly VNextRestoreValidationV1[];
}

export interface VNextTraceReplayObservation {
  readonly subject: string;
  readonly value: JsonValue;
}

export interface VNextTraceReplayApplication {
  readonly realized: VNextTraceRealizationV1;
  readonly observed: VNextTraceReplayObservation;
  readonly knownSideEffects: readonly string[];
}

export interface VNextTraceReplayPort {
  apply(event: VNextTraceEventV1): VNextTraceReplayApplication;
}
