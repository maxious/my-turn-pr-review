import { getReposState, storeInstallationUnixMillis } from "./storage";
import { trySync } from "./sync";

const CLIENT_ID = "Iv23liIGYvmR015csDAR"; // read-only app for canva org
const BACKEND_URL =
  "https://rthasg7p6i5334navd7a3ynyxu0ipjmy.lambda-url.us-east-1.on.aws/";
const REDIRECT_URL = chrome.identity.getRedirectURL();

interface AuthResponse {
  token?: string;
  error?: string;
}

// Add auth message handler
chrome.runtime.onMessage.addListener(
  (message, _sender, sendResponse: (response: AuthResponse) => void) => {
    if (message.action === "authenticate") {
      handleAuth(sendResponse);
      return true;
    }
  },
);

async function handleAuth(sendResponse: (response: AuthResponse) => void) {
  try {
    const authURL = `https://github.com/login/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(
      REDIRECT_URL,
    )}&scope=repo`;

    chrome.identity.launchWebAuthFlow(
      {
        url: authURL,
        interactive: true,
      },
      async (responseUrl) => {
        try {
          // Extract code when github redirects users back to this extension
          const url = new URL(responseUrl);
          const code = url.searchParams.get("code");

          if (!code) {
            throw new Error("No authorization code received");
          }

          // Exchange user's authentication code for a token that can be used by that user to make GitHub API calls
          // https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#2-users-are-redirected-back-to-your-site-by-github
          const response = await fetch(`${BACKEND_URL}?code=${code}`);
          if (!response.ok) {
            throw new Error(`Backend error: ${response.status}`);
          }

          const data = await response.json();
          if (!data.token) {
            throw new Error("No token received from backend");
          }

          sendResponse({ token: data.token });
        } catch (error) {
          console.error("Auth error:", error);
          sendResponse({ error: error.message });
        }
      },
    );
  } catch (error) {
    console.error("Auth error:", error);
    sendResponse({ error: error.message });
  }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason == "install") {
    chrome.action.setIcon({
      path: "icons/grey128.png",
    });

    storeInstallationUnixMillis(new Date().getTime());

    console.log("Extension successfully installed!");
  } else {
    const reposState = await getReposState();
    if (reposState) {
      await reposState.updateIcon();
    }
  }
});

async function checkAlarmState() {
  const alarm = await chrome.alarms.get("sync-alarm");

  if (!alarm) {
    console.log("Alarm not found, creating...");
    await chrome.alarms.create("sync-alarm", { periodInMinutes: 0.5 });
  }

  const hasListeners = await chrome.alarms.onAlarm.hasListeners();
  if (!hasListeners) {
    console.log("Alarm listener not found, creating...");
    await chrome.alarms.onAlarm.addListener(() => {
      waitUntil(trySync());
    });
  }
}

// https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers#keep_a_service_worker_alive_until_a_long-running_operation_is_finished
async function waitUntil(promise: Promise<void>) {
  const keepAlive = setInterval(chrome.runtime.getPlatformInfo, 25 * 1000);
  try {
    await promise;
  } finally {
    clearInterval(keepAlive);
  }
}

checkAlarmState();
