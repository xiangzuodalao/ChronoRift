import type {
  E3AppendReceiptV1,
  E3CampaignManifestV1,
  E3CampaignRegistrationProofV1,
  E3ClosedEvidenceSnapshotV1,
  E3JournalEntryV1,
  E3JournalV1,
  E3LateAppendResultV1,
  E3PrimaryClosureV1,
  E3PublicPendingStatusV1,
  E3PublicationProofV1,
} from "./contracts.js";

export type E3RegistrarErrorCodeV1 =
  | "closed"
  | "conflict"
  | "invalid"
  | "unauthorized"
  | "unavailable"
  | "unsupported";

export class E3RegistrarError extends Error {
  public constructor(
    public readonly code: E3RegistrarErrorCodeV1,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`E3.1 registrar ${code}: ${message}`, options);
    this.name = "E3RegistrarError";
  }
}

export interface E3CampaignRegistrationV1 {
  readonly campaignId: string;
  readonly assignmentId: string;
  readonly receipt: E3AppendReceiptV1;
  readonly registrationProof: E3CampaignRegistrationProofV1;
}

export interface E3RegistrarPortV1 {
  registerCampaign(input: {
    readonly manifest: E3CampaignManifestV1;
    readonly actorCapability: string;
  }): Promise<E3CampaignRegistrationV1>;

  appendEvent(input: {
    readonly campaignId: string;
    readonly entry: E3JournalEntryV1;
    readonly actorCapability: string;
  }): Promise<E3AppendReceiptV1>;

  readJournal(input: {
    readonly campaignId: string;
    readonly afterOrdinal: number;
  }): Promise<E3JournalV1>;

  readPrimaryClosure(input: {
    readonly campaignId: string;
  }): Promise<E3PrimaryClosureV1 | null>;

  /**
   * Reads the registrar's signed public status feed. This observation never
   * substitutes for a transparency-log publication proof.
   */
  readPendingStatus(input: {
    readonly campaignId: string;
  }): Promise<E3PublicPendingStatusV1>;

  appendRevision(input: {
    readonly campaignId: string;
    readonly lateEntry: E3JournalEntryV1;
    readonly actorCapability: string;
  }): Promise<E3LateAppendResultV1>;

  readPublicationProof(input: {
    readonly campaignId: string;
    readonly closureHash: string;
  }): Promise<E3PublicationProofV1>;

  readClosedEvidence(input: {
    readonly campaignId: string;
  }): Promise<E3ClosedEvidenceSnapshotV1 | null>;
}
