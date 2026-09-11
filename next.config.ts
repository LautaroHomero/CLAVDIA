import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  // Pin the workspace root (silences the lockfile-detection warning).
  turbopack: { root: import.meta.dirname },
  // The agent's behaviour lives in plain-text files the server reads at runtime
  // with `fs`. Make sure Next traces them into the serverless bundle.
  outputFileTracingIncludes: {
    "/**": ["./src/lib/agent/instructions.md", "./src/lib/agent/roles/*.md"],
  },
};

export default withWorkflow(nextConfig);
