import { CopilotTokenManager } from "./adapters/copilot-token.js";
import { buildApp } from "./app.js";
import { GithubOAuthTokenManager } from "./auth/github-token.js";
import { loadConfigFile } from "./config.js";

const config = loadConfigFile();

try {
  const githubTokenProvider = new GithubOAuthTokenManager(config);
  const tokenProvider = new CopilotTokenManager(config, githubTokenProvider);
  await tokenProvider.getToken();

  const app = await buildApp({ config, tokenProvider, githubTokenProvider });
  await app.listen({
    host: config.host,
    port: config.port
  });
} catch (error) {
  console.error(error);
  process.exit(1);
}
