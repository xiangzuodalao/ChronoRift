import type {
  EvidenceCapsuleV2,
  EventId,
  JsonObject,
  JsonPrimitive,
  V03ExecutionComparison,
  V03ExecutionLog,
} from "@chronorift/domain";

export interface ClaimEvidenceBlocker {
  readonly code: string;
  readonly message: string;
  readonly eventIds?: readonly EventId[] | undefined;
}

export interface ClaimEvidenceDecision {
  readonly supported: boolean;
  readonly blockers: readonly ClaimEvidenceBlocker[];
}

export interface ClaimEvidenceContext {
  readonly capsule: EvidenceCapsuleV2;
  readonly baselineExecution: V03ExecutionLog;
  readonly replayExecution?: V03ExecutionLog | undefined;
  readonly comparisons: readonly V03ExecutionComparison[];
  readonly candidateExecutions: readonly V03ExecutionLog[];
  readonly citedEventIds: readonly EventId[];
}

export interface ClaimAssertionIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

export type ClaimAssertionParseResult<TAssertion> =
  | {
      readonly success: true;
      readonly data: TAssertion;
    }
  | {
      readonly success: false;
      readonly issues: readonly ClaimAssertionIssue[];
    };

/**
 * A deliberately small structural schema boundary. Adapters may implement this
 * with Zod or another strict validator without making GameBranch depend on it.
 */
export interface ClaimAssertionSchema<TAssertion> {
  readonly safeParse: (
    payload: JsonObject,
  ) => ClaimAssertionParseResult<TAssertion>;
}

export interface ClaimEvidencePolicyDescriptor {
  readonly policyId: string;
  readonly policyVersion: string;
  readonly mechanismId: string;
  readonly assertionSchemaId: string;
}

export type ClaimAssertionValueType =
  "string" | "integer" | "json" | "json_primitive";

/**
 * Engine-neutral documentation for one required assertion payload field.
 * The policy's assertionSchema remains the canonical runtime validator; this
 * contract makes that input discoverable to an untrusted diagnostic Agent.
 */
export interface ClaimAssertionFieldContract {
  readonly name: string;
  readonly type: ClaimAssertionValueType;
  readonly required: true;
  readonly description: string;
  readonly minimum?: number | undefined;
  readonly allowedValues?: readonly JsonPrimitive[] | undefined;
}

/**
 * Agent-facing shape of a claim assertion. It describes every accepted field
 * without supplying Fixture-specific values or selecting a mechanism.
 */
export interface ClaimPolicyAgentContract {
  readonly mechanismDescription: string;
  /**
   * Human-readable proof obligations for the event citations required by this
   * policy. These describe evidence roles, never Fixture-specific values.
   */
  readonly evidenceRequirements: readonly string[];
  readonly additionalProperties: false;
  readonly assertionFields: readonly ClaimAssertionFieldContract[];
}

export interface ClaimPolicyAgentDescriptor
  extends ClaimEvidencePolicyDescriptor, ClaimPolicyAgentContract {}

export interface ClaimEvidencePolicyInput<TAssertion> {
  readonly assertion: TAssertion;
  readonly context: ClaimEvidenceContext;
}

/**
 * A policy can decide only whether evidence supports one typed mechanism
 * assertion. Canonical verdict construction remains the Harness Gate's job.
 */
export interface ClaimEvidencePolicy<TAssertion> {
  readonly descriptor: ClaimEvidencePolicyDescriptor;
  readonly agentContract: ClaimPolicyAgentContract;
  readonly assertionSchema: ClaimAssertionSchema<TAssertion>;
  readonly evaluate: (
    input: ClaimEvidencePolicyInput<TAssertion>,
  ) => ClaimEvidenceDecision;
}

export interface EvaluateClaimEvidenceInput {
  readonly mechanismId: string;
  readonly assertion: {
    readonly schemaId: string;
    readonly payload: JsonObject;
  };
  readonly context: ClaimEvidenceContext;
}

export type ClaimEvidencePolicyRegistryErrorCode =
  | "INVALID_POLICY_DESCRIPTOR"
  | "INVALID_AGENT_CONTRACT"
  | "DUPLICATE_POLICY_ID"
  | "DUPLICATE_MECHANISM_ID"
  | "UNKNOWN_MECHANISM_ID"
  | "ASSERTION_SCHEMA_MISMATCH"
  | "ASSERTION_INVALID"
  | "POLICY_DECISION_INVALID";

export class ClaimEvidencePolicyRegistryError extends Error {
  public constructor(
    public readonly code: ClaimEvidencePolicyRegistryErrorCode,
    message: string,
    public readonly assertionIssues: readonly ClaimAssertionIssue[] = [],
  ) {
    super(message);
    this.name = "ClaimEvidencePolicyRegistryError";
  }
}

