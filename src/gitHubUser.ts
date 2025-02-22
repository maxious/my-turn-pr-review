export class GitHubUser {
  id: number;
  login: string;
  teamIds: number[];

  constructor(id: number, login: string, teamIds: number[]) {
    this.id = id;
    this.login = login;
    this.teamIds = teamIds;
  }
}
