import type { AuthInteraction, AuthType, Models } from "@earendil-works/pi-ai";
import { AuthError, authenticationRequired } from "./errors";

export interface AuthStatus {
  providerId: string;
  authenticated: boolean;
  type?: AuthType;
  source?: string;
}
export interface AuthLoginResult {
  providerId: string;
  authenticated: true;
  type: AuthType;
}
export interface AuthLogoutResult {
  providerId: string;
  authenticated: false;
}

export async function getAuthStatus(models: Models, providerId: string): Promise<AuthStatus> {
  if (models.getProvider(providerId) === undefined) {
    throw new AuthError(
      "authentication_failed",
      providerId,
      `unknown authentication provider "${providerId}"`,
    );
  }
  const check = await models.checkAuth(providerId);
  return {
    providerId,
    authenticated: check !== undefined,
    ...(check?.type !== undefined && { type: check.type }),
    ...(check?.source !== undefined && { source: check.source }),
  };
}

export async function login(
  models: Models,
  providerId: string,
  type: AuthType,
  interaction: AuthInteraction,
): Promise<AuthLoginResult> {
  const provider = models.getProvider(providerId);
  if (provider === undefined)
    throw new AuthError(
      "authentication_failed",
      providerId,
      `unknown authentication provider "${providerId}"`,
    );
  await models.login(providerId, type, interaction);
  return { providerId, authenticated: true, type };
}

export async function logout(models: Models, providerId: string): Promise<AuthLogoutResult> {
  if (models.getProvider(providerId) === undefined)
    throw new AuthError(
      "authentication_failed",
      providerId,
      `unknown authentication provider "${providerId}"`,
    );
  await models.logout(providerId);
  return { providerId, authenticated: false };
}

export async function requireModelAuthentication(
  models: Models,
  providerId: string,
): Promise<void> {
  try {
    if ((await models.getAuth(providerId)) === undefined) throw authenticationRequired(providerId);
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw authenticationRequired(providerId, error);
  }
}
