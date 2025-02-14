import type { GitHubAppAuthenticationWithExpiration } from "@octokit/auth-oauth-device";

export async function initiateGitHubAuth(): Promise<{ token: string }> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: "authenticate" }, (response) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }

      if (response && response.token) {
        storeAuthentication({
          type: "token",
          tokenType: "oauth",
          token: response.token,
          expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
          refreshToken: "",
          clientType: "github-app",
          clientId: "Iv23liIGYvmR015csDAR",
          refreshTokenExpiresAt: null,
        }).then(() => resolve({ token: response.token }));
      } else {
        reject(new Error(response?.error || "Authentication failed"));
      }
    });
  });
}

export async function storeAuthentication(
  auth: GitHubAppAuthenticationWithExpiration,
) {
  await chrome.storage.sync.set({ auth: auth });
}

export async function getStoredToken(): Promise<string | null> {
  const storedAuth = await chrome.storage.sync.get("auth");
  if (!storedAuth || !storedAuth.auth) return null;

  // Check if token is expired (8 hour expiry)
  const expiresAt = new Date(storedAuth.auth.expiresAt).getTime();
  if (Date.now() > expiresAt) {
    return null; // Token expired, user needs to re-authenticate
  }

  return storedAuth.auth.token;
}
