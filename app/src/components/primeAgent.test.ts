import { expect, it } from "vitest";
import { PRIME_AGENT_URL } from "./primeAgent";

it("keeps the Prime agent install URL available without loading settings", () => {
  expect(PRIME_AGENT_URL).toBe("https://github.com/PrimeIntellect-ai/prime-agent");
});
