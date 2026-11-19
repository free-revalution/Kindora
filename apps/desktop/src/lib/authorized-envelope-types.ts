/** Wire-shaped signed envelope returned from Rust `agent_sign_envelope`. */
export interface SignedEnvelopeParts {
  readonly protocol: string;
  readonly version: string;
  readonly messageId: string;
  readonly timestamp: string;
  readonly typeName: string;
  readonly sender: string;
  readonly recipient: string;
  readonly payload: unknown;
  readonly signature: {
    readonly alg: string;
    readonly signedFields: string;
    readonly keyId: string;
    readonly value: string;
  };
}