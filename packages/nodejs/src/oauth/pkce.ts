export class PKCE {
  readonly method = "S256";

  private constructor(
    readonly verifier: string,
    readonly challenge: string,
  ) { }

  static async create(): Promise<PKCE> {
    const verifier = PKCE.generateVerifier();
    const challenge = await PKCE.computeChallenge(verifier);
    return new PKCE(verifier, challenge);
  }

  private static generateVerifier(): string {
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    return PKCE.base64url(bytes);
  }

  private static async computeChallenge(verifier: string): Promise<string> {
    const encoded = new TextEncoder().encode(verifier);
    const digest = await globalThis.crypto.subtle.digest("SHA-256", encoded);

    return PKCE.base64url(new Uint8Array(digest));
  }

  private static base64url(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
  }
}
