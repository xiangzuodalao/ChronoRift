import {
  createHash,
  createPrivateKey,
  createPublicKey,
  KeyObject,
  sign,
  verify,
} from "node:crypto";

import {
  asSha256DigestV1,
  type JsonValue,
  type Sha256DigestV1,
} from "@chronorift/domain";
import { canonicalJson } from "@chronorift/json-artifacts";

const SHA256_HEX = /^[a-f0-9]{64}$/u;

export type E3JsonSigningKeyV1 = KeyObject | string | Buffer;

const asPublicKeyV1 = (key: E3JsonSigningKeyV1): KeyObject =>
  key instanceof KeyObject && key.type === "public"
    ? key
    : createPublicKey(key);

const asPrivateKeyV1 = (key: E3JsonSigningKeyV1): KeyObject =>
  key instanceof KeyObject ? key : createPrivateKey(key);

export const canonicalBytesV1 = (value: JsonValue): Buffer =>
  Buffer.from(canonicalJson(value), "utf8");

export const sha256HexV1 = (value: Uint8Array | string): Sha256DigestV1 =>
  asSha256DigestV1(createHash("sha256").update(value).digest("hex"));

export const canonicalContentHashV1 = (value: JsonValue): Sha256DigestV1 =>
  sha256HexV1(canonicalBytesV1(value));

export const artifactSinkCommitmentV1 = (input: {
  readonly namespace: string;
  readonly leaseId: string;
  readonly artifactSinkId: string;
  readonly canonicalAbsolutePath: string;
  readonly evidenceFileName: string;
}): Sha256DigestV1 =>
  sha256HexV1(
    Buffer.concat([
      Buffer.from("chronorift-e3-artifact-sink-v1\0", "utf8"),
      canonicalBytesV1({
        namespace: input.namespace,
        leaseId: input.leaseId,
        artifactSinkId: input.artifactSinkId,
        canonicalAbsolutePath: input.canonicalAbsolutePath,
        evidenceFileName: input.evidenceFileName,
      }),
    ]),
  );

const domainHashV1 = (
  domain: string,
  fields: readonly string[],
): Sha256DigestV1 => {
  const hash = createHash("sha256").update(domain).update("\0");
  for (const field of fields) hash.update(field).update("\0");
  return asSha256DigestV1(hash.digest("hex"));
};

export const campaignIdV1 = (manifest: JsonValue): Sha256DigestV1 =>
  sha256HexV1(
    Buffer.concat([
      Buffer.from("chronorift-e3-campaign-id-v1\0", "utf8"),
      canonicalBytesV1(manifest),
    ]),
  );

export const assignmentIdV1 = (input: {
  readonly campaignId: string;
  readonly slotOrdinal: number;
  readonly assignmentCommitment: string;
}): Sha256DigestV1 =>
  domainHashV1("chronorift-e3-assignment-id-v1", [
    input.campaignId,
    String(input.slotOrdinal),
    input.assignmentCommitment,
  ]);

export const eventIdV1 = (input: {
  readonly campaignId: string;
  readonly assignmentId: string;
  readonly ordinal: number;
  readonly previousHash: string;
  readonly eventKind: string;
  readonly payloadHash: string;
}): Sha256DigestV1 =>
  domainHashV1("chronorift-e3-event-id-v1", [
    input.campaignId,
    input.assignmentId,
    String(input.ordinal),
    input.previousHash,
    input.eventKind,
    input.payloadHash,
  ]);

export const revisionIdV1 = (input: {
  readonly campaignId: string;
  readonly primaryClosureHash: string;
  readonly revisionOrdinal: number;
  readonly previousRevisionHash: string | null;
  readonly lateEventId: string;
}): Sha256DigestV1 =>
  domainHashV1("chronorift-e3-revision-id-v1", [
    input.campaignId,
    input.primaryClosureHash,
    String(input.revisionOrdinal),
    input.previousRevisionHash ?? "",
    input.lateEventId,
  ]);

export const signedBytesV1 = (input: {
  readonly domain: string;
  readonly schemaId: string;
  readonly version: number;
  readonly value: JsonValue;
}): Buffer =>
  Buffer.concat([
    Buffer.from(
      `${input.domain}\0${input.schemaId}\0${String(input.version)}\0`,
      "utf8",
    ),
    canonicalBytesV1(input.value),
  ]);

export const ed25519KeyIdV1 = (key: E3JsonSigningKeyV1): Sha256DigestV1 => {
  const publicKey = asPublicKeyV1(key);
  const bytes = publicKey.export({ type: "spki", format: "der" });
  return sha256HexV1(bytes);
};

export const signCanonicalJsonV1 = (input: {
  readonly privateKey: E3JsonSigningKeyV1;
  readonly domain: string;
  readonly schemaId: string;
  readonly version: number;
  readonly value: JsonValue;
}): string =>
  sign(null, signedBytesV1(input), asPrivateKeyV1(input.privateKey)).toString(
    "base64url",
  );

