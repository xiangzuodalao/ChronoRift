import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import {
  isAbsolute,
  parse as parsePath,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  JsonValueSchema,
  Sha256DigestV1Schema,
  SourceIdSchema,
  asSha256DigestV1,
  type Sha256DigestV1,
} from "@chronorift/domain";
import { canonicalJson } from "@chronorift/json-artifacts";
import { z } from "zod";

import {
  M7R3TwoCasePortfolioFreezeV1Schema,
  type M7R3TwoCasePortfolioFreezeV1,
} from "./m7-r3-two-case-portfolio.js";
import { publishPrivateFileOnceV1 } from "./private-atomic-publication.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const RECORD_BYTE_LIMIT = 1024 * 1024;

const admissionIdSchema = z
  .string()
  .regex(/^m7-r3-case-admission:[a-f0-9]{24}$/u);
const portfolioIdSchema = z.string().regex(/^m7-r3-portfolio:[a-f0-9]{24}$/u);
const portfolioCaseIdSchema = z.string().regex(/^m7-r3-case:[a-f0-9]{24}$/u);
const campaignIdSchema = z.string().regex(/^m7-campaign:[a-f0-9]{24}$/u);
const trajectoryCaseSpecIdSchema = z
  .string()
  .regex(/^m7-r3-trajectory-case:[a-f0-9]{24}$/u);
const caseOrdinalSchema = z.union([z.literal(1), z.literal(2)]);

const digest = (bytes: string | Uint8Array): Sha256DigestV1 =>
  asSha256DigestV1(createHash("sha256").update(bytes).digest("hex"));

const digestJson = (value: unknown): Sha256DigestV1 =>
  digest(canonicalJson(JsonValueSchema.parse(value)));

const addIssue = (
  context: z.RefinementCtx,
  path: readonly (string | number)[],
  message: string,
): void => {
  context.addIssue({ code: "custom", path: [...path], message });
};

const mutantIdentitySchema = z
  .object({
    mutationSha256: Sha256DigestV1Schema,
    mutatedBuildSourceId: SourceIdSchema,
    mutatedBuildSourceSha256: Sha256DigestV1Schema,
    mutatedBaselineSelectedTreeSha256: Sha256DigestV1Schema,
    mutatedBuildSourceIdentitySha256: Sha256DigestV1Schema,
  })
  .strict();

const trajectoryIdentitySchema = z
  .object({
    classifierFreezeRecordSha256: Sha256DigestV1Schema,
    classifierImplementationSha256: Sha256DigestV1Schema,
    classifierConfigSha256: Sha256DigestV1Schema,
    caseSpecId: trajectoryCaseSpecIdSchema,
    caseSpecSha256: Sha256DigestV1Schema,
  })
  .strict();

const promptIdentitySchema = z
  .object({
    /** SHA-256 of the exact natural-user prompt UTF-8 bytes. */
    utf8Sha256: Sha256DigestV1Schema,
    /** SHA-256 of canonical JSON encoding of the same prompt string. */
    canonicalJsonSha256: Sha256DigestV1Schema,
  })
  .strict();

const pairedProtocolIdentitySchema = z
  .object({
    pairedAgentProtocolImplementationSha256: Sha256DigestV1Schema,
    pairedCaseContractContentSha256: Sha256DigestV1Schema,
    pairedPublicTaskContractSha256: Sha256DigestV1Schema,
    runtimeArmPublicTaskSpecSha256: Sha256DigestV1Schema,
    codeOnlyArmPublicTaskSpecSha256: Sha256DigestV1Schema,
  })
  .strict();

const admissionIdentitySchema = z
  .object({
    schemaVersion: z.literal(1),
    portfolioId: portfolioIdSchema,
    portfolioFreezeRecordSha256: Sha256DigestV1Schema,
    caseOrdinal: caseOrdinalSchema,
    caseId: portfolioCaseIdSchema,
    portfolioCaseIdentitySha256: Sha256DigestV1Schema,
    campaignId: campaignIdSchema,
    mutationRegistrationRecordSha256: Sha256DigestV1Schema,
    mutant: mutantIdentitySchema,
    prompt: promptIdentitySchema,
    trajectory: trajectoryIdentitySchema,
    pairedProtocol: pairedProtocolIdentitySchema,
    authoritativeSensorFreezeRecordSha256: Sha256DigestV1Schema,
    adapterMutantCompatibilityReceiptSha256: Sha256DigestV1Schema,
    preflightImplementationSha256: Sha256DigestV1Schema,
  })
  .strict();

