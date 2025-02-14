export class GitHubUser {
  id: number;
  // lazily populated on every sync, no caching, these may change:
  login: string;
  teamIds: number[];

  constructor(id: number) {
    this.id = id;
  }
}