interface RegisteredClaimEvidencePolicy {
  readonly descriptor: ClaimEvidencePolicyDescriptor;
  readonly agentDescriptor: ClaimPolicyAgentDescriptor;
  readonly evaluate: (
    payload: JsonObject,
    context: ClaimEvidenceContext,
  ) => ClaimEvidenceDecision;
}

const identifierPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const versionPattern = /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/u;
const assertionFieldNamePattern = /^[A-Za-z][A-Za-z0-9_]*$/u;
const assertionValueTypes = new Set<ClaimAssertionValueType>([
  "string",
  "integer",
  "json",
  "json_primitive",
]);

const validateDescriptor = (
  descriptor: ClaimEvidencePolicyDescriptor,
): void => {
  const invalid =
    !identifierPattern.test(descriptor.policyId) ||
    !versionPattern.test(descriptor.policyVersion) ||
    !identifierPattern.test(descriptor.mechanismId) ||
    descriptor.assertionSchemaId.length === 0 ||
    descriptor.assertionSchemaId.trim() !== descriptor.assertionSchemaId;
  if (invalid) {
    throw new ClaimEvidencePolicyRegistryError(
      "INVALID_POLICY_DESCRIPTOR",
      `Invalid claim evidence policy descriptor for ${descriptor.policyId || "<empty>"}`,
    );
  }
};

const invalidAgentContract = (message: string): never => {
  throw new ClaimEvidencePolicyRegistryError("INVALID_AGENT_CONTRACT", message);
};

const validateAllowedValue = (
  field: ClaimAssertionFieldContract,
  value: JsonPrimitive,
): void => {
  if (field.type === "string" && typeof value !== "string") {
    invalidAgentContract(
      `Assertion field ${field.name} allows a non-string value`,
    );
  }
  if (
    field.type === "integer" &&
    (typeof value !== "number" || !Number.isInteger(value))
  ) {
    invalidAgentContract(
      `Assertion field ${field.name} allows a non-integer value`,
    );
  }
  if (
    field.type === "integer" &&
    field.minimum !== undefined &&
    typeof value === "number" &&
    value < field.minimum
  ) {
    invalidAgentContract(
      `Assertion field ${field.name} allows a value below its minimum`,
    );
  }
};

const validateAgentContract = (contract: ClaimPolicyAgentContract): void => {
  if (
    contract.mechanismDescription.length === 0 ||
    contract.mechanismDescription.trim() !== contract.mechanismDescription ||
    !Array.isArray(contract.evidenceRequirements) ||
    contract.evidenceRequirements.length === 0 ||
    contract.additionalProperties !== false ||
    !Array.isArray(contract.assertionFields) ||
    contract.assertionFields.length === 0
  ) {
    invalidAgentContract("Claim policy has an invalid Agent contract");
  }

  const evidenceRequirements = new Set<string>();
  for (const requirement of contract.evidenceRequirements) {
    if (
      typeof requirement !== "string" ||
      requirement.length === 0 ||
      requirement.trim() !== requirement
    ) {
      invalidAgentContract("Claim policy has an invalid evidence requirement");
    }
    if (evidenceRequirements.has(requirement)) {
      invalidAgentContract(
        `Claim policy repeats evidence requirement ${requirement}`,
      );
    }
    evidenceRequirements.add(requirement);
  }

  const fieldNames = new Set<string>();
  for (const field of contract.assertionFields) {
    if (
      !assertionFieldNamePattern.test(field.name) ||
      field.required !== true ||
      field.description.length === 0 ||
      field.description.trim() !== field.description ||
      !assertionValueTypes.has(field.type)
    ) {
      invalidAgentContract(
        `Claim policy has an invalid assertion field contract for ${field.name || "<empty>"}`,
      );
    }
    if (fieldNames.has(field.name)) {
      invalidAgentContract(
        `Claim policy repeats assertion field ${field.name}`,
      );
    }
    fieldNames.add(field.name);

    if (
      field.minimum !== undefined &&
      (field.type !== "integer" ||
        !Number.isInteger(field.minimum) ||
        !Number.isFinite(field.minimum))
    ) {
      invalidAgentContract(
        `Assertion field ${field.name} has an invalid minimum`,
      );
    }
    if (field.allowedValues !== undefined) {
      if (field.allowedValues.length === 0) {
        invalidAgentContract(
          `Assertion field ${field.name} has an empty allowed-values constraint`,
        );
      }
      const canonicalValues = field.allowedValues.map((value) =>
        JSON.stringify(value),
      );
      if (new Set(canonicalValues).size !== canonicalValues.length) {
        invalidAgentContract(
          `Assertion field ${field.name} repeats an allowed value`,
        );
      }
      for (const value of field.allowedValues) {
        validateAllowedValue(field, value);
      }
    }
  }
};