const admissionBasisSchema = admissionIdentitySchema
  .extend({
    recordKind: z.literal("m7-r3-case-campaign-admission"),
    admissionId: admissionIdSchema,
    admittedAt: z.string().datetime({ offset: true }),
  })
  .strict();

/**
 * Host-only identity binding for one pre-registered R3 case campaign.
 *
 * The strict DTO intentionally contains no prompt text, mutation bytes,
 * evaluator bytes, or filesystem paths. Those hidden materials remain in
 * their owning Host-only stores and are referenced only by content hashes.
 */
export const M7R3CaseCampaignAdmissionV1Schema = admissionBasisSchema
  .extend({ recordContentSha256: Sha256DigestV1Schema })
  .strict()
  .superRefine((value, context) => {
    const expectedMutantSourceIdentity = digestJson({
      schemaVersion: 1,
      sourceId: value.mutant.mutatedBuildSourceId,
      sourceHash: value.mutant.mutatedBuildSourceSha256,
    });
    if (
      value.mutant.mutatedBuildSourceIdentitySha256 !==
      expectedMutantSourceIdentity
    ) {
      addIssue(
        context,
        ["mutant", "mutatedBuildSourceIdentitySha256"],
        "admitted mutant source identity does not match its source ID and hash",
      );
    }
    if (
      value.trajectory.caseSpecId !==
      `m7-r3-trajectory-case:${value.trajectory.caseSpecSha256.slice(0, 24)}`
    ) {
      addIssue(
        context,
        ["trajectory", "caseSpecId"],
        "admitted trajectory case-spec ID does not match its content hash",
      );
    }
    const identity = admissionIdentitySchema.parse({
      schemaVersion: value.schemaVersion,
      portfolioId: value.portfolioId,
      portfolioFreezeRecordSha256: value.portfolioFreezeRecordSha256,
      caseOrdinal: value.caseOrdinal,
      caseId: value.caseId,
      portfolioCaseIdentitySha256: value.portfolioCaseIdentitySha256,
      campaignId: value.campaignId,
      mutationRegistrationRecordSha256: value.mutationRegistrationRecordSha256,
      mutant: value.mutant,
      prompt: value.prompt,
      trajectory: value.trajectory,
      pairedProtocol: value.pairedProtocol,
      authoritativeSensorFreezeRecordSha256:
        value.authoritativeSensorFreezeRecordSha256,
      adapterMutantCompatibilityReceiptSha256:
        value.adapterMutantCompatibilityReceiptSha256,
      preflightImplementationSha256: value.preflightImplementationSha256,
    });
    const expectedAdmissionId = `m7-r3-case-admission:${digestJson(identity).slice(0, 24)}`;
    if (value.admissionId !== expectedAdmissionId) {
      addIssue(
        context,
        ["admissionId"],
        "case-campaign admission ID must derive from its complete identity",
      );
    }
    const { recordContentSha256, ...basis } = value;
    if (recordContentSha256 !== digestJson(basis)) {
      addIssue(
        context,
        ["recordContentSha256"],
        "case-campaign admission content hash does not match",
      );
    }
  });
export type M7R3CaseCampaignAdmissionV1 = z.infer<
  typeof M7R3CaseCampaignAdmissionV1Schema
>;

