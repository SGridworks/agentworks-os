export function defaultAgentWorksBaseUrl(): string {
  return (
    process.env.AGENTWORKS_API_URL ||
    process.env.AGENTOS_API_URL ||
    "http://host.docker.internal:7710"
  );
}
