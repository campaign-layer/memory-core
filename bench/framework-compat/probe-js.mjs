#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  attestInstalledPackageVersion,
  emit,
  exerciseFramework,
  fail,
  repoRoot,
  serverEnv,
  serverPath,
} from "./probe-lib.mjs";

const framework = process.argv[2];
if (!framework || !["generic-mcp", "langchain", "langgraph", "openai-agents"].includes(framework)) {
  throw new Error("usage: node probe-js.mjs generic-mcp|langchain|langgraph|openai-agents");
}

function versionLabel(attestation) {
  return `${attestation.package}@${attestation.actual}`;
}

async function withCleanup(run, cleanup) {
  let primaryError;
  try {
    return await run();
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await cleanup();
    } catch (cleanupError) {
      if (!primaryError) throw cleanupError;
    }
  }
}

async function genericProbe() {
  const versionAttestation = [await attestInstalledPackageVersion(
    "@modelcontextprotocol/sdk",
    "MC_EXPECTED_MCP_SDK_VERSION",
  )];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: repoRoot,
    env: serverEnv(framework),
    stderr: "pipe",
  });
  const client = new Client({ name: "framework-compat", version: "1.0.0" });
  return withCleanup(async () => {
    await client.connect(transport);
    const listed = await client.listTools();
    return await exerciseFramework({
      framework,
      version: versionLabel(versionAttestation[0]),
      versionAttestation,
      toolNames: listed.tools.map((tool) => tool.name),
      call: (name, args) => client.callTool({ name, arguments: args }),
    });
  }, () => client.close());
}

async function langChainProbe() {
  const versionAttestation = [await attestInstalledPackageVersion(
    "@langchain/mcp-adapters",
    "MC_EXPECTED_LANGCHAIN_MCP_VERSION",
  )];
  const { MultiServerMCPClient } = await import("@langchain/mcp-adapters");
  const client = new MultiServerMCPClient({
    mcpServers: {
      memory: {
        transport: "stdio",
        command: process.execPath,
        args: [serverPath],
        cwd: repoRoot,
        env: serverEnv(framework),
      },
    },
    throwOnLoadError: true,
    prefixToolNameWithServerName: false,
    onConnectionError: "throw",
    defaultToolTimeout: 15_000,
  });
  return withCleanup(async () => {
    const tools = await client.getTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    return await exerciseFramework({
      framework,
      version: versionLabel(versionAttestation[0]),
      versionAttestation,
      toolNames: [...byName.keys()],
      call: async (name, args) => {
        const tool = byName.get(name);
        if (!tool) throw new Error(`LangChain did not expose ${name}`);
        return tool.invoke(args);
      },
    });
  }, async () => { await client.close?.(); });
}

async function langGraphProbe() {
  const versionAttestation = await Promise.all([
    attestInstalledPackageVersion("@langchain/langgraph", "MC_EXPECTED_LANGGRAPH_VERSION"),
    attestInstalledPackageVersion("@langchain/mcp-adapters", "MC_EXPECTED_LANGCHAIN_MCP_VERSION"),
  ]);
  const [{ MultiServerMCPClient }, { Annotation, END, START, StateGraph }] = await Promise.all([
    import("@langchain/mcp-adapters"),
    import("@langchain/langgraph"),
  ]);
  const client = new MultiServerMCPClient({
    mcpServers: {
      memory: {
        transport: "stdio",
        command: process.execPath,
        args: [serverPath],
        cwd: repoRoot,
        env: serverEnv(framework),
      },
    },
    throwOnLoadError: true,
    prefixToolNameWithServerName: false,
    onConnectionError: "throw",
    defaultToolTimeout: 15_000,
  });
  return withCleanup(async () => {
    const tools = await client.getTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const GraphState = Annotation.Root({
      args: Annotation(),
      result: Annotation(),
    });
    return await exerciseFramework({
      framework,
      version: versionLabel(versionAttestation[0]),
      versionAttestation,
      toolNames: [...byName.keys()],
      call: async (name, args) => {
        const tool = byName.get(name);
        if (!tool) throw new Error(`LangGraph did not expose ${name}`);
        const graph = new StateGraph(GraphState)
          .addNode("memoryTool", async (state) => ({ result: await tool.invoke(state.args) }))
          .addEdge(START, "memoryTool")
          .addEdge("memoryTool", END)
          .compile();
        return (await graph.invoke({ args })).result;
      },
    });
  }, async () => { await client.close?.(); });
}

async function openAiProbe() {
  const versionAttestation = [await attestInstalledPackageVersion(
    "@openai/agents",
    "MC_EXPECTED_OPENAI_AGENTS_VERSION",
  )];
  const { MCPServerStdio } = await import("@openai/agents");
  const server = new MCPServerStdio({
    name: "memory-core",
    command: process.execPath,
    args: [serverPath],
    cwd: repoRoot,
    env: serverEnv(framework),
    cacheToolsList: true,
  });
  return withCleanup(async () => {
    await server.connect();
    const tools = await server.listTools();
    return await exerciseFramework({
      framework,
      version: versionLabel(versionAttestation[0]),
      versionAttestation,
      toolNames: tools.map((tool) => tool.name),
      call: (name, args) => server.callToolResult(name, args),
    });
  }, () => server.close());
}

try {
  const result = framework === "generic-mcp"
    ? await genericProbe()
    : framework === "langchain"
      ? await langChainProbe()
      : framework === "langgraph"
        ? await langGraphProbe()
      : await openAiProbe();
  emit(result);
} catch (error) {
  fail(framework, error);
}