const freezeAgentDescriptor = (
  descriptor: ClaimEvidencePolicyDescriptor,
  contract: ClaimPolicyAgentContract,
): ClaimPolicyAgentDescriptor =>
  Object.freeze({
    ...descriptor,
    mechanismDescription: contract.mechanismDescription,
    evidenceRequirements: Object.freeze([...contract.evidenceRequirements]),
    additionalProperties: false,
    assertionFields: Object.freeze(
      contract.assertionFields.map((field) =>
        Object.freeze({
          ...field,
          ...(field.allowedValues === undefined
            ? {}
            : { allowedValues: Object.freeze([...field.allowedValues]) }),
        }),
      ),
    ),
  });

/**
 * Holds one active policy for each open mechanism ID. Registration performs
 * collision checks; evaluation parses the untrusted assertion before policy
 * code can observe it.
 */
export class ClaimEvidencePolicyRegistry {
  readonly #byPolicyId = new Map<string, RegisteredClaimEvidencePolicy>();
  readonly #byMechanismId = new Map<string, RegisteredClaimEvidencePolicy>();

  public register<TAssertion>(policy: ClaimEvidencePolicy<TAssertion>): this {
    validateDescriptor(policy.descriptor);
    validateAgentContract(policy.agentContract);
    const { policyId, mechanismId } = policy.descriptor;
    if (this.#byPolicyId.has(policyId)) {
      throw new ClaimEvidencePolicyRegistryError(
        "DUPLICATE_POLICY_ID",
        `Claim evidence policy ID ${policyId} is already registered`,
      );
    }
    if (this.#byMechanismId.has(mechanismId)) {
      throw new ClaimEvidencePolicyRegistryError(
        "DUPLICATE_MECHANISM_ID",
        `Mechanism ID ${mechanismId} already has an active claim evidence policy`,
      );
    }
    const registered: RegisteredClaimEvidencePolicy = {
      descriptor: Object.freeze({ ...policy.descriptor }),
      agentDescriptor: freezeAgentDescriptor(
        policy.descriptor,
        policy.agentContract,
      ),
      evaluate: (payload, context) => {
        const parsed = policy.assertionSchema.safeParse(payload);
        if (!parsed.success) {
          throw new ClaimEvidencePolicyRegistryError(
            "ASSERTION_INVALID",
            `Assertion does not satisfy ${policy.descriptor.assertionSchemaId}`,
            parsed.issues,
          );
        }
        const decision = policy.evaluate({
          assertion: parsed.data,
          context,
        });
        if (decision.supported === decision.blockers.length > 0) {
          throw new ClaimEvidencePolicyRegistryError(
            "POLICY_DECISION_INVALID",
            `Policy ${policyId} returned contradictory support and blocker fields`,
          );
        }
        return Object.freeze({
          supported: decision.supported,
          blockers: Object.freeze([...decision.blockers]),
        });
      },
    };
    this.#byPolicyId.set(policyId, registered);
    this.#byMechanismId.set(mechanismId, registered);
    return this;
  }

  public descriptors(): readonly ClaimEvidencePolicyDescriptor[] {
    return Object.freeze(
      [...this.#byPolicyId.values()]
        .map((policy) => policy.descriptor)
        .sort((left, right) => left.policyId.localeCompare(right.policyId)),
    );
  }

  public agentDescriptors(): readonly ClaimPolicyAgentDescriptor[] {
    return Object.freeze(
      [...this.#byPolicyId.values()]
        .map((policy) => policy.agentDescriptor)
        .sort((left, right) => left.policyId.localeCompare(right.policyId)),
    );
  }

  public evaluate(input: EvaluateClaimEvidenceInput): ClaimEvidenceDecision {
    const policy = this.#byMechanismId.get(input.mechanismId);
    if (policy === undefined) {
      throw new ClaimEvidencePolicyRegistryError(
        "UNKNOWN_MECHANISM_ID",
        `No claim evidence policy is registered for ${input.mechanismId}`,
      );
    }
    if (input.assertion.schemaId !== policy.descriptor.assertionSchemaId) {
      throw new ClaimEvidencePolicyRegistryError(
        "ASSERTION_SCHEMA_MISMATCH",
        `Mechanism ${input.mechanismId} requires assertion schema ${policy.descriptor.assertionSchemaId}, received ${input.assertion.schemaId}`,
      );
    }
    return policy.evaluate(input.assertion.payload, input.context);
  }
}
