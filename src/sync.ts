import { Octokit } from "@octokit/rest";
import {
  gitHubCallsCounter,
  resetGitHubCallsCounter,
  syncGitHubRepo,
  listRepoActivity,
  getGitHubUser,
} from "./github";
import { CommentBlock, MyPrBlock, ReviewRequestBlock } from "./block";
import { Repo } from "./repo";
import { ReposState } from "./reposState";
import { RepoState } from "./repoState";
import { getStoredToken } from "./auth";
import {
  getCommentBlockList,
  getMyPrBlockList,
  getReviewRequestBlockList,
  getRepos,
  getRepoStateByFullName,
  getSettings,
  storeCommentBlockList,
  storeLastSyncDurationMillis,
  storeMyPrBlockList,
  storeReviewRequestBlockList,
  storeRepoStateMap,
} from "./storage";

export let octokit: Octokit;

export async function trySync() {
  try {
    const token = await getStoredToken();
    if (!token) {
      console.error("No valid authentication token. Sync failed");
      return;
    }
    return trySyncWithCredentials();
  } catch (e) {
    console.error("Sync failed", e);
  }
}

let syncInProgress = false;

export async function trySyncWithCredentials() {
  const token = await getStoredToken();
  if (!token) {
    // set icon to grey to indicate that the token is not valid
    chrome.action.setIcon({
      path: "icons/grey128.png",
    });
    return;
  }

  octokit = new Octokit({
    auth: token,
  });

  if (syncInProgress) {
    console.info("Another sync in progress. Skipping.");
    return;
  }
  console.info("Starting sync...");
  syncInProgress = true;
  try {
    await sync();
  } finally {
    syncInProgress = false;
  }
}

/**
 * Note: no concurrent calls!
 */
export async function sync() {
  const prBlocksAtSyncStart = await getMyPrBlockList();
  const reviewRequestBlocksAtSyncStart = await getReviewRequestBlockList();
  const commentBlocksAtSyncStart = await getCommentBlockList();

  resetGitHubCallsCounter();
  const syncStartUnixMillis = Date.now();
  const settings = await getSettings();
  const allReposIncludingDisabled = await getRepos();
  const repos = allReposIncludingDisabled.filter((v) => v.monitoringEnabled);
  const prevRepoStateByFullName = await getRepoStateByFullName();
  const repoStateByFullNameBuilder = new Map<string, RepoState>();

  const myGitHubUser = await getGitHubUser();

  // It's probably better to do these GitHub requests in a sequential manner so that GitHub is not
  // tempted to block them even if user monitors many repos:
  for (const repo of repos) {
    let repoStateBuilder = prevRepoStateByFullName.get(repo.fullName());
    if (!repoStateBuilder) {
      repoStateBuilder = new RepoState(repo.fullName());
    }
    repoStateByFullNameBuilder.set(repo.fullName(), repoStateBuilder);

    const activities = await listRepoActivity(
      repo.owner,
      repo.name,
      settings.getMinCommentCreateDate(),
      myGitHubUser,
    );

    await syncGitHubRepo(
      repoStateBuilder,
      activities || [],
      myGitHubUser,
      settings,
    );
  }
  const reposState = new ReposState(repoStateByFullNameBuilder);

  // Update in background:
  storeRepoStateMap(repoStateByFullNameBuilder);

  const prBlocksNow = await getMyPrBlockList();
  if (prBlocksNow.length === prBlocksAtSyncStart.length) {
    const monitoringDisabledRepos = allReposIncludingDisabled.filter(
      (v) => !v.monitoringEnabled,
    );
    // In background:
    maybeCleanUpObsoletePrBlocks(
      reposState.asArray(),
      prBlocksNow,
      monitoringDisabledRepos,
    );
  }

  const reviewRequestBlocksNow = await getReviewRequestBlockList();
  if (reviewRequestBlocksNow.length === reviewRequestBlocksAtSyncStart.length) {
    const monitoringDisabledRepos = allReposIncludingDisabled.filter(
      (v) => !v.monitoringEnabled,
    );
    // In background:
    maybeCleanUpObsoleteReviewRequestBlocks(
      reposState.asArray(),
      reviewRequestBlocksNow,
      monitoringDisabledRepos,
    );
  }

  const commentBlocksNow = await getCommentBlockList();
  if (commentBlocksNow.length === commentBlocksAtSyncStart.length) {
    const monitoringDisabledRepos = allReposIncludingDisabled.filter(
      (v) => !v.monitoringEnabled,
    );
    // In background:
    maybeCleanUpObsoleteCommentBlocks(
      reposState.asArray(),
      commentBlocksNow,
      monitoringDisabledRepos,
    );
  }

  storeLastSyncDurationMillis(Date.now() - syncStartUnixMillis);
  console.log(gitHubCallsCounter + " GitHub API calls in the last sync.");

  await reposState.updateIcon();

  console.info("Sync finished.");
}

