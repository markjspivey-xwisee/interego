import { isChatGPTApp } from "./chatgpt-host.js";

// Host access never stands in for a verified Interego identity or a pod save.
// Keep the ordinary site/artifact wording unchanged outside the ChatGPT App.
const site = {
  usage: "Sign in to claude.ai to add notes and usage.",
  review: "Sign in to claude.ai to vote. You can read the queue and the team's votes.",
  activity: "Sign in to claude.ai to see and add your team's votes, notes and usage.",
  vote: "Connect Interego to vote.",
  reviewUnavailable: "Connect an admitted account and verify shared pod data.",
  home: "Sign in to vote.",
  packs: "Saved in this browser; sign in to keep them with your account.",
};
const chatgpt = {
  usage: "Shared notes and usage are unavailable in this ChatGPT App. They require a separately verified Interego connection.",
  review: "Review is read-only in this ChatGPT App. Voting requires a separately verified Interego connection.",
  activity: "Shared team votes, notes and usage are unavailable in this ChatGPT App. They require a separately verified Interego connection.",
  vote: "Team voting is unavailable in this ChatGPT App. It requires a separately verified Interego connection.",
  reviewUnavailable: "Team review is unavailable in this ChatGPT App; it requires a separately verified Interego connection.",
  home: "Team voting is unavailable in this ChatGPT App.",
  packs: "Packs are kept in this browser when storage is available. This ChatGPT App does not save them to an Interego pod.",
};
export function identityCopy(kind) {
  return (isChatGPTApp() ? chatgpt : site)[kind];
}
