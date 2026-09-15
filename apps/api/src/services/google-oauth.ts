import { createHash, randomBytes } from "node:crypto";

const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v3/userinfo";

const SCOPES = "openid email profile";

export type PkcePair = Readonly<{ codeVerifier: string; codeChallenge: string }>;

/** I6: crypto.randomBytes, never Math.random — this is the entire defense PKCE adds
 * against an authorization code stolen in transit or replayed by another party. */
export function generatePkcePair(): PkcePair {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

export function generateState(): string {
  return randomBytes(32).toString("base64url");
}

export function buildGoogleAuthorizationUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(AUTHORIZATION_ENDPOINT);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export type GoogleUserinfo = Readonly<{
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
}>;

export type GoogleTokenExchange = (params: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
}) => Promise<GoogleUserinfo>;

/**
 * R13.7: server-side exchange — the client secret is a POST body field here, never
 * anything the browser sees (it only ever holds `code` and `state`, both single-use).
 *
 * Identity comes from exactly one source: a GET to Google's userinfo endpoint,
 * authenticated with the `access_token` this function just received. The token
 * response's `id_token` field is not read anywhere in this file — not decoded, not
 * verified, discarded along with the rest of the response body. So there is no
 * `aud`/`iss`/`exp` check to perform, and no JWT library to add for one, because there
 * is no JWT being trusted in the first place.
 *
 * This is safe specifically *because* of how the access_token was obtained, not
 * despite skipping a check: Google only minted it in response to this POST, which
 * only succeeds with our client_secret and the `code`/`code_verifier` pair from the
 * PKCE exchange this same request is completing. Nothing else could have caused
 * Google to mint this token, and nothing else has presented it to us — there's no
 * "token issued for a different client" to confuse it with, because no token arrives
 * from anywhere but this call. The aud-confusion attack a JWT audience check defends
 * against requires accepting a token *handed to you* by a less-trusted party (a
 * browser, a mobile client, another service); this function never does that.
 *
 * ponytail: that assumption is the ceiling. If this code path ever changes to accept
 * an id_token or access_token from anywhere other than the response to this exact
 * POST — e.g. a client-side Google Sign-In button handing a token to the browser,
 * which hands it to this API — this reasoning stops holding and real JWT
 * verification (fetch Google's JWKS, check the RS256 signature, aud, iss, exp) is no
 * longer optional.
 */
export async function exchangeGoogleCode(params: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
}): Promise<GoogleUserinfo> {
  const tokenRes = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: params.code,
      client_id: params.clientId,
      client_secret: params.clientSecret,
      redirect_uri: params.redirectUri,
      grant_type: "authorization_code",
      code_verifier: params.codeVerifier,
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`Google token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
  }
  const tokenBody: unknown = await tokenRes.json();
  const accessToken =
    typeof tokenBody === "object" && tokenBody !== null && "access_token" in tokenBody
      ? tokenBody.access_token
      : undefined;
  if (typeof accessToken !== "string") {
    throw new Error("Google token exchange response had no access_token");
  }

  const userinfoRes = await fetch(USERINFO_ENDPOINT, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!userinfoRes.ok) {
    throw new Error(`Google userinfo fetch failed: ${userinfoRes.status}`);
  }
  const userinfo: unknown = await userinfoRes.json();
  if (
    typeof userinfo !== "object" ||
    userinfo === null ||
    !("sub" in userinfo) ||
    !("email" in userinfo) ||
    typeof userinfo.sub !== "string" ||
    typeof userinfo.email !== "string"
  ) {
    throw new Error("Google userinfo response missing sub/email");
  }

  return {
    sub: userinfo.sub,
    email: userinfo.email,
    emailVerified: "email_verified" in userinfo ? Boolean(userinfo.email_verified) : false,
    name: "name" in userinfo && typeof userinfo.name === "string" ? userinfo.name : undefined,
  };
}
