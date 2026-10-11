// Minimal GitHub Issues client: incidents are issues labelled "incident".

export interface GitHub {
  open(title: string, body: string, labels: string[]): Promise<number>;
  comment(issue: number, body: string): Promise<void>;
  close(issue: number, body: string): Promise<void>;
}

export function github(repo: string, token: string): GitHub {
  const api = `https://api.github.com/repos/${repo}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "gridpulse-worker",
    "Content-Type": "application/json",
  };

  async function call(method: string, path: string, body: unknown): Promise<any> {
    const res = await fetch(`${api}${path}`, { method, headers, body: JSON.stringify(body) });
    if (!res.ok) {
      throw new Error(`GitHub ${method} ${path} failed: ${res.status} ${await res.text()}`);
    }
    return res.json();
  }

  return {
    async open(title, body, labels) {
      const issue = await call("POST", "/issues", { title, body, labels });
      return issue.number as number;
    },
    async comment(issue, body) {
      await call("POST", `/issues/${issue}/comments`, { body });
    },
    async close(issue, body) {
      await call("POST", `/issues/${issue}/comments`, { body });
      await call("PATCH", `/issues/${issue}`, { state: "closed", state_reason: "completed" });
    },
  };
}