export const verifyCanonicalJsonSignatureV1 = (input: {
  readonly publicKey: E3JsonSigningKeyV1;
  readonly domain: string;
  readonly schemaId: string;
  readonly version: number;
  readonly value: JsonValue;
  readonly signature: string;
}): boolean => {
  let signature: Buffer;
  try {
    signature = Buffer.from(input.signature, "base64url");
  } catch {
    return false;
  }
  if (
    signature.length !== 64 ||
    input.signature !== signature.toString("base64url")
  ) {
    return false;
  }
  try {
    return verify(
      null,
      signedBytesV1(input),
      asPublicKeyV1(input.publicKey),
      signature,
    );
  } catch {
    return false;
  }
};

const digestBytesV1 = (digest: string): Buffer => {
  if (!SHA256_HEX.test(digest)) throw new Error("invalid SHA-256 digest");
  return Buffer.from(digest, "hex");
};

export const merkleLeafHashV1 = (leaf: Uint8Array): Sha256DigestV1 =>
  sha256HexV1(Buffer.concat([Buffer.from([0]), Buffer.from(leaf)]));

export const merkleNodeHashV1 = (left: string, right: string): Sha256DigestV1 =>
  sha256HexV1(
    Buffer.concat([
      Buffer.from([1]),
      digestBytesV1(left),
      digestBytesV1(right),
    ]),
  );

export const campaignRegistrationLeafBytesV1 = (input: {
  readonly campaignId: string;
  readonly deadline: string;
}): Buffer =>
  canonicalBytesV1({
    campaignId: input.campaignId,
    deadline: input.deadline,
  });

export const closurePublicationLeafBytesV1 = (input: {
  readonly campaignId: string;
  readonly closureHash: string;
}): Buffer =>
  canonicalBytesV1({
    campaignId: input.campaignId,
    closureHash: input.closureHash,
  });

export const verifyInclusionProofV1 = (input: {
  readonly leafBytes: Uint8Array;
  readonly leafIndex: number;
  readonly treeSize: number;
  readonly auditPath: readonly string[];
  readonly expectedRoot: string;
}): boolean => {
  if (
    !Number.isSafeInteger(input.leafIndex) ||
    !Number.isSafeInteger(input.treeSize) ||
    input.leafIndex < 0 ||
    input.treeSize <= input.leafIndex ||
    !SHA256_HEX.test(input.expectedRoot)
  ) {
    return false;
  }
  try {
    let node = merkleLeafHashV1(input.leafBytes);
    let leaf = input.leafIndex;
    let last = input.treeSize - 1;
    for (const sibling of input.auditPath) {
      digestBytesV1(sibling);
      if ((leaf & 1) === 1 || leaf === last) {
        node = merkleNodeHashV1(sibling, node);
        while ((leaf & 1) === 0 && leaf !== 0) {
          leaf >>= 1;
          last >>= 1;
        }
      } else {
        node = merkleNodeHashV1(node, sibling);
      }
      leaf >>= 1;
      last >>= 1;
    }
    return last === 0 && node === input.expectedRoot;
  } catch {
    return false;
  }
};

export const verifyConsistencyProofV1 = (input: {
  readonly oldTreeSize: number;
  readonly newTreeSize: number;
  readonly oldRoot: string;
  readonly newRoot: string;
  readonly proof: readonly string[];
}): boolean => {
  const { oldTreeSize, newTreeSize } = input;
  if (
    !Number.isSafeInteger(oldTreeSize) ||
    !Number.isSafeInteger(newTreeSize) ||
    oldTreeSize <= 0 ||
    newTreeSize < oldTreeSize ||
    !SHA256_HEX.test(input.oldRoot) ||
    !SHA256_HEX.test(input.newRoot)
  ) {
    return false;
  }
  if (oldTreeSize === newTreeSize) {
    return input.proof.length === 0 && input.oldRoot === input.newRoot;
  }
  try {
    let first = oldTreeSize - 1;
    let second = newTreeSize - 1;
    while ((first & 1) === 1) {
      first >>= 1;
      second >>= 1;
    }
    let offset = 0;
    let oldHash: string;
    let newHash: string;
    if (first === 0) {
      oldHash = input.oldRoot;
      newHash = input.oldRoot;
    } else {
      const initial = input.proof[offset++];
      if (initial === undefined) return false;
      digestBytesV1(initial);
      oldHash = initial;
      newHash = initial;
    }
    while (offset < input.proof.length) {
      if (second === 0) return false;
      const sibling = input.proof[offset++]!;
      digestBytesV1(sibling);
      if ((first & 1) === 1 || first === second) {
        oldHash = merkleNodeHashV1(sibling, oldHash);
        newHash = merkleNodeHashV1(sibling, newHash);
        while ((first & 1) === 0 && first !== 0) {
          first >>= 1;
          second >>= 1;
        }
      } else {
        newHash = merkleNodeHashV1(newHash, sibling);
      }
      first >>= 1;
      second >>= 1;
    }
    return (
      second === 0 && oldHash === input.oldRoot && newHash === input.newRoot
    );
  } catch {
    return false;
  }
};
