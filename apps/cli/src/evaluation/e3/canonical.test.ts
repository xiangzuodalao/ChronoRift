import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  artifactSinkCommitmentV1,
  assignmentIdV1,
  campaignIdV1,
  ed25519KeyIdV1,
  eventIdV1,
  merkleLeafHashV1,
  merkleNodeHashV1,
  signCanonicalJsonV1,
  verifyCanonicalJsonSignatureV1,
  verifyConsistencyProofV1,
  verifyInclusionProofV1,
} from "./canonical.js";

const largestPowerOfTwoBelow = (value: number): number => {
  let result = 1;
  while (result * 2 < value) result *= 2;
  return result;
};

const treeRoot = (leaves: readonly Buffer[]): string => {
  if (leaves.length === 1) return merkleLeafHashV1(leaves[0]!);
  const split = largestPowerOfTwoBelow(leaves.length);
  return merkleNodeHashV1(
    treeRoot(leaves.slice(0, split)),
    treeRoot(leaves.slice(split)),
  );
};

const inclusionPath = (
  leafIndex: number,
  leaves: readonly Buffer[],
): string[] => {
  if (leaves.length === 1) return [];
  const split = largestPowerOfTwoBelow(leaves.length);
  return leafIndex < split
    ? [
        ...inclusionPath(leafIndex, leaves.slice(0, split)),
        treeRoot(leaves.slice(split)),
      ]
    : [
        ...inclusionPath(leafIndex - split, leaves.slice(split)),
        treeRoot(leaves.slice(0, split)),
      ];
};

const consistencyPath = (
  oldSize: number,
  leaves: readonly Buffer[],
  completeSubtree = true,
): string[] => {
  if (oldSize === leaves.length) {
    return completeSubtree ? [] : [treeRoot(leaves)];
  }
  const split = largestPowerOfTwoBelow(leaves.length);
  return oldSize <= split
    ? [
        ...consistencyPath(oldSize, leaves.slice(0, split), completeSubtree),
        treeRoot(leaves.slice(split)),
      ]
    : [
        ...consistencyPath(oldSize - split, leaves.slice(split), false),
        treeRoot(leaves.slice(0, split)),
      ];
};

describe("E3.1 canonical identities and signatures", () => {
  it("freezes the configured artifact sink commitment domain and basis", () => {
    const input = {
      namespace: "chronorift/e3/test",
      leaseId: "lease-1",
      artifactSinkId: "sink.test",
      canonicalAbsolutePath: "/ci/artifacts/e3",
      evidenceFileName: "e3-campaign-conformance-evidence.v1.json",
    } as const;

    expect(artifactSinkCommitmentV1(input)).toBe(
      "9e3d6bbceea8a100cc8f62b430e0fdfb723573c4b22150e3dce1f423493b1542",
    );
    expect(
      artifactSinkCommitmentV1({
        ...input,
        canonicalAbsolutePath: "/ci/artifacts/other",
      }),
    ).not.toBe(artifactSinkCommitmentV1(input));
  });

  it("derives stable, domain-separated full SHA-256 identities", () => {
    const campaignId = campaignIdV1({ b: 2, a: 1 });
    expect(campaignId).toMatch(/^[a-f0-9]{64}$/u);
    expect(campaignId).toBe(campaignIdV1({ a: 1, b: 2 }));

    const assignmentId = assignmentIdV1({
      campaignId,
      slotOrdinal: 1,
      assignmentCommitment: "a".repeat(64),
    });
    expect(assignmentId).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      eventIdV1({
        campaignId,
        assignmentId,
        ordinal: 1,
        previousHash: "0".repeat(64),
        eventKind: "registrar_assignment_registered",
        payloadHash: "b".repeat(64),
      }),
    ).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("signs exact domain/schema/version/canonical bytes", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const value = { schemaVersion: 1, status: "open" } as const;
    const signature = signCanonicalJsonV1({
      privateKey,
      domain: "chronorift-e3-test-v1",
      schemaId: "test-message",
      version: 1,
      value,
    });

    expect(ed25519KeyIdV1(publicKey)).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      verifyCanonicalJsonSignatureV1({
        publicKey,
        domain: "chronorift-e3-test-v1",
        schemaId: "test-message",
        version: 1,
        value,
        signature,
      }),
    ).toBe(true);
    expect(
      verifyCanonicalJsonSignatureV1({
        publicKey,
        domain: "chronorift-e3-test-v1",
        schemaId: "different",
        version: 1,
        value,
        signature,
      }),
    ).toBe(false);
    expect(
      verifyCanonicalJsonSignatureV1({
        publicKey,
        domain: "chronorift-e3-test-v1",
        schemaId: "test-message",
        version: 1,
        value,
        signature: `${signature}=`,
      }),
    ).toBe(false);
  });

  it("verifies RFC6962-style inclusion and consistency proofs", () => {
    const first = Buffer.from("first", "utf8");
    const second = Buffer.from("second", "utf8");
    const firstHash = merkleLeafHashV1(first);
    const secondHash = merkleLeafHashV1(second);
    const root = merkleNodeHashV1(firstHash, secondHash);

    expect(
      verifyInclusionProofV1({
        leafBytes: first,
        leafIndex: 0,
        treeSize: 2,
        auditPath: [secondHash],
        expectedRoot: root,
      }),
    ).toBe(true);
    expect(
      verifyInclusionProofV1({
        leafBytes: second,
        leafIndex: 1,
        treeSize: 2,
        auditPath: [firstHash],
        expectedRoot: root,
      }),
    ).toBe(true);
    expect(
      verifyConsistencyProofV1({
        oldTreeSize: 1,
        newTreeSize: 2,
        oldRoot: firstHash,
        newRoot: root,
        proof: [secondHash],
      }),
    ).toBe(true);
    expect(
      verifyConsistencyProofV1({
        oldTreeSize: 1,
        newTreeSize: 2,
        oldRoot: firstHash,
        newRoot: root,
        proof: ["f".repeat(64)],
      }),
    ).toBe(false);
    expect(
      verifyInclusionProofV1({
        leafBytes: first,
        leafIndex: 0,
        treeSize: 2,
        auditPath: ["f".repeat(64)],
        expectedRoot: root,
      }),
    ).toBe(false);
  });

  it("verifies recursively generated RFC6962 proofs across unbalanced trees", () => {
    const leaves = Array.from({ length: 16 }, (_, index) =>
      Buffer.from(`leaf-${String(index)}`, "utf8"),
    );
    for (let treeSize = 1; treeSize <= leaves.length; treeSize += 1) {
      const current = leaves.slice(0, treeSize);
      const root = treeRoot(current);
      for (let leafIndex = 0; leafIndex < treeSize; leafIndex += 1) {
        expect(
          verifyInclusionProofV1({
            leafBytes: current[leafIndex]!,
            leafIndex,
            treeSize,
            auditPath: inclusionPath(leafIndex, current),
            expectedRoot: root,
          }),
        ).toBe(true);
      }
      for (let oldSize = 1; oldSize <= treeSize; oldSize += 1) {
        expect(
          verifyConsistencyProofV1({
            oldTreeSize: oldSize,
            newTreeSize: treeSize,
            oldRoot: treeRoot(current.slice(0, oldSize)),
            newRoot: root,
            proof: consistencyPath(oldSize, current),
          }),
        ).toBe(true);
      }
    }
  });
});