const createAdmissionInputSchema = z
  .object({
    portfolioFreeze: M7R3TwoCasePortfolioFreezeV1Schema,
    caseOrdinal: caseOrdinalSchema,
    campaignId: campaignIdSchema,
    mutationRegistrationRecordSha256: Sha256DigestV1Schema,
    naturalPromptCanonicalJsonSha256: Sha256DigestV1Schema,
    pairedAgentProtocolImplementationSha256: Sha256DigestV1Schema,
    pairedCaseContractContentSha256: Sha256DigestV1Schema,
    runtimeArmPublicTaskSpecSha256: Sha256DigestV1Schema,
    codeOnlyArmPublicTaskSpecSha256: Sha256DigestV1Schema,
    admittedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type CreateM7R3CaseCampaignAdmissionV1Input = z.input<
  typeof createAdmissionInputSchema
>;

export const createM7R3CaseCampaignAdmissionV1 = (
  input: CreateM7R3CaseCampaignAdmissionV1Input,
): M7R3CaseCampaignAdmissionV1 => {
  const parsed = createAdmissionInputSchema.parse(input);
  const portfolio: M7R3TwoCasePortfolioFreezeV1 = parsed.portfolioFreeze;
  const frozenCase = portfolio.cases[parsed.caseOrdinal - 1];
  if (frozenCase === undefined || frozenCase.ordinal !== parsed.caseOrdinal) {
    throw new TypeError("R3 portfolio omitted the selected case ordinal");
  }
  const identity = admissionIdentitySchema.parse({
    schemaVersion: 1,
    portfolioId: portfolio.portfolioId,
    portfolioFreezeRecordSha256: portfolio.recordContentSha256,
    caseOrdinal: parsed.caseOrdinal,
    caseId: frozenCase.caseId,
    portfolioCaseIdentitySha256: digestJson(frozenCase),
    campaignId: parsed.campaignId,
    mutationRegistrationRecordSha256: parsed.mutationRegistrationRecordSha256,
    mutant: frozenCase.mutant,
    prompt: {
      utf8Sha256: frozenCase.naturalPromptUtf8Sha256,
      canonicalJsonSha256: parsed.naturalPromptCanonicalJsonSha256,
    },
    trajectory: {
      classifierFreezeRecordSha256:
        portfolio.commonRuntimeMaterials.trajectoryClassifierFreezeRecordSha256,
      classifierImplementationSha256:
        portfolio.commonRuntimeMaterials
          .trajectoryClassifierImplementationSha256,
      classifierConfigSha256:
        portfolio.commonRuntimeMaterials.trajectoryClassifierConfigSha256,
      caseSpecId: frozenCase.trajectoryCaseSpecId,
      caseSpecSha256: frozenCase.trajectoryCaseSpecSha256,
    },
    pairedProtocol: {
      pairedAgentProtocolImplementationSha256:
        parsed.pairedAgentProtocolImplementationSha256,
      pairedCaseContractContentSha256: parsed.pairedCaseContractContentSha256,
      pairedPublicTaskContractSha256: frozenCase.pairedPublicTaskContractSha256,
      runtimeArmPublicTaskSpecSha256: parsed.runtimeArmPublicTaskSpecSha256,
      codeOnlyArmPublicTaskSpecSha256: parsed.codeOnlyArmPublicTaskSpecSha256,
    },
    authoritativeSensorFreezeRecordSha256:
      portfolio.commonRuntimeMaterials.authoritativeSensorFreezeRecordSha256,
    adapterMutantCompatibilityReceiptSha256:
      frozenCase.adapterMutantCompatibilityReceiptSha256,
    preflightImplementationSha256: frozenCase.preflightImplementationSha256,
  });
  const basis = admissionBasisSchema.parse({
    ...identity,
    recordKind: "m7-r3-case-campaign-admission",
    admissionId: `m7-r3-case-admission:${digestJson(identity).slice(0, 24)}`,
    admittedAt: parsed.admittedAt,
  });
  return M7R3CaseCampaignAdmissionV1Schema.parse({
    ...basis,
    recordContentSha256: digestJson(basis),
  });
};

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error;

const requireEffectiveUserId = (): number => {
  const uid = process.geteuid?.();
  if (uid === undefined) {
    throw new Error("M7 R3 admission store requires effective-user checks");
  }
  return uid;
};

const pathWithinOrEqual = (parent: string, candidate: string): boolean => {
  const difference = relative(parent, candidate);
  return (
    difference === "" ||
    (difference !== ".." &&
      !difference.startsWith(`..${sep}`) &&
      !isAbsolute(difference))
  );
};

const canonicalDirectory = async (inputPath: string, label: string) => {
  const absolute = resolve(inputPath);
  if (absolute === parsePath(absolute).root) {
    throw new Error(`${label} must not be a filesystem root`);
  }
  const metadata = await lstat(absolute);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
  const canonical = await realpath(absolute);
  if (canonical !== absolute) {
    throw new Error(`${label} must be canonical with no symlink component`);
  }
  return { canonical, metadata };
};

interface PrivateRootIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly mode: number;
}

const admissionRecordName = (ordinal: 1 | 2): string =>
  ordinal === 1
    ? "m7-r3.case-01-campaign-admission.json"
    : "m7-r3.case-02-campaign-admission.json";

export class M7R3CaseCampaignAdmissionStoreV1 {
  readonly #root: string;
  readonly #identity: PrivateRootIdentity;

  private constructor(root: string, identity: PrivateRootIdentity) {
    this.#root = root;
    this.#identity = identity;
  }

  public static async open(input: {
    readonly root: string;
    readonly exposedRoots: readonly string[];
  }): Promise<M7R3CaseCampaignAdmissionStoreV1> {
    const { canonical: root, metadata } = await canonicalDirectory(
      input.root,
      "M7 R3 Host-only admission root",
    );
    if (
      metadata.uid !== requireEffectiveUserId() ||
      (metadata.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE
    ) {
      throw new Error(
        "M7 R3 Host-only admission root must be owned by the current user with mode 0700",
      );
    }
    for (const [index, exposedRoot] of input.exposedRoots.entries()) {
      const { canonical: exposed } = await canonicalDirectory(
        exposedRoot,
        `M7 R3 exposed root ${index + 1}`,
      );
      if (
        pathWithinOrEqual(root, exposed) ||
        pathWithinOrEqual(exposed, root)
      ) {
        throw new Error(
          "M7 R3 Host-only admission root must be disjoint from Agent-exposed roots",
        );
      }
    }
    return new M7R3CaseCampaignAdmissionStoreV1(root, {
      dev: metadata.dev,
      ino: metadata.ino,
      uid: metadata.uid,
      mode: metadata.mode,
    });
  }

  async #requireRoot(): Promise<void> {
    const metadata = await lstat(this.#root);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.dev !== this.#identity.dev ||
      metadata.ino !== this.#identity.ino ||
      metadata.uid !== this.#identity.uid ||
      metadata.mode !== this.#identity.mode ||
      (metadata.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE ||
      (await realpath(this.#root)) !== this.#root
    ) {
      throw new Error("M7 R3 Host-only admission root identity changed");
    }
  }

  #path(ordinal: 1 | 2): string {
    return resolve(this.#root, admissionRecordName(ordinal));
  }

  async #writeOnce(
    ordinal: 1 | 2,
    value: M7R3CaseCampaignAdmissionV1,
  ): Promise<void> {
    await this.#requireRoot();
    const bytes = Buffer.from(
      `${canonicalJson(JsonValueSchema.parse(value))}\n`,
      "utf8",
    );
    if (bytes.byteLength > RECORD_BYTE_LIMIT) {
      throw new Error("M7 R3 case admission exceeds its byte limit");
    }
    try {
      await publishPrivateFileOnceV1({
        root: this.#root,
        filename: admissionRecordName(ordinal),
        bytes,
      });
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new Error(
          `M7 R3 case ${ordinal} admission already exists; overwrite, retry, and reroll are forbidden`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  public async createAdmissionOnce(
    input: CreateM7R3CaseCampaignAdmissionV1Input,
  ): Promise<M7R3CaseCampaignAdmissionV1> {
    const record = createM7R3CaseCampaignAdmissionV1(input);
    await this.#writeOnce(record.caseOrdinal, record);
    return record;
  }

  public async readAdmission(
    ordinal: 1 | 2,
  ): Promise<M7R3CaseCampaignAdmissionV1> {
    await this.#requireRoot();
    const path = this.#path(ordinal);
    if (!pathWithinOrEqual(this.#root, path)) {
      throw new Error("M7 R3 case admission escaped its Host-only root");
    }
    const metadata = await lstat(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.nlink !== 1 ||
      metadata.uid !== requireEffectiveUserId() ||
      (metadata.mode & 0o7777) !== PRIVATE_FILE_MODE ||
      metadata.size > RECORD_BYTE_LIMIT ||
      (await realpath(path)) !== path
    ) {
      throw new Error(
        "M7 R3 case admission must remain a canonical one-link owned mode-0600 regular file",
      );
    }
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const opened = await handle.stat();
      if (
        opened.dev !== metadata.dev ||
        opened.ino !== metadata.ino ||
        opened.nlink !== 1 ||
        opened.size > RECORD_BYTE_LIMIT
      ) {
        throw new Error("M7 R3 case admission identity changed while opening");
      }
      let value: unknown;
      try {
        value = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            await handle.readFile(),
          ),
        );
      } catch (error) {
        throw new Error("M7 R3 case admission is not valid UTF-8 JSON", {
          cause: error,
        });
      }
      const afterRead = await handle.stat();
      if (
        afterRead.dev !== opened.dev ||
        afterRead.ino !== opened.ino ||
        afterRead.nlink !== 1 ||
        afterRead.size !== opened.size
      ) {
        throw new Error("M7 R3 case admission changed while reading");
      }
      const parsed = M7R3CaseCampaignAdmissionV1Schema.parse(value);
      if (parsed.caseOrdinal !== ordinal) {
        throw new Error("M7 R3 case admission crossed its fixed ordinal");
      }
      return parsed;
    } finally {
      await handle.close();
    }
  }
}

export const openM7R3CaseCampaignAdmissionStoreV1 = (
  input: Parameters<typeof M7R3CaseCampaignAdmissionStoreV1.open>[0],
): Promise<M7R3CaseCampaignAdmissionStoreV1> =>
  M7R3CaseCampaignAdmissionStoreV1.open(input);