async function maybeCleanUpObsoletePrBlocks(
  repoStates: RepoState[],
  myPrBlocksFromStorage: MyPrBlock[],
  monitoringDisabledRepos: Repo[],
) {
  if (Math.random() > 0.01) {
    return;
  }

  if (repoStates.some((r) => r.lastSyncResult.errorMsg)) {
    return;
  }

  const activeBlocksBuilder = new Set<MyPrBlock>();
  for (const repoState of repoStates) {
    for (const myPR of repoState.lastSyncResult.myPRs) {
      myPrBlocksFromStorage
        .filter((block) => myPR.isBlockedBy(block))
        .forEach((block) => activeBlocksBuilder.add(block));
    }
  }

  // Preserve blocks in case monitoring for a repo is temporary disabled and then re-enabled:
  for (const repo of monitoringDisabledRepos) {
    myPrBlocksFromStorage
      // #NOT_MATURE: yes there's a low chance of false positives but that's okay:
      .filter((v) => v.prUrl.includes(repo.fullName()))
      .forEach((v) => activeBlocksBuilder.add(v));
  }

  if (myPrBlocksFromStorage.length != activeBlocksBuilder.size) {
    return storeMyPrBlockList([...activeBlocksBuilder]);
  }
}

async function maybeCleanUpObsoleteReviewRequestBlocks(
  repoStates: RepoState[],
  reviewRequestBlocks: ReviewRequestBlock[],
  monitoringDisabledRepos: Repo[],
) {
  if (Math.random() > 0.01) {
    return;
  }

  if (repoStates.some((r) => r.lastSyncResult.errorMsg)) {
    return;
  }

  const activeBlocksBuilder = new Set<ReviewRequestBlock>();
  for (const repoState of repoStates) {
    for (const reviewRequest of repoState.lastSyncResult.requestsForMyReview) {
      reviewRequestBlocks
        .filter((block) => reviewRequest.isBlockedBy(block))
        .forEach((block) => activeBlocksBuilder.add(block));
    }
  }

  // Preserve blocks in case monitoring for a repo is temporary disabled and then re-enabled:
  for (const repo of monitoringDisabledRepos) {
    reviewRequestBlocks
      // #NOT_MATURE: yes there's a low chance of false positives but that's okay:
      .filter((v) => v.prUrl.includes(repo.fullName()))
      .forEach((v) => activeBlocksBuilder.add(v));
  }

  if (reviewRequestBlocks.length != activeBlocksBuilder.size) {
    return storeReviewRequestBlockList([...activeBlocksBuilder]);
  }
}

async function maybeCleanUpObsoleteCommentBlocks(
  repoStates: RepoState[],
  commentBlocksFromStorage: CommentBlock[],
  monitoringDisabledRepos: Repo[],
) {
  if (Math.random() > 0.01) {
    return;
  }

  if (repoStates.some((r) => r.lastSyncResult.errorMsg)) {
    return;
  }

  const activeBlocksBuilder = new Set<CommentBlock>();
  for (const repoState of repoStates) {
    for (const comment of repoState.lastSyncResult.comments) {
      // #NOT_MATURE: if user increases max comment age in settings a comment would be resurrected,
      // but probably that's okay:
      commentBlocksFromStorage
        .filter((block) => comment.isBlockedBy(block))
        .forEach((block) => activeBlocksBuilder.add(block));
    }
  }

  // Preserve blocks in case monitoring for a repo is temporary disabled and then re-enabled:
  for (const repo of monitoringDisabledRepos) {
    commentBlocksFromStorage
      // #NOT_MATURE: yes there's a low chance of false positives but that's okay:
      .filter((v) => v.commentUrl.includes(repo.fullName()))
      .forEach((v) => activeBlocksBuilder.add(v));
  }

  if (commentBlocksFromStorage.length != activeBlocksBuilder.size) {
    return storeCommentBlockList([...activeBlocksBuilder]);
  }
}
